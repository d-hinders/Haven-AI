/**
 * #825 Hybrid provisioning route. Pattern-matched DB mocks (#775); the
 * address derivation (network-touching) is mocked — its determinism is the
 * kit's contract, exercised offline by the salt characterization fixture and
 * on the real-DB harness by the repository tests (#4023).
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { expectMatchesSpec } from '../../openapi/response-shape.js'
import Fastify, { type FastifyInstance } from 'fastify'

const { mockQuery, mockCompute } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockCompute: vi.fn(),
}))
vi.mock('../../db.js', () => ({ default: { query: (...a: unknown[]) => mockQuery(...a) } }))
vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: async (request: { user?: unknown }) => {
    request.user = { sub: 'user-1' }
  },
}))
vi.mock('../../rails/hybrid-provisioning.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rails/hybrid-provisioning.js')>()
  return {
    ...actual,
    // The register route derives through the SALTED entry point (#4023).
    computeUserHybridAccountAddress: (...a: unknown[]) => mockCompute(...a),
  }
})

const hybridAccountRoutes = (await import('../hybrid-accounts.js')).default

const OWNER = '0x' + 'ab'.repeat(20)
const HYBRID = '0x' + 'cd'.repeat(20)
const SOURCE_ID = '5a2f8d31-6c04-4e97-b183-9e7d2c6a0f58'
/** Counter 1's salt: toHex(1) padded to 32 bytes (#4023 — 0 is never issued). */
const SALT_ONE = '0x' + '00'.repeat(31) + '01'

interface MockDbOpts {
  existing?: boolean
  count?: string
  /** Accounts the user already has ON THE REQUEST's chain (the #4023 cap). */
  chainCount?: string
  /** Whether the create-additional source row exists (default: found). */
  source?: 'found' | 'missing'
  /** The source account's stored signer set (default: one passkey). */
  sourcePasskeys?: Array<{ key_id: string; public_key_x: string; public_key_y: string }>
  /** Whether the create idempotency replay read finds a row. */
  replay?: { id: string; account_address: string; chain_id: number; created_at: string } | null
  /**
   * #4024 in-flight race: the replay PRE-check finds nothing, the INSERT
   * conflicts (writes nothing), and the conflict path's re-read by key finds
   * this committed winner.
   */
  raceWinner?: { id: string; account_address: string; chain_id: number; created_at: string }
  /** The signup shape runs no pre-check, so its FIRST key read is the conflict path's. */
  raceWinnerOnFirstRead?: boolean
}

function mockDb(opts: MockDbOpts = {}) {
  let keyReads = 0
  mockQuery.mockImplementation((sql: string) => {
    const s = String(sql)
    // #4023: the salt counter's atomic allocation. Default counter 1.
    if (/INSERT INTO hybrid_deploy_salt_counters/.test(s)) {
      return Promise.resolve({ rows: [{ last_allocated: '1' }] })
    }
    if (/WHERE id = \$1 AND user_id = \$2 AND account_type = 'delegator_hybrid'/.test(s)) {
      return Promise.resolve({ rows: opts.source === 'missing' ? [] : [{ id: SOURCE_ID }] })
    }
    if (/create_idempotency_key = \$2/.test(s)) {
      keyReads += 1
      if (opts.raceWinner) {
        const winnerVisible = opts.raceWinnerOnFirstRead || keyReads > 1
        return Promise.resolve({ rows: winnerVisible ? [opts.raceWinner] : [] })
      }
      return Promise.resolve({ rows: opts.replay ? [opts.replay] : [] })
    }
    if (/SELECT id FROM smart_accounts/.test(s)) {
      return Promise.resolve({ rows: opts.existing ? [{ id: 'acct-0' }] : [] })
    }
    // The source account's stored signer set (listAccountPasskeys).
    if (/FROM hybrid_account_passkeys/.test(s)) {
      return Promise.resolve({
        rows: opts.sourcePasskeys ?? [
          { key_id: 'cred-1', public_key_x: '0x' + '11'.repeat(32), public_key_y: '0x' + '22'.repeat(32) },
        ],
      })
    }
    // The per-chain count (cap) is more specific than the total count — match
    // it first.
    if (/COUNT\(\*\) AS count FROM smart_accounts WHERE user_id = \$1 AND chain_id = \$2/.test(s)) {
      return Promise.resolve({ rows: [{ count: opts.chainCount ?? '0' }] })
    }
    if (/COUNT\(\*\)/.test(s)) return Promise.resolve({ rows: [{ count: opts.count ?? '1' }] })
    if (/INSERT INTO smart_accounts/.test(s) && opts.raceWinner) {
      return Promise.resolve({ rows: [] }) // ON CONFLICT DO NOTHING
    }
    if (/INSERT INTO smart_accounts/.test(s)) {
      // smart_accounts.id is a UUID column, so 'acct-1' described a row the
      // database cannot produce (#1446).
      return Promise.resolve({ rows: [{ id: SOURCE_ID, created_at: '2026-07-10T00:00:00Z' }] })
    }
    return Promise.resolve({ rows: [] })
  })
}

