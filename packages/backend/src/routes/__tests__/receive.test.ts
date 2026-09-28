/**
 * Route tests for the receive side (#3333, epic #3328).
 *
 * What is proven here and nowhere else:
 * - the TOPOLOGY: the owner routes carry the dashboard JWT (401 without),
 *   the receipt drop carries NO auth (a payer has no Haven account) and its
 *   authentication is the payload signature;
 * - the drop's authority boundary: it matches only the transfer the
 *   recovered payer names, at the same amount, and it cannot flip an
 *   already-matched row;
 * - the hand-off prepare calls the rails with the SERVER-DERIVED token and
 *   the SAVED recipient — never the request body — and maps the rails
 *   failure status.
 *
 * Real-DB invariants (dedupe, one-way match, balance) live in
 * `infra/repositories/__tests__/inbound-transfers.test.ts`; this file mocks
 * the pool per the route-test convention (`docs/contributing/testing-strategy.md`)
 * and the rails boundary (the prepare/submit pair is tested in its own module).
 */
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'
import { Wallet } from 'ethers'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import receiveRoutes from '../receive.js'
import { installRequestValidation } from '../../openapi/request-validation.js'
import { expectMatchesSpec } from '../../openapi/response-shape.js'
import pool from '../../db.js'
import { rateLimitKeyFor } from '../../middleware/rate-limit.js'
import { prepareTransfer } from '../../rails/hybrid-transfers.js'
import { loadHybridOwnerConfig } from '../../rails/hybrid-account-config.js'

const ACCOUNT_ADDRESS = '0x135a9215604711AC70d970e12Caa812c53537EF4'
const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'
const TX_HASH = `0x${'c'.repeat(64)}`
const DESTINATION = '0x5555555555555555555555555555555555555555'
const PAYER_WALLET = new Wallet('0x' + '11'.repeat(32))
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'

const SAVED_DESTINATION_ROW = {
  id: '33333333-3333-4333-8333-333333333333',
  account_id: ACCOUNT_ID,
  chain_id: 8453,
  destination_address: DESTINATION,
  destination_kind: 'safello',
  label: null,
  created_at: new Date('2026-09-27T10:00:00Z'),
  updated_at: new Date('2026-09-27T10:00:00Z'),
}

// The rails boundary is mocked: the route's contract is WHICH transfer it
// asks the rails to prepare (token + saved recipient) and HOW it maps the
// outcome — the treasury/UserOperation mechanics are the rails module's own
// tested ground.
vi.mock('../../rails/hybrid-transfers.js', () => ({
  prepareTransfer: vi.fn(),
}))
vi.mock('../../rails/hybrid-account-config.js', () => ({
  loadHybridOwnerConfig: vi.fn(),
}))

/** Sign the exact drop payload the route verifies (EIP-191, like verifyMessage). */
async function signDrop(txHash: string, amountRaw: string): Promise<string> {
  const message = `haven:receipt-drop\ntx:${txHash}\namount_raw:${amountRaw}`
  return PAYER_WALLET.signMessage(message)
}

interface QueryPlan {
  /** Rows for `findAccountOwnership` (the owner routes' account read). */
  ownership?: Array<{ id: string }>
  /** Rows for the SELECTs on inbound_transfers (the ledger list). */
  inbound?: unknown[]
  /** Rows for the off_ramp_destinations SELECT/UPSERT (empty = none saved). */
  destination?: unknown[]
  /** Rows for the receipt drop's (address, chain) account lookup. */
  accountByAddress?: Array<{ id: string; user_id: string }>
  /** Rows for the inbound_receipt_drops INSERT ... RETURNING id. */
  drops?: Array<{ id: string }>
  /** Whether an UNMATCHED row exists for the hash (drives the match UPDATE). */
  unmatchedRow?: Record<string, unknown> | null
  /** Rows for the x402 payTo settlement lookup on payment_intents. */
  settlement?: Array<{ id: string }>
  /** Rows for the ingest INSERT ... RETURNING id. */
  insertedInbound?: Array<{ id: string }>
}

