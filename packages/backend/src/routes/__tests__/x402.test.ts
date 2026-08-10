import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import x402Routes from '../x402.js'

const { mockQuery, allowanceMocks, fiatMocks, evidenceMocks } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  allowanceMocks: {
    getTokenAllowance: vi.fn(),
    getTokenBalance: vi.fn(),
    getLatestBlockTimeSec: vi.fn(),
    computeEffectiveAllowance: vi.fn(),
    generateTransferHash: vi.fn(),
    recoverSigner: vi.fn(),
    executeAllowanceTransfer: vi.fn(),
  },
  fiatMocks: {
    getFiatValuesForTokenAmount: vi.fn(),
  },
  evidenceMocks: {
    tryRecordMachinePaymentEvidenceBaseById: vi.fn(),
  },
}))

// The allowance-nonce coordinator (#718) rides a shared Postgres watermark
// along with every legacy-rail authorize; it is fail-open and orthogonal to
// what these tests assert, so stub the repository rather than answer its
// query through the content-dispatch stub below.
vi.mock('../../infra/repositories/allowance-nonce-watermarks.js', () => ({
  findAllowanceNonceWatermark: async () => null,
  raiseAllowanceNonceWatermark: async () => {},
}))
vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}))

vi.mock('../../rails/allowance-module.js', () => allowanceMocks)

vi.mock('../../infra/fiat-values.js', () => fiatMocks)

// Evidence recording moved into the mpp module's public entry point (#997);
// the x402 legacy-rail orchestration imports it from there now.
vi.mock('../../modules/mpp/index.js', () => evidenceMocks)

const AGENT = {
  id: '11111111-1111-1111-1111-111111111111',
  user_id: '22222222-2222-2222-2222-222222222222',
  name: 'Payment Agent',
  delegate_address: '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1',
  safe_address: '0x135a9215604711AC70d970e12Caa812c53537EF4',
  chain_id: 8453,
  status: 'active',
}

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const MERCHANT = '0x15179876c595922999C2d5DC7c23Cc7711fE799a'
const SIGN_HASH = `0x${'11'.repeat(32)}`
const TX_HASH = `0x${'ab'.repeat(32)}`
const PAYMENT_ID = '33333333-3333-3333-3333-333333333333'
const X402_BINDING_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d'

function pendingX402Intent(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    status: 'pending_signature',
    expires_at: '2026-05-10T20:00:00.000Z',
    chain_id: 8453,
    safe_address: AGENT.safe_address,
    token_symbol: 'USDC',
    token_address: USDC,
    amount_human: '0.02',
    amount_raw: '20000',
    to_address: AGENT.delegate_address.toLowerCase(),
    x402_merchant_address: MERCHANT.toLowerCase(),
    merchant_address: MERCHANT.toLowerCase(),
    x402_resource_url: 'https://mcp.soundside.ai/mcp',
    payment_resource_url: 'https://mcp.soundside.ai/mcp',
    source: 'x402',
    payment_rail: 'x402',
    x402_idempotency_key: 'x402:test',
    machine_idempotency_key: 'x402:test',
    sign_hash: SIGN_HASH,
    allowance_nonce: 7,
    ...overrides,
  }
}

/** The RETURNING shape of a queued approval_requests row (#1226). */
function x402ApprovalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'approval-123',
    chain_id: 8453,
    token_symbol: 'USDC',
    token_address: USDC,
    amount_human: '0.02',
    amount_raw: '20000',
    status: 'pending',
    tx_hash: null,
    expires_at: '2026-05-10T20:00:00.000Z',
    source: 'x402',
    payment_rail: 'x402',
    payment_resource_url: 'https://mcp.soundside.ai/mcp',
    x402_resource_url: 'https://mcp.soundside.ai/mcp',
    merchant_address: MERCHANT.toLowerCase(),
    machine_challenge_id: null,
    machine_idempotency_key: 'x402:approval',
    machine_metadata: JSON.stringify({
      protocol: 'x402',
      network: 'base',
      category: null,
      description: null,
    }),
    ...overrides,
  }
}

// ── Content-dispatch DB stub (#1226) ─────────────────────────────────────────
//
// Routes match on SQL FRAGMENTS, first hit wins, anything unmatched returns
// zero rows. This replaces the positional mockResolvedValueOnce chains that
// re-shuffled whenever the legacy-authorize orchestration gained a query —
// what the database DOES with these statements (idempotency dedupe, the
// stale-replay refresh guard, the ON CONFLICT DO NOTHING races) is proven in
// the repository suites on the real harness (x402-authorizations.test.ts,
// payment-intents.test.ts, epic #1219); these tests own only the HANDLER:
// status codes, response shapes, and which writes were asked for.

type DbRoute = [RegExp, (sql: string, params: unknown[]) => { rows: unknown[] } | Promise<{ rows: unknown[] }>]