describe('POST /accounts/hybrid (#825)', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(hybridAccountRoutes, { prefix: '/accounts' })
  })
  afterAll(async () => app.close())
  beforeEach(() => {
    mockQuery.mockReset()
    mockCompute.mockReset()
    mockCompute.mockResolvedValue(HYBRID)
  })

  it('provisions an EOA-owner account: counterfactual, no deployment', async () => {
    mockDb({})
    const res = await app.inject({
      method: 'POST', url: '/accounts/hybrid',
      payload: { owner_address: OWNER, name: 'Delegation account' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({
      account_address: HYBRID,
      account_type: 'delegator_hybrid',
      chain_id: 84532,
      deployed: false,
    })
    expectMatchesSpec('POST', '/accounts/hybrid', res.json(), '201')
    const insert = mockQuery.mock.calls.find((c) => /INSERT INTO smart_accounts/.test(String(c[0])))!
    expect(String(insert[0])).toContain("'delegator_hybrid'")
    expect(String(insert[0])).toContain("'delegation'")
  })

  it('provisions a pure-passkey account (P256 coords, no EOA)', async () => {
    mockDb({})
    const res = await app.inject({
      method: 'POST', url: '/accounts/hybrid',
      payload: { passkeys: [{ key_id: 'cred-1', x: '0x' + '11'.repeat(32), y: '0x' + '22'.repeat(32) }] },
    })
    expect(res.statusCode).toBe(201)
    expect(mockCompute).toHaveBeenCalledWith(84532, expect.objectContaining({
      passkeys: [expect.objectContaining({ keyId: 'cred-1' })],
      // #4023: the derivation carries the allocated counter salt.
      deploySalt: SALT_ONE,
    }))
    // #885: the passkey set is persisted so the config round-trips for deploy/revoke.
    const pkInsert = mockQuery.mock.calls.find((c) => /INSERT INTO hybrid_account_passkeys/.test(String(c[0])))!
    expect(pkInsert, 'passkey set must be persisted').toBeDefined()
    expect(pkInsert[1]).toEqual([SOURCE_ID, 'cred-1', '0x' + '11'.repeat(32), '0x' + '22'.repeat(32)])
  })

  it.each([
    ['no owner at all', {}],
    ['bad owner address', { owner_address: 'nope' }],
    ['passkey without coords', { passkeys: [{ key_id: 'k' }] }],
    // #3032 round-1 F2: the schema's `key_id` has no minLength, so emptiness
    // stays a handler check — an empty key_id was a 400 before the typeof
    // flip and must stay one.
    ['passkey with empty key_id', { passkeys: [{ key_id: '', x: '0x11', y: '0x22' }] }],
    // chain 1 is value-bearing, so the #908 signer floor runs first — two
    // signers pass it and reach the contract-availability check under test:
    ['unpinned chain', { owner_address: OWNER, chain_id: 1, passkeys: [{ key_id: '0xcc33', x: '0x5', y: '0x6' }] }],
  ])('rejects %s', async (_label, payload) => {
    mockDb({})
    const res = await app.inject({ method: 'POST', url: '/accounts/hybrid', payload })
    expect(res.statusCode).toBe(400)
  })

  it('409s a re-registration of the same account', async () => {
    mockDb({ existing: true })
    const res = await app.inject({
      method: 'POST', url: '/accounts/hybrid', payload: { owner_address: OWNER },
    })
    expect(res.statusCode).toBe(409)
  })

  it('first account becomes the default', async () => {
    mockDb({ count: '0' })
    await app.inject({ method: 'POST', url: '/accounts/hybrid', payload: { owner_address: OWNER } })
    const insert = mockQuery.mock.calls.find((c) => /INSERT INTO smart_accounts/.test(String(c[0])))!
    expect(insert[1][4]).toBe(true) // is_default
  })

  it('502s cleanly when derivation fails (never a half-registered row)', async () => {
    mockDb({})
    mockCompute.mockRejectedValueOnce(new Error('rpc down'))
    const res = await app.inject({
      method: 'POST', url: '/accounts/hybrid', payload: { owner_address: OWNER },
    })
    expect(res.statusCode).toBe(502)
    // #4023: the counter bump is inside the same transaction — nothing
    // committed, so no ACCOUNT row may exist either.
    expect(mockQuery.mock.calls.some((c) => /INSERT INTO smart_accounts/.test(String(c[0])))).toBe(false)
  })
})

describe('#908 mainnet signer floor (provisioning gate)', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(hybridAccountRoutes, { prefix: '/accounts' })
  })
  afterAll(async () => app.close())
  beforeEach(() => {
    mockQuery.mockReset()
    mockCompute.mockReset()
    mockCompute.mockResolvedValue(HYBRID)
  })

  const PASSKEY = { key_id: '0xaa11', x: '0x1', y: '0x2' }
  const BACKUP = { key_id: '0xbb22', x: '0x3', y: '0x4' }

  it('CHARACTERIZATION: testnet single-signer provisioning is unchanged (no waiver needed)', async () => {
    mockDb({})
    const res = await app.inject({
      method: 'POST', url: '/accounts/hybrid',
      payload: { chain_id: 84532, passkeys: [PASSKEY] },
    })
    expect(res.statusCode).toBe(201)
    // …and no waiver is ever recorded on a testnet row:
    const insert = mockQuery.mock.calls.find((c) => /INSERT INTO smart_accounts/.test(String(c[0])))
    expect(insert?.[1]?.[6]).toBeNull() // single_signer_waiver_at param
  })

  it('REVERSAL (#1153): a single-signer MAINNET account now PROVISIONS — no waiver, no 403', async () => {
    // This asserted 403 until #1153. The owner's call: the floor became a
    // recommendation shown after funding, because a wall here blocked the
    // one-Face-ID onboarding at the moment the user has nothing at risk.
    // The account is no more recoverable than before — see the security model.
    mockDb({})
    const res = await app.inject({
      method: 'POST', url: '/accounts/hybrid',
      payload: { chain_id: 8453, passkeys: [PASSKEY] },
    })
    expect(res.statusCode).toBe(201)
  })

  it('a single-signer mainnet row records NO waiver when none was sent', async () => {
    // The column stops being an unblock but stays as history, so it must not
    // be written just because provisioning now succeeds.
    mockDb({})
    await app.inject({
      method: 'POST', url: '/accounts/hybrid',
      payload: { chain_id: 8453, passkeys: [PASSKEY] },
    })
    const insert = mockQuery.mock.calls.find((c) => /INSERT INTO smart_accounts/.test(String(c[0])))
    expect(insert?.[1]?.[6]).toBeNull()
  })

  it('two signers pass the mainnet floor and provision on Base mainnet (#908 pins landed)', async () => {
    mockDb({})
    const res = await app.inject({
      method: 'POST', url: '/accounts/hybrid',
      payload: { chain_id: 8453, passkeys: [PASSKEY, BACKUP] },
    })
    // Until 2026-07-27 this 400ed on contract availability — 8453 had no
    // pins, which doubled as this test's proof that the signer floor runs
    // FIRST. The pins landed with the #908 gate; a compliant request now
    // provisions (counterfactual, no tx). The gate-order proof moved to the
    // unpinned-mainnet test below.
    expect(res.statusCode).toBe(201)
  })

  it('REVERSAL (#1153): an unpinned mainnet now refuses on AVAILABILITY, not the signer floor', async () => {
    // Chain 10 (OP mainnet): value-bearing and unpinned. This used to prove
    // the floor ran FIRST — one signer got 403 rather than the 400 for
    // "chain not available". With the floor gone, availability is the only
    // thing left to refuse it, which is what makes the removal visible here.
    mockDb({})
    const res = await app.inject({
      method: 'POST', url: '/accounts/hybrid',
      payload: { chain_id: 10, passkeys: [PASSKEY] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/not available on chain/i)
  })

  it('passkey + EOA owner counts as two signers', async () => {
    mockDb({})
    const res = await app.inject({
      method: 'POST', url: '/accounts/hybrid',
      payload: { chain_id: 8453, owner_address: OWNER, passkeys: [PASSKEY] },
    })
    expect(res.statusCode).toBe(201) // past the floor; 8453 is pinned since #908
  })

  it('an explicit waiver passes the floor (and would be recorded on the row)', async () => {
    mockDb({})
    const res = await app.inject({
      method: 'POST', url: '/accounts/hybrid',
      payload: {
        chain_id: 8453,
        passkeys: [PASSKEY],
        single_signer_waiver: { acknowledged: true },
      },
    })
    // Past the floor → provisioning succeeds (8453 pinned since #908). The
    // waiver recording itself is pinned by the mainnet-gate unit tests.
    expect(res.statusCode).toBe(201)
  })

  it('a non-true waiver value provisions, and is NOT recorded as an acknowledgement', async () => {
    // Nothing is gated on the waiver any more, so the interesting question
    // moved: a truthy-but-not-true value must not be written to the audit
    // column as though the user had acknowledged anything.
    mockDb({})
    const res = await app.inject({
      method: 'POST', url: '/accounts/hybrid',
      payload: {
        chain_id: 8453,
        passkeys: [PASSKEY],
        single_signer_waiver: { acknowledged: 'yes' as unknown as boolean },
      },
    })
    expect(res.statusCode).toBe(201)
    const insert = mockQuery.mock.calls.find((c) => /INSERT INTO smart_accounts/.test(String(c[0])))
    expect(insert?.[1]?.[6]).toBeNull()
  })

  it('rejects the zero address as owner (the "no owner" encoding must not count as a signer)', async () => {
    mockDb({})
    const res = await app.inject({
      method: 'POST', url: '/accounts/hybrid',
      payload: { chain_id: 8453, owner_address: '0x' + '0'.repeat(40), passkeys: [PASSKEY] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/zero address/)
  })

  it('rejects duplicate passkey key_ids (they collapse to one on-chain key)', async () => {
    mockDb({})
    const res = await app.inject({
      method: 'POST', url: '/accounts/hybrid',
      payload: { chain_id: 8453, passkeys: [PASSKEY, { ...PASSKEY }] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/duplicate passkey/)
  })

  it('REVERSAL (#1153): an unknown chain is refused by availability, not by the floor', async () => {
    // The fail-closed classification still exists and still calls an unknown
    // chain value-bearing — it now decides whether to RECOMMEND a backup, not
    // whether to refuse. Provisioning on a chain Haven has no pins for is
    // still impossible, which is the 400 below.
    mockDb({})
    const res = await app.inject({
      method: 'POST', url: '/accounts/hybrid',
      payload: { chain_id: 424242, passkeys: [PASSKEY] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/not available on chain/i)
  })
})

describe('POST /accounts/hybrid — create-additional (#4023)', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(hybridAccountRoutes, { prefix: '/accounts' })
  })
  afterAll(async () => app.close())
  beforeEach(() => {
    mockQuery.mockReset()
    mockCompute.mockReset()
    mockCompute.mockResolvedValue(HYBRID)
  })

  const ADDITIONAL = {
    chain_id: 84532,
    source_account_id: SOURCE_ID,
    key_id: 'cred-1',
    idempotency_key: 'create-1',
  }

  it('creates an additional account additively: owner copied from the SOURCE signer set, never the client', async () => {
    mockDb({})
    const res = await app.inject({ method: 'POST', url: '/accounts/hybrid', payload: ADDITIONAL })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ account_address: HYBRID, chain_id: 84532, deployed: false })
    expectMatchesSpec('POST', '/accounts/hybrid', res.json(), '201')
    // The derivation used the COPIED passkey at the allocated counter salt.
    expect(mockCompute).toHaveBeenCalledWith(84532, expect.objectContaining({
      ownerAddress: undefined,
      deploySalt: SALT_ONE,
      passkeys: [{ keyId: 'cred-1', x: BigInt('0x' + '11'.repeat(32)), y: BigInt('0x' + '22'.repeat(32)) }],
    }))
    // The INSERT never becomes the default — even as the first account.
    const insert = mockQuery.mock.calls.find((c) => /INSERT INTO smart_accounts/.test(String(c[0])))!
    expect(insert[1][4]).toBe(false) // is_default, whatever the count
    expect(insert[1][7]).toBe(SALT_ONE) // deploy_salt
    expect(insert[1][8]).toBe('create-1') // idempotency key persisted
  })

  it('a created account NEVER becomes the default (count 0 still inserts false)', async () => {
    mockDb({ count: '0' })
    const res = await app.inject({ method: 'POST', url: '/accounts/hybrid', payload: ADDITIONAL })
    expect(res.statusCode).toBe(201)
    const insert = mockQuery.mock.calls.find((c) => /INSERT INTO smart_accounts/.test(String(c[0])))!
    expect(insert[1][4]).toBe(false)
  })

  it('the single-signer waiver is recorded for a value-bearing single-passkey account', async () => {
    mockDb({})
    const res = await app.inject({
      method: 'POST', url: '/accounts/hybrid',
      payload: { ...ADDITIONAL, chain_id: 8453, single_signer_waiver: { acknowledged: true } },
    })
    expect(res.statusCode).toBe(201)
    const insert = mockQuery.mock.calls.find((c) => /INSERT INTO smart_accounts/.test(String(c[0])))!
    expect(insert[1][6]).not.toBeNull()
  })

  it('404s a source account the caller does not own, with SOURCE_ACCOUNT_NOT_FOUND', async () => {
    mockDb({ source: 'missing' })
    const res = await app.inject({ method: 'POST', url: '/accounts/hybrid', payload: ADDITIONAL })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error_code: 'SOURCE_ACCOUNT_NOT_FOUND' })
    expectMatchesSpec('POST', '/accounts/hybrid', res.json(), '404')
  })

  it('422s a source with no passkey to copy, with SOURCE_HAS_NO_PASSKEY and an owner-facing sentence', async () => {
    mockDb({ sourcePasskeys: [] })
    const res = await app.inject({ method: 'POST', url: '/accounts/hybrid', payload: ADDITIONAL })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toEqual({
      error: 'The source account has no passkey to copy, so it cannot secure an additional account',
      error_code: 'SOURCE_HAS_NO_PASSKEY',
    })
    expect(res.json().error).not.toMatch(/EOA/)
    expectMatchesSpec('POST', '/accounts/hybrid', res.json(), '422')
  })

  it('422s a key_id that is not in the source signer set', async () => {
    mockDb({})
    const res = await app.inject({
      method: 'POST', url: '/accounts/hybrid',
      payload: { ...ADDITIONAL, key_id: '0xother' },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toMatch(/not a passkey on the source account/)
    expect(res.json().error_code).toBe('KEY_NOT_ON_SOURCE')
  })

  it('422s at the soft cap of 10 accounts per user per chain, with ACCOUNT_CAP_REACHED, cap and chain_id', async () => {
    mockDb({ chainCount: '10' })
    const res = await app.inject({ method: 'POST', url: '/accounts/hybrid', payload: ADDITIONAL })
    expect(res.statusCode).toBe(422)
    expect(res.json().error).toMatch(/10 accounts/)
    expect(res.json()).toMatchObject({ error_code: 'ACCOUNT_CAP_REACHED', cap: 10, chain_id: 84532 })
    expectMatchesSpec('POST', '/accounts/hybrid', res.json(), '422')
  })

  it('400s a create-additional without an explicit chain_id (no bare fallback)', async () => {
    mockDb({})
    const res = await app.inject({
      method: 'POST', url: '/accounts/hybrid',
      payload: { source_account_id: SOURCE_ID, key_id: 'cred-1' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/chain_id is required/)
  })

  it('400s a mixed request: owner fields beside the source shape', async () => {
    mockDb({})
    const res = await app.inject({
      method: 'POST', url: '/accounts/hybrid',
      payload: { ...ADDITIONAL, owner_address: OWNER },
    })
    expect(res.statusCode).toBe(400)
  })

  it('400s a partial additional shape (source without key_id)', async () => {
    mockDb({})
    const res = await app.inject({
      method: 'POST', url: '/accounts/hybrid',
      payload: { chain_id: 84532, source_account_id: SOURCE_ID },
    })
    expect(res.statusCode).toBe(400)
  })

  const FIRST = { id: SOURCE_ID, account_address: HYBRID, chain_id: 84532, created_at: '2026-07-10T00:00:00Z' }

  it('a retried create returns the FIRST account (idempotency replay)', async () => {
    mockDb({ replay: FIRST })
    const res = await app.inject({ method: 'POST', url: '/accounts/hybrid', payload: ADDITIONAL })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ id: SOURCE_ID, account_address: HYBRID, chain_id: 84532 })
    expectMatchesSpec('POST', '/accounts/hybrid', res.json(), '201')
    expect(mockCompute).not.toHaveBeenCalled()
    expect(mockQuery.mock.calls.some((c) => /INSERT INTO smart_accounts/.test(String(c[0])))).toBe(false)
  })

  it('reads the replay scoped to the caller', async () => {
    mockDb({ replay: FIRST })
    await app.inject({ method: 'POST', url: '/accounts/hybrid', payload: ADDITIONAL })
    const read = mockQuery.mock.calls.find((c) => /create_idempotency_key = \$2/.test(String(c[0])))!
    expect(read[1]).toEqual(['user-1', 'create-1'])
  })

  it('#4024: a retried 10th create whose response was lost replays the account, not a cap refusal', async () => {
    // The first attempt made the 10th account, so the chain count is now 10.
    mockDb({ chainCount: '10', replay: FIRST })
    const res = await app.inject({ method: 'POST', url: '/accounts/hybrid', payload: ADDITIONAL })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ id: SOURCE_ID })
  })

  it('#4024: the replay runs before the source and key checks', async () => {
    mockDb({ source: 'missing', sourcePasskeys: [{ key_id: 'cred-1', public_key_x: '0x01', public_key_y: '0x02' }], replay: FIRST })
    const res = await app.inject({ method: 'POST', url: '/accounts/hybrid', payload: ADDITIONAL })
    expect(res.statusCode).toBe(201)
    // The source lookup never ran.
    expect(mockQuery.mock.calls.some((c) => /account_type = 'delegator_hybrid'/.test(String(c[0])))).toBe(false)
  })

  it('#4024: a key reused with a different key_id is refused, not replayed', async () => {
    mockDb({ replay: FIRST }) // the replayed account's one passkey is cred-1
    const res = await app.inject({
      method: 'POST', url: '/accounts/hybrid',
      payload: { ...ADDITIONAL, key_id: 'cred-2' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error_code: 'IDEMPOTENCY_KEY_REUSED', id: SOURCE_ID })
    expect(res.json().error).toMatch(/different key_id/)
    expectMatchesSpec('POST', '/accounts/hybrid', res.json(), '409')
  })

  it('#4024: a key reused on a different chain is refused, not replayed with the request chain', async () => {
    mockDb({ replay: { ...FIRST, chain_id: 8453 } })
    const res = await app.inject({ method: 'POST', url: '/accounts/hybrid', payload: ADDITIONAL })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error_code: 'IDEMPOTENCY_KEY_REUSED' })
    expect(res.json().error).toMatch(/different chain_id/)
  })

  it('#4024: an insert that loses on the idempotency key answers the committed winner, not a bare 409', async () => {
    mockDb({ raceWinner: FIRST })
    const res = await app.inject({ method: 'POST', url: '/accounts/hybrid', payload: ADDITIONAL })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ id: SOURCE_ID, account_address: HYBRID, chain_id: 84532 })
    expectMatchesSpec('POST', '/accounts/hybrid', res.json(), '201')
    // The re-read ran inside the registration transaction, and no passkey row
    // was written for the lost insert.
    expect(mockQuery.mock.calls.some((c) => /INSERT INTO hybrid_account_passkeys/.test(String(c[0])))).toBe(false)
  })

  it('#4024: a lost insert whose winner pins another chain answers IDEMPOTENCY_KEY_REUSED, not a bare 409', async () => {
    // (The different-passkey variant needs per-account signer rows, which this
    // dispatcher cannot tell apart: it is pinned on the real-DB race suite.)
    mockDb({ raceWinner: { ...FIRST, chain_id: 8453 } })
    const res = await app.inject({ method: 'POST', url: '/accounts/hybrid', payload: ADDITIONAL })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error_code: 'IDEMPOTENCY_KEY_REUSED', id: SOURCE_ID })
  })

  it('a signup insert that conflicts keeps its address-race answer (the key re-read is create-additional only)', async () => {
    // Even with a committed row carrying the key, signup does not replay it.
    mockDb({ raceWinner: FIRST, raceWinnerOnFirstRead: true })
    const res = await app.inject({
      method: 'POST', url: '/accounts/hybrid',
      payload: { chain_id: 84532, owner_address: OWNER, idempotency_key: 'signup-key' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'Account already registered' })
  })
})