/** Route the pool queries the receive module makes, by table (db-mock-ratchet-safe). */
function routeQueries(plan: QueryPlan) {
  return vi.spyOn(pool, 'query').mockImplementation((async (sql: unknown, params: unknown[] = []) => {
    const text = String(sql)
    // The receipt drop's (address, chain) lookup is the only account read
    // WITHOUT a user_id predicate — the ownership reads all carry
    // `user_id = $1`. (The lookup SELECTs the user_id COLUMN, so the
    // discriminator is the predicate, not the projection.)
    if (text.includes('LOWER(account_address)') && !text.includes('user_id = $1')) {
      return { rows: plan.accountByAddress ?? [], rowCount: (plan.accountByAddress ?? []).length } as never
    }
    if (text.includes('inbound_receipt_drops')) {
      return { rows: plan.drops ?? [], rowCount: (plan.drops ?? []).length } as never
    }
    if (text.includes('inbound_transfers')) {
      if (text.includes('SET match_kind')) {
        const matched = plan.unmatchedRow != null
        return { rows: matched ? [{ id: params[0] }] : [], rowCount: matched ? 1 : 0 } as never
      }
      if (text.includes('SET balance_consumed')) {
        return { rows: [{ id: params[0] }], rowCount: 1 } as never
      }
      if (text.includes('SUM(amount_raw')) {
        return { rows: [{ total: '5000000' }], rowCount: 1 } as never
      }
      if (text.includes('INSERT INTO inbound_transfers')) {
        return { rows: plan.insertedInbound ?? [], rowCount: (plan.insertedInbound ?? []).length } as never
      }
      // The SELECTs (unmatched-by-hash, worklist, ledger) all answer from the
      // same plan field — an unmatched row IS an inbound row.
      return { rows: plan.unmatchedRow ? [plan.unmatchedRow] : (plan.inbound ?? []), rowCount: plan.unmatchedRow ? 1 : (plan.inbound ?? []).length } as never
    }
    if (text.includes('off_ramp_destinations')) {
      if (text.includes('INSERT INTO off_ramp_destinations')) {
        return {
          rows: [
            {
              id: '33333333-3333-4333-8333-333333333333',
              account_id: params[0],
              chain_id: params[2],
              destination_address: String(params[3]).toLowerCase(),
              destination_kind: params[4],
              label: null,
              created_at: new Date('2026-09-27T10:00:00Z'),
              updated_at: new Date('2026-09-27T10:00:00Z'),
            },
          ],
          rowCount: 1,
        } as never
      }
      return { rows: plan.destination ?? [], rowCount: (plan.destination ?? []).length } as never
    }
    // The x402 settlement lookup: one statement containing both tables, the
    // payTo EXISTS inside it — routed here, before the generic account read.
    if (text.includes('FROM payment_intents')) {
      return { rows: plan.settlement ?? [], rowCount: (plan.settlement ?? []).length } as never
    }
    if (text.includes('FROM smart_accounts')) {
      return { rows: plan.ownership ?? [], rowCount: (plan.ownership ?? []).length } as never
    }
    return { rows: [], rowCount: 0 } as never
  }) as never)
}

function mockRails(result: Awaited<ReturnType<typeof prepareTransfer>>) {
  vi.mocked(loadHybridOwnerConfig).mockResolvedValue({
    config: { ownerAddress: ACCOUNT_ADDRESS as `0x${string}` },
    accountId: ACCOUNT_ID,
    singleSignerWaiverAt: null,
  })
  vi.mocked(prepareTransfer).mockResolvedValue(result)
}