function primeDb(...routes: DbRoute[]) {
  mockQuery.mockImplementation(async (sql: unknown, params: unknown[]) => {
    const text = String(sql)
    for (const [re, handler] of routes) {
      if (re.test(text)) return handler(text, params)
    }
    return { rows: [] }
  })
}

/** Every SQL text the handler sent, for pattern-based assertions. */
const sqlCalls = () => mockQuery.mock.calls.map((c) => ({ sql: String(c[0]), params: c[1] as unknown[] }))
const findCall = (re: RegExp) => sqlCalls().find((c) => re.test(c.sql))

const AUTH: DbRoute = [/api_key_hash = \$1/, () => ({ rows: [AGENT] })]

// The three reads a legacy-rail authorize always needs once it clears the
// idempotency lookups: the on-chain-allowance policy check, and the hourly
// cap's two-part read. Defaults answer the common "policy is fine" case.
const ALLOWANCE_OK: DbRoute = [/FROM agent_allowances/, () => ({ rows: [{ allowance_amount: '10' }] })]
const HOURLY_OK: DbRoute = [/max_x402_per_hour FROM agents/, () => ({ rows: [{ max_x402_per_hour: 100 }] })]
const COUNT_OK: DbRoute = [/as cnt FROM payment_intents/, () => ({ rows: [{ cnt: '0' }] })]
const POLICY_ROUTES: DbRoute[] = [ALLOWANCE_OK, HOURLY_OK, COUNT_OK]

/** INSERT INTO payment_intents (the ON CONFLICT DO NOTHING ... RETURNING *). */
const insertIntent = (row: Record<string, unknown> | null): DbRoute => [
  /INSERT INTO payment_intents/,
  () => ({ rows: row ? [row] : [] }),
]
/** The post-insert-conflict reload (findActiveX402IntentByIdempotencyKey). */
const activeReload = (row: Record<string, unknown> | null): DbRoute => [
  /status NOT IN \('failed', 'expired'\)/,
  () => ({ rows: row ? [row] : [] }),
]
/** The stale-replay refresh guard (refreshStaleX402Intent). */
const refresh = (row: Record<string, unknown> | null): DbRoute => [
  /SET allowance_nonce = \$1/,
  () => ({ rows: row ? [row] : [] }),
]
/** INSERT INTO approval_requests (the over-allowance queue write). */
const insertApproval = (row: Record<string, unknown> | null): DbRoute => [
  /INSERT INTO approval_requests/,
  () => ({ rows: row ? [row] : [] }),
]
/** recordX402Signature: pending_signature → signed, no status flip. */
const recordSignature = (ok: boolean): DbRoute => [
  /SET signature = \$1, signed_at = NOW\(\)/,
  () => ({ rows: ok ? [{ id: PAYMENT_ID }] : [] }),
]
/** confirmX402Intent: pending_signature → confirmed, one-shot. */
const confirm = (ok: boolean): DbRoute => [
  /SET status = 'confirmed'/,
  () => ({ rows: ok ? [{ id: PAYMENT_ID }] : [] }),
]
/** getIntentStatus, read after a guarded write comes back empty. */
const intentStatus = (status: string): DbRoute => [
  /SELECT status FROM payment_intents/,
  () => ({ rows: [{ status }] }),
]
/** findX402ApprovalByIdempotencyKey / findApprovalStatusRow — same shape answers both. */
const approvalRoute = (row: Record<string, unknown> | null): DbRoute => [
  /FROM approval_requests/,
  () => ({ rows: row ? [row] : [] }),
]

