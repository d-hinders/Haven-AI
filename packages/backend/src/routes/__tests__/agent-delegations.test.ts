/**
 * #828 delegation lifecycle. Pattern-matched DB mocks (#775). The network
 * seams (address derivation, treasury ops) are mocked; the caveat compiler
 * runs REAL so payloads and identities are genuine.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { mockQuery, mockCompute, mockTreasury } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockCompute: vi.fn(),
  mockTreasury: vi.fn(),
}))
vi.mock('../../db.js', () => ({ default: { query: (...a: unknown[]) => mockQuery(...a) } }))
vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: async (request: { user?: unknown }) => {
    request.user = { sub: 'user-1' }
  },
}))
vi.mock('../../lib/hybrid-provisioning.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/hybrid-provisioning.js')>()
  return { ...actual, computeHybridAccountAddress: (...a: unknown[]) => mockCompute(...a) }
})
vi.mock('../../lib/delegation-rail.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/delegation-rail.js')>()
  return {
    ...actual,
    createTreasuryOps: (...a: unknown[]) => mockTreasury(...a),
    delegationRailBundlerUrl: () => 'https://bundler.example/x?apikey=SECRET',
  }
})

const agentDelegationRoutes = (await import('../agent-delegations.js')).default
const { getDelegationContracts } = await import('../../lib/delegation-contracts.js')

const AGENT_ID = '11111111-1111-1111-1111-111111111111'
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const RECIPIENT = '0x' + 'cc'.repeat(20)
const TREASURY = '0x' + 'aa'.repeat(20)
const DELEGATE_KEY = '0x' + 'bb'.repeat(20)
const DELEGATE_ACCOUNT = '0x' + 'dd'.repeat(20)
const OWNER = '0x' + 'ee'.repeat(20)
const HASH = `0x${'ab'.repeat(32)}`

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    agent_id: AGENT_ID,
    delegate_address: DELEGATE_KEY,
    chain_id: 84532,
    treasury_address: TREASURY,
    account_type: 'delegator_hybrid',
    ...overrides,
  }
}

function mockDb(opts: {
  agent?: Record<string, unknown> | null
  version?: number
  stored?: Record<string, unknown> | null
  owner?: string | null
} = {}) {
  mockQuery.mockImplementation((sql: string) => {
    const s = String(sql)
    if (/FROM agents a/.test(s)) {
      return Promise.resolve({ rows: opts.agent === null ? [] : [opts.agent ?? agentRow()] })
    }
    if (/COALESCE\(MAX\(version\)/.test(s)) {
      return Promise.resolve({ rows: [{ next_version: opts.version ?? 1 }] })
    }
    if (/SELECT owner_address FROM user_safes/.test(s)) {
      return Promise.resolve({ rows: [{ owner_address: opts.owner === null ? null : opts.owner ?? OWNER }] })
    }
    if (/SELECT delegation_json, status/.test(s) || /SELECT id, delegation_json/.test(s)) {
      return Promise.resolve({ rows: opts.stored === null ? [] : [opts.stored ?? {
        id: 'row-1',
        delegation_json: JSON.stringify({ delegate: DELEGATE_ACCOUNT, delegator: TREASURY, authority: `0x${'0'.repeat(64)}`, caveats: [], salt: 1n.toString() }),
        status: 'pending',
        token_address: USDC.toLowerCase(),
        recipient_address: RECIPIENT.toLowerCase(),
      }] })
    }
    if (/FROM agent_delegations/.test(s)) return Promise.resolve({ rows: [] })
    return Promise.resolve({ rows: [] })
  })
}

describe('delegation lifecycle API (#828)', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(agentDelegationRoutes, { prefix: '/agents' })
  })
  afterAll(async () => app.close())
  beforeEach(() => {
    mockQuery.mockReset()
    mockCompute.mockReset()
    mockTreasury.mockReset()
    mockCompute.mockResolvedValue(DELEGATE_ACCOUNT)
  })

  describe('POST /:id/delegations/build — grant step 1', () => {
    it('returns EIP-712 typed data for the OWNER to sign; backend signs nothing', async () => {
      mockDb({})
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/delegations/build`,
        payload: { token_address: USDC, recipient_address: RECIPIENT, budget_atomic: '5000000', period_seconds: 86400 },
      })
      expect(res.statusCode).toBe(201)
      const body = res.json()
      expect(body.signing_payload.primaryType).toBe('Delegation')
      expect(body.signing_payload.domain.verifyingContract.toLowerCase()).toBe(
        getDelegationContracts(84532).delegationManager.toLowerCase(),
      )
      expect(body.delegation_hash).toMatch(/^0x[0-9a-f]{64}$/i)
      // No signature anywhere in the response — the owner supplies it:
      expect(JSON.stringify(body)).not.toMatch(/"signature":\s*"0x[0-9a-f]{130}/i)
      // Row stored as pending:
      const insert = mockQuery.mock.calls.find((c) => /INSERT INTO agent_delegations/.test(String(c[0])))!
      expect(String(insert[0])).toContain("'pending'")
    })

    it('the open-budget variant carries no recipient', async () => {
      mockDb({})
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/delegations/build`,
        payload: { token_address: USDC, budget_atomic: '5000000', period_seconds: 86400 },
      })
      expect(res.statusCode).toBe(201)
      const insert = mockQuery.mock.calls.find((c) => /INSERT INTO agent_delegations/.test(String(c[0])))!
      expect(insert[1][3]).toBeNull() // recipient_address
    })

    it('a replacement gets a FRESH identity (version bump, #813)', async () => {
      mockDb({ version: 1 })
      const first = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/delegations/build`,
        payload: { token_address: USDC, recipient_address: RECIPIENT, budget_atomic: '5000000', period_seconds: 86400 },
      })
      mockDb({ version: 2 })
      const second = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/delegations/build`,
        payload: { token_address: USDC, recipient_address: RECIPIENT, budget_atomic: '9000000', period_seconds: 86400 },
      })
      expect(second.json().version).toBe(2)
      expect(second.json().delegation_hash).not.toBe(first.json().delegation_hash)
    })

    it.each([
      ['legacy account', { agent: agentRow({ account_type: 'safe' }) }, 409],
      ['missing delegate key', { agent: agentRow({ delegate_address: null }) }, 409],
      ['unknown agent', { agent: null }, 404],
    ])('rejects %s', async (_label, opts, code) => {
      mockDb(opts as never)
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/delegations/build`,
        payload: { token_address: USDC, budget_atomic: '1', period_seconds: 86400 },
      })
      expect(res.statusCode).toBe(code)
    })

    it.each([
      ['bad token', { token_address: 'x', budget_atomic: '1', period_seconds: 86400 }],
      ['zero budget', { token_address: USDC, budget_atomic: '0', period_seconds: 86400 }],
      ['short period', { token_address: USDC, budget_atomic: '1', period_seconds: 10 }],
      ['past expiry', { token_address: USDC, budget_atomic: '1', period_seconds: 86400, expires_at: 1 }],
    ])('validates: %s', async (_label, payload) => {
      mockDb({})
      const res = await app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/delegations/build`, payload })
      expect(res.statusCode).toBe(400)
    })
  })

  describe('POST /:id/delegations/:hash/activate — grant step 2', () => {
    it('stores the owner signature and marks the previous grant replaced', async () => {
      mockDb({})
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/delegations/${HASH}/activate`,
        payload: { signature: '0x' + 'ab'.repeat(65) },
      })
      expect(res.json()).toMatchObject({ activated: true })
      const replaced = mockQuery.mock.calls.find((c) => /SET status = 'replaced'/.test(String(c[0])))
      expect(replaced).toBeDefined()
      const activated = mockQuery.mock.calls.find((c) => /SET\s+status = 'active'/.test(String(c[0])))!
      expect(String(activated[1][0])).toContain('signature')
    })

    it('rejects a malformed signature and a non-pending row', async () => {
      mockDb({})
      const bad = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/delegations/${HASH}/activate`, payload: { signature: '0xdead' },
      })
      expect(bad.statusCode).toBe(400)
      mockDb({ stored: { id: 'r', delegation_json: '{}', status: 'revoked', token_address: USDC, recipient_address: null } })
      const wrongState = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/delegations/${HASH}/activate`,
        payload: { signature: '0x' + 'ab'.repeat(65) },
      })
      expect(wrongState.statusCode).toBe(409)
    })
  })

  describe('POST /:id/delegations/:hash/revoke — one owner signature', () => {
    it('prepares a treasury userOpHash for the owner to sign; backend never signs', async () => {
      mockDb({ stored: { delegation_json: JSON.stringify({ delegate: DELEGATE_ACCOUNT, delegator: TREASURY, authority: `0x${'0'.repeat(64)}`, caveats: [], salt: '1', signature: '0x' + 'cd'.repeat(65) }), status: 'active' } })
      mockTreasury.mockResolvedValue({
        treasuryAddress: TREASURY,
        prepareCall: vi.fn().mockResolvedValue({
          userOperation: { nonce: 1n, sender: TREASURY },
          userOpHash: `0x${'ef'.repeat(32)}`,
          // The owner signs THIS typed data — not the bare hash (#829 lesson).
          signingTypedData: { domain: { name: 'HybridDeleGator' }, types: {}, primaryType: 'PackedUserOperation', message: {} },
          treasuryAddress: TREASURY,
        }),
        submitCall: vi.fn(),
      })
      const res = await app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/delegations/${HASH}/revoke` })
      expect(res.statusCode).toBe(200)
      expect(res.json().signing_payload.domain.name).toBe('HybridDeleGator')
      expect(res.json().instructions).toMatch(/Sign signing_payload/)
      // Nothing was submitted, nothing marked revoked yet:
      expect(mockQuery.mock.calls.some((c) => /status = 'revoked'/.test(String(c[0])))).toBe(false)
    })

    it('409s an unknown treasury owner (passkey account before #833)', async () => {
      mockDb({ stored: { delegation_json: '{}', status: 'active' }, owner: null })
      const res = await app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/delegations/${HASH}/revoke` })
      expect(res.statusCode).toBe(409)
      expect(res.json().error).toMatch(/exit path/)
    })

    it('submit marks revoked and never leaks the bundler credential on failure', async () => {
      mockDb({ stored: { delegation_json: '{}', status: 'active' } })
      mockTreasury.mockResolvedValue({
        treasuryAddress: TREASURY,
        prepareCall: vi.fn(),
        submitCall: vi.fn().mockRejectedValue(
          new Error('bundler: https://bundler.example/x?apikey=SUPERSECRET declined'),
        ),
      })
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/delegations/${HASH}/revoke/submit`,
        payload: { signature: '0xabcd', user_operation: { nonce: '1n' } },
      })
      expect(res.statusCode).toBe(502)
      expect(res.body).not.toContain('SUPERSECRET')
      expect(res.body).toContain('apikey=REDACTED')
    })

    it('successful submit marks the row revoked', async () => {
      mockDb({ stored: { delegation_json: '{}', status: 'active' } })
      mockTreasury.mockResolvedValue({
        treasuryAddress: TREASURY,
        prepareCall: vi.fn(),
        submitCall: vi.fn().mockResolvedValue({ txHash: '0xfeed', userOpHash: '0x', actualGasUsed: 1n, actualGasCost: 1n }),
      })
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/delegations/${HASH}/revoke/submit`,
        payload: { signature: '0xabcd', user_operation: { nonce: '1n' } },
      })
      expect(res.json()).toMatchObject({ revoked: true, tx_hash: '0xfeed' })
      expect(mockQuery.mock.calls.some((c) => /status = 'revoked'/.test(String(c[0])))).toBe(true)
    })
  })

  describe('GET /:id/delegations', () => {
    it('never returns the signed delegation object in the list', async () => {
      mockDb({})
      const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/delegations` })
      expect(res.statusCode).toBe(200)
      const listQuery = mockQuery.mock.calls.find((c) => /FROM agent_delegations/.test(String(c[0])))!
      expect(String(listQuery[0])).not.toContain('delegation_json')
    })
  })
})