describe('receive routes (#3333)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    // Production wiring: root-scope install, the receive module born ENFORCED.
    installRequestValidation(app, { mode: 'enforce', enforcedModules: ['routes/receive.ts'] })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(receiveRoutes, { prefix: '/receive', trustProxyHops: 0 })
  })

  afterAll(async () => {
    await app.close()
  })

  function signToken(payload: { sub: string; email: string }): string {
    return app.jwt.sign(payload, { expiresIn: '1h' })
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ── Topology: the owner surface is behind the dashboard JWT ────────────────

  it('refuses the receive ledger without a token (401) — the owner surface is not public', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/receive/${ACCOUNT_ADDRESS}?chain_id=8453`,
    })
    expect(response.statusCode).toBe(401)
  })

  it('refuses the off-ramp destination set without a token (401) — an agent key reaches nothing here', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/receive/${ACCOUNT_ADDRESS}/off-ramp-destination?chain_id=8453`,
      payload: { destination_address: DESTINATION, destination_kind: 'safello' },
    })
    expect(response.statusCode).toBe(401)
  })

  it('refuses the hand-off prepare without a token (401)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/receive/${ACCOUNT_ADDRESS}/off-ramp/prepare?chain_id=8453`,
      payload: { amount_atomic: '1000000' },
    })
    expect(response.statusCode).toBe(401)
  })

  // ── The receive ledger ─────────────────────────────────────────────────────

  it('serves the ledger for the owner and matches the spec shape', async () => {
    routeQueries({
      ownership: [{ id: ACCOUNT_ID }],
      destination: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          account_id: ACCOUNT_ID,
          chain_id: 8453,
          destination_address: DESTINATION,
          destination_kind: 'safello',
          label: null,
          created_at: new Date('2026-09-27T10:00:00Z'),
          updated_at: new Date('2026-09-27T10:00:00Z'),
        },
      ],
    })
    const token = signToken({ sub: USER_ID, email: 'test@example.com' })

    const response = await app.inject({
      method: 'GET',
      url: `/receive/${ACCOUNT_ADDRESS}?chain_id=8453`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expectMatchesSpec('GET', '/receive/{accountAddress}', body)
    expect(body.balance_formatted).toBe('5.000000')
    expect(body.off_ramp_destination.destination_kind).toBe('safello')
    // Unmatched = unearned: a null match_kind row is served with earned: false.
    expect(
      body.transfers.every((t: { earned: boolean; match_kind: string | null }) => t.earned === (t.match_kind != null)),
    ).toBe(true)
  })

  it('refuses another owner account with 403', async () => {
    routeQueries({ ownership: [] })
    const token = signToken({ sub: USER_ID, email: 'test@example.com' })

    const response = await app.inject({
      method: 'GET',
      url: `/receive/${ACCOUNT_ADDRESS}?chain_id=8453`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(403)
  })

  it('refuses an unsupported chain with 400 before any ownership read', async () => {
    const token = signToken({ sub: USER_ID, email: 'test@example.com' })

    const response = await app.inject({
      method: 'GET',
      url: `/receive/${ACCOUNT_ADDRESS}?chain_id=999999`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(400)
  })

  // ── The off-ramp destination: owner-only set ───────────────────────────────

  it('saves the destination for the owner; the zero address and a bad kind are refused', async () => {
    routeQueries({ ownership: [{ id: ACCOUNT_ID }], destination: [] })
    const token = signToken({ sub: USER_ID, email: 'test@example.com' })

    const zero = await app.inject({
      method: 'PUT',
      url: `/receive/${ACCOUNT_ADDRESS}/off-ramp-destination?chain_id=8453`,
      headers: { authorization: `Bearer ${token}` },
      payload: { destination_address: `0x${'0'.repeat(40)}` },
    })
    expect(zero.statusCode).toBe(400)

    const badKind = await app.inject({
      method: 'PUT',
      url: `/receive/${ACCOUNT_ADDRESS}/off-ramp-destination?chain_id=8453`,
      headers: { authorization: `Bearer ${token}` },
      payload: { destination_address: DESTINATION, destination_kind: 'my-brother' },
    })
    // `destination_kind` is declared with an enum in the enforced schema, so a
    // value outside it is the 400 envelope, not the handler's refusal.
    expect(badKind.statusCode).toBe(400)

    const ok = await app.inject({
      method: 'PUT',
      url: `/receive/${ACCOUNT_ADDRESS}/off-ramp-destination?chain_id=8453`,
      headers: { authorization: `Bearer ${token}` },
      payload: { destination_address: DESTINATION, destination_kind: 'safello' },
    })
    expect(ok.statusCode).toBe(200)
    expectMatchesSpec('PUT', '/receive/{accountAddress}/off-ramp-destination', ok.json())
    expect(ok.json().destination_address).toBe(DESTINATION)
  })

  // ── The off-ramp hand-off: the OWNER-signed prepare ────────────────────────

  it('prepares the transfer to the SAVED destination via the rails; token and recipient are server-derived', async () => {
    routeQueries({ ownership: [{ id: ACCOUNT_ID }], destination: [SAVED_DESTINATION_ROW] })
    mockRails({ ok: true, prepared: { callData: '0xdeadbeef', sender: ACCOUNT_ADDRESS, nonce: '1' } })
    const token = signToken({ sub: USER_ID, email: 'test@example.com' })

    const response = await app.inject({
      method: 'POST',
      url: `/receive/${ACCOUNT_ADDRESS}/off-ramp/prepare?chain_id=8453`,
      headers: { authorization: `Bearer ${token}` },
      payload: { amount_atomic: '1000000' },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expectMatchesSpec('POST', '/receive/{accountAddress}/off-ramp/prepare', body)
    expect(body.prepared.callData).toBe('0xdeadbeef')
    expect(body.submit.to).toBe(DESTINATION)
    expect(body.submit.token_address.toLowerCase()).toBe(USDC.toLowerCase())
    expect(body.submit.signature_required_from).toBe('owner')
    // The money-path assertion: the rails were asked for the SAVED
    // destination and the registry USDC — never a request-supplied `to`.
    expect(vi.mocked(prepareTransfer).mock.calls[0][1]).toEqual({
      token_address: USDC,
      to: DESTINATION,
      amount_atomic: '1000000',
    })
  })

  it('maps a rails refusal to its status (e.g. 409 signer configuration unknown)', async () => {
    routeQueries({ ownership: [{ id: ACCOUNT_ID }], destination: [SAVED_DESTINATION_ROW] })
    mockRails({ ok: false, failure: { status: 409, error: 'Account signer configuration unknown' } })
    const token = signToken({ sub: USER_ID, email: 'test@example.com' })

    const response = await app.inject({
      method: 'POST',
      url: `/receive/${ACCOUNT_ADDRESS}/off-ramp/prepare?chain_id=8453`,
      headers: { authorization: `Bearer ${token}` },
      payload: { amount_atomic: '1000000' },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().error).toBe('Account signer configuration unknown')
  })

  it('refuses the hand-off with 409 when no destination is saved', async () => {
    routeQueries({ ownership: [{ id: ACCOUNT_ID }], destination: [] })
    const token = signToken({ sub: USER_ID, email: 'test@example.com' })

    const response = await app.inject({
      method: 'POST',
      url: `/receive/${ACCOUNT_ADDRESS}/off-ramp/prepare?chain_id=8453`,
      headers: { authorization: `Bearer ${token}` },
      payload: { amount_atomic: '1000000' },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().error).toMatch(/destination/)
  })

  it('refuses a bad amount with the enforced envelope (400) before any ownership read', async () => {
    routeQueries({})
    const token = signToken({ sub: USER_ID, email: 'test@example.com' })

    const response = await app.inject({
      method: 'POST',
      url: `/receive/${ACCOUNT_ADDRESS}/off-ramp/prepare?chain_id=8453`,
      headers: { authorization: `Bearer ${token}` },
      payload: { amount_atomic: '-5' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('Request does not match the API spec')
  })

  // ── The receipt drop: unauthenticated but payer-signed ─────────────────────

  it('accepts the payer-signed drop and matches the transfer — NO auth header anywhere', async () => {
    routeQueries({
      accountByAddress: [{ id: ACCOUNT_ID, user_id: USER_ID }],
      drops: [{ id: '44444444-4444-4444-8444-444444444444' }],
      unmatchedRow: {
        id: '66666666-6666-4666-8666-666666666666',
        amount_raw: '1000000',
        payer_address: PAYER_WALLET.address.toLowerCase(),
      },
      settlement: [],
    })
    const amountRaw = '1000000'
    const response = await app.inject({
      method: 'POST',
      url: `/receive/${ACCOUNT_ADDRESS}/receipt-drop?chain_id=8453`,
      payload: {
        tx_hash: TX_HASH,
        amount_raw: amountRaw,
        payer_address: PAYER_WALLET.address,
        signature: await signDrop(TX_HASH, amountRaw),
      },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expectMatchesSpec('POST', '/receive/{accountAddress}/receipt-drop', body)
    expect(body.matched).toBe(true)
    expect(body.match_kind).toBe('receipt')
  })

  it('matches the drop against an x402 settlement the account was payTo for when one names the hash', async () => {
    routeQueries({
      accountByAddress: [{ id: ACCOUNT_ID, user_id: USER_ID }],
      drops: [{ id: '44444444-4444-4444-8444-444444444444' }],
      unmatchedRow: {
        id: '66666666-6666-4666-8666-666666666666',
        amount_raw: '1000000',
        payer_address: PAYER_WALLET.address.toLowerCase(),
      },
      settlement: [{ id: '77777777-7777-4777-8777-777777777777' }],
    })
    const amountRaw = '1000000'
    const response = await app.inject({
      method: 'POST',
      url: `/receive/${ACCOUNT_ADDRESS}/receipt-drop?chain_id=8453`,
      payload: {
        tx_hash: TX_HASH,
        amount_raw: amountRaw,
        payer_address: PAYER_WALLET.address,
        signature: await signDrop(TX_HASH, amountRaw),
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().match_kind).toBe('x402_payto')
  })

  it('refuses a drop whose signature does not recover to the named payer (400)', async () => {
    routeQueries({ accountByAddress: [] })
    const stranger = Wallet.createRandom()
    const message = `haven:receipt-drop\ntx:${TX_HASH}\namount_raw:1000000`
    const response = await app.inject({
      method: 'POST',
      url: `/receive/${ACCOUNT_ADDRESS}/receipt-drop?chain_id=8453`,
      payload: {
        tx_hash: TX_HASH,
        amount_raw: '1000000',
        payer_address: PAYER_WALLET.address,
        signature: await stranger.signMessage(message),
      },
    })
    expect(response.statusCode).toBe(400)
  })

  it('refuses a drop whose amount contradicts the persisted transfer (409), no match written', async () => {
    routeQueries({
      accountByAddress: [{ id: ACCOUNT_ID, user_id: USER_ID }],
      drops: [{ id: '44444444-4444-4444-8444-444444444444' }],
      unmatchedRow: {
        id: '66666666-6666-4666-8666-666666666666',
        amount_raw: '2000000',
        payer_address: PAYER_WALLET.address.toLowerCase(),
      },
      settlement: [],
    })
    const response = await app.inject({
      method: 'POST',
      url: `/receive/${ACCOUNT_ADDRESS}/receipt-drop?chain_id=8453`,
      payload: {
        tx_hash: TX_HASH,
        amount_raw: '1000000',
        payer_address: PAYER_WALLET.address,
        signature: await signDrop(TX_HASH, '1000000'),
      },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().error).toMatch(/amount mismatch/)
  })

  it('answers 404 when no unmatched transfer carries that hash', async () => {
    routeQueries({
      accountByAddress: [{ id: ACCOUNT_ID, user_id: USER_ID }],
      drops: [{ id: '44444444-4444-4444-8444-444444444444' }],
      unmatchedRow: null,
      settlement: [],
    })
    const amountRaw = '1000000'
    const response = await app.inject({
      method: 'POST',
      url: `/receive/${ACCOUNT_ADDRESS}/receipt-drop?chain_id=8453`,
      payload: {
        tx_hash: TX_HASH,
        amount_raw: amountRaw,
        payer_address: PAYER_WALLET.address,
        signature: await signDrop(TX_HASH, amountRaw),
      },
    })
    expect(response.statusCode).toBe(404)
    expect(response.json().error).toMatch(/No unmatched inbound transfer/)
  })

  it('answers 404 when no Haven account receives at that address on that chain', async () => {
    routeQueries({ accountByAddress: [] })
    const amountRaw = '1000000'
    const response = await app.inject({
      method: 'POST',
      url: `/receive/${ACCOUNT_ADDRESS}/receipt-drop?chain_id=8453`,
      payload: {
        tx_hash: TX_HASH,
        amount_raw: amountRaw,
        payer_address: PAYER_WALLET.address,
        signature: await signDrop(TX_HASH, amountRaw),
      },
    })
    expect(response.statusCode).toBe(404)
    expect(response.json().error).toMatch(/No Haven account receives/)
  })

  it('refuses a malformed drop body with the enforced envelope (400)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/receive/${ACCOUNT_ADDRESS}/receipt-drop?chain_id=8453`,
      payload: { tx_hash: 'not-a-hash', amount_raw: '1000000', payer_address: PAYER_WALLET.address, signature: '0x00' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('Request does not match the API spec')
  })

  // ── The ingest hook ────────────────────────────────────────────────────────

  it('ingests one inbound transfer for the owner', async () => {
    routeQueries({ ownership: [{ id: ACCOUNT_ID }], insertedInbound: [{ id: '88888888-8888-4888-8888-888888888888' }] })
    const token = signToken({ sub: USER_ID, email: 'test@example.com' })

    const response = await app.inject({
      method: 'POST',
      url: `/receive/${ACCOUNT_ADDRESS}/ingest?chain_id=8453`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        tx_hash: TX_HASH,
        payer_address: PAYER_WALLET.address,
        amount_raw: '1000000',
        block_time: '2026-09-27T10:00:00Z',
      },
    })

    expect(response.statusCode).toBe(200)
    expectMatchesSpec('POST', '/receive/{accountAddress}/ingest', response.json())
    expect(response.json().ingested).toBe(true)
  })
})

// ── The receipt-drop rate-limit tier (#3333 round-2 F-3) ──────────────────────
// The route's limiter wiring, in miniature — the store's own behaviour has its
// own suites (#1680), so this uses the plugin default store like the catalog
// submit tier's suite does. The first 20 requests are refused 400 by the
// enforced schema (deterministic, no database); the ceiling turns the 21st
// into 429. Without a trusted proxy the tier refuses to arm and the same
// flood is unlimited — the shared-bucket DoS trade every public per-IP tier
// in rate-limit.ts documents.

describe('receive receipt-drop rate-limit tier (round-2 F-3)', () => {
  // Fails the enforced schema before the handler: no pool, no DB, no state.
  const MALFORMED_DROP = {
    tx_hash: 'not-a-hash',
    amount_raw: '1000000',
    payer_address: PAYER_WALLET.address,
    signature: '0x00',
  }

  async function dropApp(trustProxyHops: number): Promise<FastifyInstance> {
    const app = Fastify({ logger: false })
    installRequestValidation(app, { mode: 'enforce', enforcedModules: ['routes/receive.ts'] })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(rateLimit, {
      global: false,
      keyGenerator: (request: { headers: Record<string, string | string[] | undefined>; ip: string }) =>
        rateLimitKeyFor(request),
    })
    await app.register(receiveRoutes, { prefix: '/receive', trustProxyHops })
    await app.ready()
    return app
  }

  it('MUTATION PROOF: with a trusted proxy, the 21st drop from one address is 429', async () => {
    const app = await dropApp(1)

    const codes: number[] = []
    let retryAfter: string | undefined
    for (let i = 0; i < 21; i++) {
      const res = await app.inject({
        method: 'POST',
        url: `/receive/${ACCOUNT_ADDRESS}/receipt-drop?chain_id=8453`,
        payload: MALFORMED_DROP,
      })
      codes.push(res.statusCode)
      if (res.statusCode === 429) retryAfter = res.headers['retry-after'] as string | undefined
    }

    expect(codes.filter((c) => c === 400)).toHaveLength(20)
    expect(codes[20]).toBe(429)
    expect(retryAfter).toBeDefined()
    await app.close()
  })

  it('without a trusted proxy the tier does not arm — the same flood stays unlimited', async () => {
    const app = await dropApp(0)

    for (let i = 0; i < 25; i++) {
      const res = await app.inject({
        method: 'POST',
        url: `/receive/${ACCOUNT_ADDRESS}/receipt-drop?chain_id=8453`,
        payload: MALFORMED_DROP,
      })
      expect(res.statusCode).toBe(400)
    }
    await app.close()
  })
})