describe('x402 routes', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(x402Routes, { prefix: '/x402' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    process.env.X402_BINDING_PRIVATE_KEY = X402_BINDING_PRIVATE_KEY
    mockQuery.mockReset()
    for (const mock of Object.values(allowanceMocks)) mock.mockReset()
    for (const mock of Object.values(fiatMocks)) mock.mockReset()
    for (const mock of Object.values(evidenceMocks)) mock.mockReset()
    // Default to zero delegate balance for tests that don't care about it.
    // The pre-flight check (delegateBalance + remainingAllowance >= amount)
    // still passes because existing tests set `remaining` high enough to
    // cover the requested amount on its own. Tests that want to exercise
    // the insufficient-funds branch override this with .mockResolvedValueOnce.
    allowanceMocks.getTokenBalance.mockResolvedValue(0n)
  })

  it('registers /x402/authorize as the explicit authorize endpoint', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/x402/authorize',
      payload: {},
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: 'Missing or invalid API key' })
  })

  it('rejects settlementScheme erc7710 on the legacy rail — 3009 only there (#946)', async () => {
    primeDb(AUTH)
    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
        settlementScheme: 'erc7710',
      },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toMatch(/delegation-rail account/)
  })

  // #993 (review finding on #1120): the retired-rail 410 must hold on the
  // x402 entry point too — a session-marked account previously slipped into
  // the legacy AllowanceModule flow here.
  it('REFUSES a session-marked account on x402 authorize — 410, zero writes', async () => {
    primeDb([/api_key_hash = \$1/, () => ({ rows: [{ ...AGENT, execution_rail: 'session_key' }] })])
    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
      },
    })
    expect(response.statusCode).toBe(410)
    expect(response.json().error).toMatch(/session rail is retired/)
    expect(sqlCalls().some((c) => /INSERT|UPDATE|DELETE/i.test(c.sql))).toBe(false)
  })

  // #1058: same scheme confusion, same loud failure — a legacy-rail client
  // believing a redeemer pin exists must not silently proceed unpinned.
  it('rejects facilitatorAddresses on the legacy rail — no settlement child exists there', async () => {
    primeDb(AUTH)
    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
        facilitatorAddresses: ['0x' + '77'.repeat(20)],
      },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toMatch(/delegation-rail account/)
  })

  it('creates a funding intent to the delegate and records merchant metadata', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 7 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 1_000_000n })
    allowanceMocks.generateTransferHash.mockResolvedValueOnce(SIGN_HASH)

    primeDb(
      AUTH,
      ...POLICY_ROUTES,
      insertIntent({
        id: PAYMENT_ID,
        // The pg driver returns TIMESTAMPTZ columns as Date objects — use a
        // Date here (not an ISO string) so this covers the real runtime type.
        // Regression guard: stableStringify must serialize it to the ISO
        // string in the signed message, not the empty object {}.
        expires_at: new Date('2026-05-10T20:00:00.000Z'),
        amount_raw: '20000', // NOT NULL in the real schema; read by the #716 guard
      }),
    )

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
        idempotencyKey: 'x402:test',
      },
    })

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body).toMatchObject({
      payment_id: PAYMENT_ID,
      status: 'pending_signature',
      chain_id: 8453,
      to: AGENT.delegate_address.toLowerCase(),
      merchant_to: MERCHANT.toLowerCase(),
      x402_expected_auth: {
        version: 1,
        message: expect.stringContaining('Haven x402 expected context v1'),
        signature: expect.stringMatching(/^0x[0-9a-f]{130}$/i),
        signer: expect.stringMatching(/^0x[0-9a-f]{40}$/i),
      },
      sign_data: {
        hash: SIGN_HASH,
        components: {
          safe: AGENT.safe_address,
          token: USDC,
          to: AGENT.delegate_address.toLowerCase(),
          amount: '20000',
          nonce: 7,
        },
      },
    })
    expect(body.x402_expected_auth.message).toContain('"expiresAt":"2026-05-10T20:00:00.000Z"')

    expect(allowanceMocks.generateTransferHash).toHaveBeenCalledWith(
      8453,
      AGENT.safe_address,
      USDC,
      AGENT.delegate_address,
      20000n,
      '0x0000000000000000000000000000000000000000',
      0n,
      7,
    )

    // The write carries the merchant and idempotency identity — HANDLER
    // concern (which write was requested); column presence and ON CONFLICT
    // semantics are the repository's, proven on the real harness.
    const insert = findCall(/INSERT INTO payment_intents/)
    expect(insert).toBeDefined()
    expect(insert!.params).toContain(MERCHANT.toLowerCase())
    expect(insert!.params).toContain('x402:test')
  })

  it('executes at the exact allowance boundary (amount == remaining, zero delegate balance)', async () => {
    // Boundary regression guard for the balance-aware coverage decision: with a
    // zero delegate balance, totalCoverage == remaining, so amount == remaining
    // sits exactly on the inclusive edge — it must execute, not 422 (insufficient)
    // or 202 (queue). A `>=` slip in decideCoverage would break precisely here.
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 7 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 20_000n })
    allowanceMocks.getTokenBalance.mockResolvedValueOnce(0n)
    allowanceMocks.generateTransferHash.mockResolvedValueOnce(SIGN_HASH)

    primeDb(AUTH, ...POLICY_ROUTES, insertIntent({ id: PAYMENT_ID, expires_at: new Date('2026-05-10T20:00:00.000Z'), amount_raw: '20000' }))

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
        idempotencyKey: 'x402:boundary',
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({ status: 'pending_signature' })
    expect(allowanceMocks.generateTransferHash).toHaveBeenCalledWith(
      8453, AGENT.safe_address, USDC, AGENT.delegate_address, 20000n,
      '0x0000000000000000000000000000000000000000', 0n, 7,
    )
  })

  it('records one-shot x402 signatures without marking the payment submitted before execution', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 7 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 1_000_000n })
    allowanceMocks.generateTransferHash.mockResolvedValueOnce(SIGN_HASH)
    allowanceMocks.recoverSigner.mockReturnValueOnce(AGENT.delegate_address)
    allowanceMocks.executeAllowanceTransfer.mockResolvedValueOnce({ txHash: TX_HASH })
    fiatMocks.getFiatValuesForTokenAmount.mockResolvedValueOnce({ usd: 0.02, eur: 0.02 })
    evidenceMocks.tryRecordMachinePaymentEvidenceBaseById.mockResolvedValueOnce(undefined)

    primeDb(
      AUTH,
      ...POLICY_ROUTES,
      insertIntent(pendingX402Intent()),
      recordSignature(true),
      confirm(true),
    )

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
        idempotencyKey: 'x402:test',
        signature: '0xsig',
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      success: true,
      payment_id: PAYMENT_ID,
      status: 'confirmed',
      tx_hash: TX_HASH,
    })

    // The one-shot ordering invariant: the signature is durably recorded
    // BEFORE on-chain execution runs, so a crash mid-flight cannot strand
    // the intent (see the route's comment on why status never flips to
    // 'submitted' here). What the guarded UPDATE's WHERE clause enforces is
    // proven in x402-authorizations.test.ts; the property this test owns is
    // ordering and the exact values written.
    const signatureUpdate = findCall(/SET signature = \$1, signed_at = NOW\(\)/)
    expect(signatureUpdate).toBeDefined()
    expect(signatureUpdate!.params).toEqual(['0xsig', PAYMENT_ID, AGENT.id])
    const signatureCallIndex = mockQuery.mock.calls.findIndex(([sql]) =>
      typeof sql === 'string' && /SET signature = \$1, signed_at = NOW\(\)/.test(sql),
    )
    const executionOrder = allowanceMocks.executeAllowanceTransfer.mock.invocationCallOrder[0]
    expect(mockQuery.mock.invocationCallOrder[signatureCallIndex]).toBeLessThan(executionOrder)

    const confirmedUpdate = findCall(/SET status = 'confirmed'/)
    expect(confirmedUpdate!.params).toEqual([TX_HASH, PAYMENT_ID, 0.02, 0.02, AGENT.id])
    expect(evidenceMocks.tryRecordMachinePaymentEvidenceBaseById).toHaveBeenCalledWith(
      PAYMENT_ID,
      AGENT.id,
      expect.anything(),
    )
  })

  // #716 (epic #713): the funding leg must move EXACTLY the challenge amount —
  // no padding or buffer may sneak between the request, the stored intent, and
  // the on-chain transfer.
  it('funds the delegate with EXACTLY the challenge amount (#716 invariant)', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 7 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 1_000_000n })
    allowanceMocks.generateTransferHash.mockResolvedValueOnce(SIGN_HASH)
    allowanceMocks.recoverSigner.mockReturnValueOnce(AGENT.delegate_address)
    allowanceMocks.executeAllowanceTransfer.mockResolvedValueOnce({ txHash: TX_HASH })
    fiatMocks.getFiatValuesForTokenAmount.mockResolvedValueOnce({ usd: 0.02, eur: 0.02 })
    evidenceMocks.tryRecordMachinePaymentEvidenceBaseById.mockResolvedValueOnce(undefined)

    primeDb(
      AUTH,
      ...POLICY_ROUTES,
      insertIntent(pendingX402Intent()),
      recordSignature(true),
      confirm(true),
    )

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
        idempotencyKey: 'x402:test',
        signature: '0xsig',
      },
    })

    expect(response.statusCode).toBe(201)
    // The hash the delegate signs and the executed transfer both carry the
    // exact atomic amount from the challenge:
    expect(allowanceMocks.generateTransferHash.mock.calls[0][4]).toBe(20000n)
    expect(allowanceMocks.executeAllowanceTransfer.mock.calls[0][4]).toBe(20000n)
    // The stored intent records the same number:
    const insert = findCall(/INSERT INTO payment_intents/)
    expect(insert!.params).toContain('20000')
  })

  it('rejects an idempotency replay whose amount differs from the stored intent (#716 guard)', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 7 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 1_000_000n })
    allowanceMocks.generateTransferHash.mockResolvedValueOnce(SIGN_HASH)

    primeDb(
      AUTH,
      ...POLICY_ROUTES,
      insertIntent(null), // the INSERT lost the idempotency race
      activeReload(pendingX402Intent()), // reload: stored amount 20000
    )

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '30000', // != stored 20000
        asset: USDC,
        network: 'base',
        idempotencyKey: 'x402:test',
        signature: '0xsig',
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toContain('stored 20000, requested 30000')
    expect(allowanceMocks.executeAllowanceTransfer).not.toHaveBeenCalled()
  })

  it('does not overwrite one-shot x402 terminal state after execution failures', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 7 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 1_000_000n })
    allowanceMocks.generateTransferHash.mockResolvedValueOnce(SIGN_HASH)
    allowanceMocks.recoverSigner.mockReturnValueOnce(AGENT.delegate_address)
    allowanceMocks.executeAllowanceTransfer.mockRejectedValueOnce(new Error('relayer unavailable'))

    primeDb(
      AUTH,
      ...POLICY_ROUTES,
      insertIntent(pendingX402Intent()),
      recordSignature(true),
    )

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
        idempotencyKey: 'x402:test',
        signature: '0xsig',
      },
    })

    expect(response.statusCode).toBe(502)
    expect(response.json()).toMatchObject({
      payment_id: PAYMENT_ID,
      status: 'failed',
      error: 'On-chain execution failed',
    })

    const failedUpdate = findCall(/SET status = 'failed'/)
    expect(failedUpdate!.params).toEqual(['relayer unavailable', PAYMENT_ID, AGENT.id])
    expect(evidenceMocks.tryRecordMachinePaymentEvidenceBaseById).not.toHaveBeenCalled()
  })

  it('does not record x402 evidence when a one-shot confirmation loses a terminal-state race', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 7 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 1_000_000n })
    allowanceMocks.generateTransferHash.mockResolvedValueOnce(SIGN_HASH)
    allowanceMocks.recoverSigner.mockReturnValueOnce(AGENT.delegate_address)
    allowanceMocks.executeAllowanceTransfer.mockResolvedValueOnce({ txHash: TX_HASH })
    fiatMocks.getFiatValuesForTokenAmount.mockResolvedValueOnce({ usd: 0.02, eur: 0.02 })

    primeDb(
      AUTH,
      ...POLICY_ROUTES,
      insertIntent(pendingX402Intent()),
      recordSignature(true),
      confirm(false), // lost the terminal-state race
      intentStatus('confirmed'),
    )

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
        idempotencyKey: 'x402:test',
        signature: '0xsig',
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({
      payment_id: PAYMENT_ID,
      status: 'confirmed',
      error: 'Payment intent changed after on-chain execution',
    })
    expect(allowanceMocks.executeAllowanceTransfer).toHaveBeenCalledOnce()
    expect(evidenceMocks.tryRecordMachinePaymentEvidenceBaseById).not.toHaveBeenCalled()
  })

  it('rejects payment requirements whose network does not match the agent chain', async () => {
    primeDb(AUTH)

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        amount: '20000',
        asset: USDC,
        network: 'eip155:100',
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('x402 network eip155:100 does not match agent chain 8453')
    expect(allowanceMocks.generateTransferHash).not.toHaveBeenCalled()
  })

  it('rejects a malformed payTo address with 400 (address-validation guard)', async () => {
    primeDb(AUTH)

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: 'not-an-address',
        amount: '20000',
        asset: USDC,
        network: 'base',
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('Valid payTo address is required')
    expect(allowanceMocks.generateTransferHash).not.toHaveBeenCalled()
  })

  it('rejects a malformed merchantPayTo address with 400', async () => {
    primeDb(AUTH)

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: '0xbad',
        amount: '20000',
        asset: USDC,
        network: 'base',
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('Valid merchantPayTo address is required')
    expect(allowanceMocks.generateTransferHash).not.toHaveBeenCalled()
  })

  it('rejects malformed decimal atomic amounts before allowance checks', async () => {
    primeDb(AUTH)
    const malformedAmounts = [
      '0x4e20',
      '1e6',
      '+20000',
      '-1',
      ' 20000',
      '20000 ',
      '0',
    ]

    for (const amount of malformedAmounts) {
      const response = await app.inject({
        method: 'POST',
        url: '/x402',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: {
          url: 'https://mcp.soundside.ai/mcp',
          payTo: AGENT.delegate_address,
          amount,
          asset: USDC,
          network: 'base',
        },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe(
        'Invalid amount — must be a positive decimal integer in atomic units',
      )
    }

    const blankResponse = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        amount: '',
        asset: USDC,
        network: 'base',
      },
    })

    expect(blankResponse.statusCode).toBe(400)
    expect(blankResponse.json().error).toBe('Amount (atomic units) is required')
    expect(allowanceMocks.getTokenAllowance).not.toHaveBeenCalled()
    expect(allowanceMocks.generateTransferHash).not.toHaveBeenCalled()
    // Every rejected request only ever reached auth — none of the malformed
    // amounts triggered any further query.
    expect(sqlCalls().every((c) => /api_key_hash = \$1/.test(c.sql))).toBe(true)
  })

  it('returns an existing pending signature intent for duplicate idempotency keys', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 7 })

    primeDb(
      AUTH,
      [/status <> 'failed'/, () => ({ rows: [pendingX402Intent()] })],
      refresh(null), // guard doesn't fire: same nonce, still within expiry
    )

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
        idempotencyKey: 'x402:test',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      payment_id: PAYMENT_ID,
      status: 'pending_signature',
      to: AGENT.delegate_address.toLowerCase(),
      merchant_to: MERCHANT.toLowerCase(),
      sign_data: { hash: SIGN_HASH },
    })
    expect(allowanceMocks.generateTransferHash).not.toHaveBeenCalled()
  })

  it('refreshes an expired duplicate pending x402 intent for the same idempotency key', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 7 })

    primeDb(
      AUTH,
      [/status <> 'failed'/, () => ({
        rows: [pendingX402Intent({
          status: 'expired',
          machine_metadata: JSON.stringify({
            protocol: 'x402',
            network: 'base',
            category: null,
            description: null,
          }),
        })],
      })],
      refresh({
        id: PAYMENT_ID,
        status: 'pending_signature',
        sign_hash: SIGN_HASH,
        allowance_nonce: 7,
        expires_at: '2026-05-10T20:10:00.000Z',
      }),
    )

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
        idempotencyKey: 'x402:test',
      },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.status).toBe('pending_signature')
    expect(body.expires_at).toBe('2026-05-10T20:10:00.000Z')
    expect(body.x402_expected_auth.message).toContain('"expiresAt":"2026-05-10T20:10:00.000Z"')
    expect(body.sign_data).toMatchObject({
      hash: SIGN_HASH,
      components: { nonce: 7 },
    })
    expect(allowanceMocks.generateTransferHash).not.toHaveBeenCalled()
    // The refresh write was requested — its guard conditions are proven on
    // the real harness (x402-authorizations.test.ts).
    expect(findCall(/SET allowance_nonce = \$1/)).toBeDefined()
  })

  it('refreshes stale sign data when a duplicate pending intent has an old allowance nonce', async () => {
    const refreshedHash = `0x${'22'.repeat(32)}`
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 8 })
    allowanceMocks.generateTransferHash.mockResolvedValueOnce(refreshedHash)

    primeDb(
      AUTH,
      [/status <> 'failed'/, () => ({ rows: [pendingX402Intent()] })], // stored nonce 7
      refresh({
        id: PAYMENT_ID,
        status: 'pending_signature',
        sign_hash: refreshedHash,
        allowance_nonce: 8,
        expires_at: '2026-05-10T20:10:00.000Z',
      }),
    )

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
        idempotencyKey: 'x402:test',
      },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.expires_at).toBe('2026-05-10T20:10:00.000Z')
    expect(body.x402_expected_auth.message).toContain('"expiresAt":"2026-05-10T20:10:00.000Z"')
    expect(body.sign_data).toMatchObject({
      hash: refreshedHash,
      components: { nonce: 8 },
    })
    expect(allowanceMocks.generateTransferHash).toHaveBeenCalledWith(
      8453,
      AGENT.safe_address,
      USDC,
      AGENT.delegate_address.toLowerCase(),
      20000n,
      '0x0000000000000000000000000000000000000000',
      0n,
      8,
    )
    const refresh_ = findCall(/SET allowance_nonce = \$1/)
    expect(refresh_!.params).toEqual([8, refreshedHash, PAYMENT_ID, AGENT.id])
  })

  it('reloads rail-scoped existing x402 intents after insert idempotency conflicts', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 7 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 1_000_000n })
    allowanceMocks.generateTransferHash.mockResolvedValueOnce(SIGN_HASH)

    primeDb(
      AUTH,
      ...POLICY_ROUTES,
      insertIntent(null),
      activeReload(pendingX402Intent()),
    )

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
        idempotencyKey: 'x402:test',
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      payment_id: PAYMENT_ID,
      status: 'pending_signature',
      sign_data: { hash: SIGN_HASH },
    })
  })

  it('queues over-allowance x402 payments once with rail metadata', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 7 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 10_000n })
    // Delegate already holds enough to satisfy the shortfall after the
    // top-up, so the pre-flight insufficient-funds check passes and we
    // fall through into the existing over-budget approval-queue path.
    allowanceMocks.getTokenBalance.mockResolvedValueOnce(20_000n)

    primeDb(
      AUTH,
      ...POLICY_ROUTES,
      insertApproval(x402ApprovalRow({ id: 'approval-123', machine_challenge_id: null })),
    )

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
        category: 'data',
        idempotencyKey: 'x402:approval',
      },
    })

    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({
      payment_id: 'approval-123',
      status: 'pending_approval',
      phase: 'user_approval_required',
      next_action: 'wait_for_user_approval',
      remaining: '0.01',
      requested: '0.02',
      token: 'USDC',
      rail: 'x402',
      resource_url: 'https://mcp.soundside.ai/mcp',
      merchant_address: MERCHANT.toLowerCase(),
      chain_id: 8453,
      amount_atomic: '20000',
      asset: USDC,
      network: 'base',
      idempotency_key: 'x402:approval',
      challenge_id: null,
      x402: {
        amount_atomic: '20000',
        asset: USDC,
        network: 'base',
        resource_url: 'https://mcp.soundside.ai/mcp',
        merchant_address: MERCHANT.toLowerCase(),
        idempotency_key: 'x402:approval',
      },
    })

    const insert = findCall(/INSERT INTO approval_requests/)
    expect(insert!.params).toContain('https://mcp.soundside.ai/mcp')
    expect(insert!.params).toContain(MERCHANT.toLowerCase())
    expect(insert!.params).toContain('x402:approval')
    // The request's category must be threaded into machine_metadata — this is
    // the handler's mapping, not the database's, so it is proven here.
    expect(insert!.params).toContain(
      JSON.stringify({ protocol: 'x402', network: 'base', category: 'data', description: null })
    )
  })

  it('returns 422 insufficient_funds when delegate balance + remaining allowance cannot cover the amount', async () => {
    // Regression test for the agent-feedback-driven pre-flight check. Before
    // the check existed, this case would proceed all the way to sign_data
    // generation and then fail on-chain at executeAllowanceTransfer, leaving
    // the agent in a dead-end "signed but won't settle" state. The new
    // pre-flight fails fast with a structured error the agent can act on
    // (next_action=fund_safe_or_raise_allowance).
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 7 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 5_000n })
    allowanceMocks.getTokenBalance.mockResolvedValueOnce(0n)

    primeDb(AUTH, ...POLICY_ROUTES)

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
        idempotencyKey: 'x402:insufficient',
      },
    })

    expect(response.statusCode).toBe(422)
    const body = response.json()
    expect(body).toMatchObject({
      error_code: 'insufficient_funds',
      phase: 'insufficient_funds',
      next_action: 'fund_safe_or_raise_allowance',
      rail: 'x402',
      chain_id: 8453,
      token: 'USDC',
      asset: USDC,
      network: 'base',
      amount: '0.02',
      amount_atomic: '20000',
      delegate_balance: '0.0',
      delegate_balance_atomic: '0',
      remaining_allowance: '0.005',
      remaining_allowance_atomic: '5000',
      shortfall: '0.015',
      shortfall_atomic: '15000',
      resource_url: 'https://mcp.soundside.ai/mcp',
      merchant_address: MERCHANT.toLowerCase(),
    })
    // Delegate / Safe addresses must NOT be echoed back. Agents already know
    // both from the credential they hold; surfacing them in a structured
    // pre-flight error widens the surveillance surface for the hot-wallet
    // delegate EOA for no agent-side benefit.
    expect(body).not.toHaveProperty('delegate_address')
    expect(body).not.toHaveProperty('safe_address')
    expect(body.error).toMatch(/Insufficient funds/i)
    expect(body.error).toContain('USDC')

    // Critical: no payment intent or approval row was written. The pre-flight
    // must short-circuit BEFORE any state-creating DB write — the user can
    // retry after funding without an idempotency conflict.
    expect(sqlCalls().some((c) => /INSERT INTO (payment_intents|approval_requests)/.test(c.sql))).toBe(false)

    // The pre-flight read happened on the (chain, delegate, token) tuple
    // before the over-budget approval-queue path would have run.
    expect(allowanceMocks.getTokenBalance).toHaveBeenCalledWith(
      AGENT.chain_id,
      AGENT.delegate_address,
      USDC,
    )
  })

  it('returns 422 insufficient_funds when delegate balance + remaining is just short of the amount', async () => {
    // Boundary case: cover = amount - 1. The check must reject (strict >),
    // not silently round to "close enough", or merchant settlement would
    // revert downstream.
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 7 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 10_000n })
    allowanceMocks.getTokenBalance.mockResolvedValueOnce(9_999n)

    primeDb(AUTH, ...POLICY_ROUTES)

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
        idempotencyKey: 'x402:boundary',
      },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({
      error_code: 'insufficient_funds',
      shortfall_atomic: '1',
    })
  })

  it('falls through pre-flight when delegate balance covers the allowance gap', async () => {
    // Regression guard: if the delegate already holds enough of the token to
    // settle the merchant payment, even a zero remaining allowance must NOT
    // fire the insufficient-funds short-circuit on its own. The over-budget
    // approval-queue path (or the happy-path sign step) is what should run.
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 7 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 0n })
    allowanceMocks.getTokenBalance.mockResolvedValueOnce(50_000n)

    primeDb(
      AUTH,
      ...POLICY_ROUTES,
      insertApproval(x402ApprovalRow({ id: 'approval-balance-only', machine_challenge_id: null })),
    )

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
        idempotencyKey: 'x402:balance-only',
      },
    })

    // The existing over-budget logic still treats remaining<amount as
    // approval-required (queues for user approval). The pre-flight check is
    // narrower than that: it only short-circuits the unrecoverable case.
    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({
      payment_id: 'approval-balance-only',
      status: 'pending_approval',
    })
  })

  it('returns 502 when the delegate balance read itself fails (RPC outage)', async () => {
    // Make sure a transient RPC failure on the balance read surfaces as a
    // distinct 502 from the allowance-read failure — agents and dashboards
    // distinguishing the two read paths can pick the right retry strategy.
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 7 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 1_000_000n })
    allowanceMocks.getTokenBalance.mockRejectedValueOnce(new Error('rpc timeout'))

    primeDb(AUTH, ...POLICY_ROUTES)

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
        idempotencyKey: 'x402:rpc-outage',
      },
    })

    expect(response.statusCode).toBe(502)
    expect(response.json().error).toBe('Failed to read delegate token balance')
  })

  it('returns an existing pending approval for duplicate over-allowance idempotency keys', async () => {
    primeDb(
      AUTH,
      [/status <> 'failed'/, () => ({ rows: [] })],
      approvalRoute(x402ApprovalRow()),
    )

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
        idempotencyKey: 'x402:approval',
      },
    })

    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({
      payment_id: 'approval-123',
      kind: 'approval_request',
      status: 'pending',
      phase: 'user_approval_required',
      next_action: 'wait_for_user_approval',
      amount: '0.02',
      token: 'USDC',
      rail: 'x402',
      resource_url: 'https://mcp.soundside.ai/mcp',
      merchant_address: MERCHANT.toLowerCase(),
      amount_atomic: '20000',
      asset: USDC,
      network: 'base',
      idempotency_key: 'x402:approval',
      x402: {
        amount_atomic: '20000',
        asset: USDC,
        network: 'base',
        resource_url: 'https://mcp.soundside.ai/mcp',
        merchant_address: MERCHANT.toLowerCase(),
        idempotency_key: 'x402:approval',
      },
    })
    // Confirms the short-circuit happened BEFORE any allowance read.
    expect(allowanceMocks.getTokenAllowance).not.toHaveBeenCalled()
  })

  it('returns executed approvals as ready for the original x402 retry', async () => {
    primeDb(
      AUTH,
      [/status <> 'failed'/, () => ({ rows: [] })],
      approvalRoute(x402ApprovalRow({ status: 'executed', tx_hash: `0x${'ab'.repeat(32)}` })),
    )

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
        idempotencyKey: 'x402:approval',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      payment_id: 'approval-123',
      kind: 'approval_request',
      status: 'executed',
      phase: 'funding_sent',
      next_action: 'retry_original_x402_request',
      rail: 'x402',
      resource_url: 'https://mcp.soundside.ai/mcp',
      merchant_address: MERCHANT.toLowerCase(),
      amount_atomic: '20000',
      asset: USDC,
      network: 'base',
      idempotency_key: 'x402:approval',
    })
    expect(allowanceMocks.getTokenAllowance).not.toHaveBeenCalled()
  })

  it('returns the existing approval when an over-allowance insert hits an idempotency conflict', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 7 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 10_000n })
    // Delegate balance covers the shortfall so the pre-flight check passes
    // and we exercise the over-budget idempotency-conflict path.
    allowanceMocks.getTokenBalance.mockResolvedValueOnce(20_000n)

    // The idempotency-key approval lookup runs the SAME statement twice:
    // once up front (a fresh key — nothing found) and again after the
    // INSERT ... ON CONFLICT DO NOTHING loses the race. A stateful counter
    // is the only way a content-dispatch stub can answer one statement
    // differently across its two calls; the ON CONFLICT semantics
    // themselves are the repository's to prove.
    let approvalReads = 0
    primeDb(
      AUTH,
      [/status <> 'failed'/, () => ({ rows: [] })],
      [/FROM approval_requests/, () => {
        approvalReads += 1
        return { rows: approvalReads > 1 ? [x402ApprovalRow()] : [] }
      }],
      ...POLICY_ROUTES,
      insertApproval(null),
    )

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
        idempotencyKey: 'x402:approval',
      },
    })

    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({
      payment_id: 'approval-123',
      status: 'pending_approval',
      remaining: '0.01',
      rail: 'x402',
      resource_url: 'https://mcp.soundside.ai/mcp',
      merchant_address: MERCHANT.toLowerCase(),
      amount_atomic: '20000',
      asset: USDC,
      network: 'base',
      idempotency_key: 'x402:approval',
    })
    expect(approvalReads).toBe(2)
  })
})
