import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import x402Routes from '../x402.js'
import { allowanceModuleRailRetired } from '../../rails/execution-rail.js'

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

// Most of the cases below characterize `runLegacyAuthorize`, the legacy
// Safe/AllowanceModule x402 funding leg. That rail is retired by #1986
// (epic #1440 slice 3): `AGENT` here carries no `execution_rail`, which
// resolves through the LEFT-JOIN `null` fall-through to `retired_allowance`,
// so every one of those cases now gets HTTP 410 fail-closed, nothing written,
// before `runLegacyAuthorize` (or the delegation branch) ever runs. Converted
// in place rather than deleted, per #1986; `modules/x402/legacy-authorize.ts`
// and these cases are scheduled for deletion in #1987.
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

  it('leaves the retired Haven-as-merchant resource surface as ordinary 404s (#2257)', async () => {
    const retiredRoutes = [
      { method: 'POST' as const, url: '/x402/resources' },
      { method: 'GET' as const, url: '/x402/resources' },
      { method: 'DELETE' as const, url: '/x402/resources/11111111-1111-1111-1111-111111111111' },
      { method: 'GET' as const, url: '/x402/receipts' },
      { method: 'GET' as const, url: '/x402/resources/11111111-1111-1111-1111-111111111111/challenge' },
      { method: 'POST' as const, url: '/x402/resources/11111111-1111-1111-1111-111111111111/verify' },
    ]

    for (const route of retiredRoutes) {
      const response = await app.inject(route)
      expect(response.statusCode, `${route.method} ${route.url}`).toBe(404)
      expect(response.json()).toMatchObject({ statusCode: 404 })
    }
  })

  // #2245 (was: "rejects settlementScheme erc7710 on the legacy rail — 3009
  // only there (#946)"). The #946 guard ran ABOVE the rail resolution, so this
  // request used to get a 400 saying "the legacy AllowanceModule rail settles
  // via EIP-3009 only" — a retired rail being told it settles, and one
  // optional request field deciding WHICH refusal the account saw. #946's
  // "fail loudly" rationale predates #1986: the loud failure is now the 410,
  // and it is the accurate one. Same expectation, opposite direction — the
  // scheme field must make NO difference to a retired-rail account.
  it('a legacy-rail account asking erc7710 gets the #1986 410, not a scheme 400 (#2245)', async () => {
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
    expect(response.statusCode).toBe(410)
    expect(response.json().error).toBe(allowanceModuleRailRetired('account').body.error)
    // The specific sentence that used to come back, gone: a payment route must
    // not tell a retired-rail caller that its rail settles.
    expect(JSON.stringify(response.json())).not.toContain('EIP-3009')
    expect(JSON.stringify(response.json())).not.toContain('delegation-rail account')
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
  // #2245, the #1058 half of the same defect — see the note on the erc7710
  // case above.
  it('a legacy-rail account sending facilitatorAddresses gets the #1986 410, not a scheme 400 (#2245)', async () => {
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
    expect(response.statusCode).toBe(410)
    expect(response.json().error).toBe(allowanceModuleRailRetired('account').body.error)
    expect(JSON.stringify(response.json())).not.toContain('delegation-rail account')
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
        // #1360: the SDK now always declares the funding-leg scheme. On the
        // legacy rail the field is accepted and ignored — this test carrying
        // it pins that new-SDK-vs-legacy-account compatibility.
        settlementScheme: 'eip3009',
      },
    })

    // #1986: the legacy AllowanceModule x402 flow is retired — the account
    // never reaches funding-intent creation, and nothing about the merchant
    // or the sign-hash gets computed or written.
    expect(response.statusCode).toBe(410)
    expect(response.json().error).toBe(allowanceModuleRailRetired('account').body.error)

    expect(allowanceMocks.generateTransferHash).not.toHaveBeenCalled()

    // No intent row was written for a rail that is gone.
    const insert = findCall(/INSERT INTO payment_intents/)
    expect(insert).toBeUndefined()
  })

  it('persists mcpCallContext into the legacy-rail intent metadata (#1307 write path)', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValue({ nonce: 7 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 1_000_000n })
    allowanceMocks.generateTransferHash.mockResolvedValue(SIGN_HASH)

    primeDb(
      AUTH,
      ...POLICY_ROUTES,
      insertIntent({
        id: PAYMENT_ID,
        expires_at: new Date('2026-05-10T20:00:00.000Z'),
        amount_raw: '20000',
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
        idempotencyKey: 'x402:ctx',
        mcpCallContext: {
          merchantUrl: 'https://mcp.soundside.ai/mcp',
          toolName: 'buy_track',
          arguments: { id: '42' },
        },
      },
    })

    // #1986: the legacy write branch this pinned no longer runs — the
    // account is refused before mcpCallContext is ever persisted anywhere.
    expect(response.statusCode).toBe(410)
    expect(response.json().error).toBe(allowanceModuleRailRetired('account').body.error)
    const insert = findCall(/INSERT INTO payment_intents/)
    expect(insert).toBeUndefined()
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

    // #1986: the allowance-boundary arithmetic this pinned never runs — the
    // account is refused fail-closed before any coverage decision is made.
    expect(response.statusCode).toBe(410)
    expect(response.json().error).toBe(allowanceModuleRailRetired('account').body.error)
    expect(allowanceMocks.generateTransferHash).not.toHaveBeenCalled()
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

    // #1986: the one-shot sign-then-execute ordering this pinned never runs —
    // fail-closed refuses the account before the signature is ever recorded,
    // so no ordering guarantee is even meaningful here anymore.
    expect(response.statusCode).toBe(410)
    expect(response.json().error).toBe(allowanceModuleRailRetired('account').body.error)

    const signatureUpdate = findCall(/SET signature = \$1, signed_at = NOW\(\)/)
    expect(signatureUpdate).toBeUndefined()
    expect(allowanceMocks.executeAllowanceTransfer).not.toHaveBeenCalled()

    const confirmedUpdate = findCall(/SET status = 'confirmed'/)
    expect(confirmedUpdate).toBeUndefined()
    expect(evidenceMocks.tryRecordMachinePaymentEvidenceBaseById).not.toHaveBeenCalled()
  })

  // #716 (epic #713) characterized the funding leg moving EXACTLY the
  // challenge amount — no padding or buffer between the request, the stored
  // intent, and the on-chain transfer. #1986 retires the funding leg itself:
  // the invariant is now strictly stronger — the delegate is never funded at
  // all, for any amount, on this rail.
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

    expect(response.statusCode).toBe(410)
    expect(response.json().error).toBe(allowanceModuleRailRetired('account').body.error)
    // The delegate is never funded at all — no hash generated, no transfer
    // executed, for any amount, on the retired rail.
    expect(allowanceMocks.generateTransferHash).not.toHaveBeenCalled()
    expect(allowanceMocks.executeAllowanceTransfer).not.toHaveBeenCalled()
    // No intent row was written either.
    const insert = findCall(/INSERT INTO payment_intents/)
    expect(insert).toBeUndefined()
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

    // #1986: the mismatched-replay 409 this guard characterized never fires —
    // fail-closed refuses the account before the stored intent is ever
    // reloaded or compared. Same refusal reached from different setup, which
    // is what fail-closed means.
    expect(response.statusCode).toBe(410)
    expect(response.json().error).toBe(allowanceModuleRailRetired('account').body.error)
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

    // #1986: the relayer failure this pinned never has a chance to happen —
    // the account is refused before execution is attempted at all, so no
    // intent ever reaches (or needs) a terminal 'failed' state.
    expect(response.statusCode).toBe(410)
    expect(response.json().error).toBe(allowanceModuleRailRetired('account').body.error)

    const failedUpdate = findCall(/SET status = 'failed'/)
    expect(failedUpdate).toBeUndefined()
    expect(allowanceMocks.executeAllowanceTransfer).not.toHaveBeenCalled()
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

    // #1986: the terminal-state race this pinned can no longer happen — the
    // account is refused before execution runs, so `executeAllowanceTransfer`
    // is never called at all (strictly stronger than "called once").
    expect(response.statusCode).toBe(410)
    expect(response.json()).toMatchObject({
      error: allowanceModuleRailRetired('account').body.error,
    })
    expect(allowanceMocks.executeAllowanceTransfer).not.toHaveBeenCalled()
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

    // #1986: the duplicate-idempotency-key reuse this pinned never runs — the
    // stored pending intent is never even looked up, because fail-closed
    // refuses the account first.
    expect(response.statusCode).toBe(410)
    expect(response.json().error).toBe(allowanceModuleRailRetired('account').body.error)
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

    // #1986: the expired-intent refresh this pinned never runs — the account
    // is refused fail-closed before the expired pending intent is even
    // looked up, so no refresh write is ever requested.
    expect(response.statusCode).toBe(410)
    expect(response.json().error).toBe(allowanceModuleRailRetired('account').body.error)
    expect(allowanceMocks.generateTransferHash).not.toHaveBeenCalled()
    expect(findCall(/SET allowance_nonce = \$1/)).toBeUndefined()
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

    // #1986: the stale-nonce sign-data refresh this pinned never runs — the
    // account is refused before the duplicate intent's nonce is even
    // compared, so no refreshed hash is ever generated or written.
    expect(response.statusCode).toBe(410)
    expect(response.json().error).toBe(allowanceModuleRailRetired('account').body.error)
    expect(allowanceMocks.generateTransferHash).not.toHaveBeenCalled()
    expect(findCall(/SET allowance_nonce = \$1/)).toBeUndefined()
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

    // #1986: the insert-conflict reload this pinned never runs — the account
    // is refused before the payment_intents INSERT is ever attempted, so
    // there is no conflict to reload from.
    expect(response.statusCode).toBe(410)
    expect(response.json().error).toBe(allowanceModuleRailRetired('account').body.error)
    expect(findCall(/INSERT INTO payment_intents/)).toBeUndefined()
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

    // #1986: the over-allowance approval queue this pinned never gets a
    // chance to run — fail-closed refuses the account before the coverage
    // decision, so no approval_requests row is ever queued.
    expect(response.statusCode).toBe(410)
    expect(response.json().error).toBe(allowanceModuleRailRetired('account').body.error)

    const insert = findCall(/INSERT INTO approval_requests/)
    expect(insert).toBeUndefined()
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

    // #1986: the insufficient-funds pre-flight this pinned never runs — the
    // account is refused before the delegate-balance read the check depends
    // on, so this is now the SAME fail-closed refusal, reached from
    // different setup — that is what fail-closed means.
    expect(response.statusCode).toBe(410)
    const body = response.json()
    expect(body.error).toBe(allowanceModuleRailRetired('account').body.error)

    // Critical: no payment intent or approval row was written.
    expect(sqlCalls().some((c) => /INSERT INTO (payment_intents|approval_requests)/.test(c.sql))).toBe(false)

    // The pre-flight balance read never happens either — refused before it.
    expect(allowanceMocks.getTokenBalance).not.toHaveBeenCalled()
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

    // #1986: the strict-boundary shortfall arithmetic this pinned never runs
    // — the same fail-closed refusal fires first, from a different setup.
    expect(response.statusCode).toBe(410)
    expect(response.json().error).toBe(allowanceModuleRailRetired('account').body.error)
    expect(allowanceMocks.getTokenBalance).not.toHaveBeenCalled()
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

    // #1986: the "balance covers the gap" fall-through this pinned never
    // runs — the account is refused before the coverage decision, so no
    // approval row is ever queued regardless of how much the delegate holds.
    expect(response.statusCode).toBe(410)
    expect(response.json().error).toBe(allowanceModuleRailRetired('account').body.error)
    expect(findCall(/INSERT INTO approval_requests/)).toBeUndefined()
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

    // #1986: the RPC-outage 502 this pinned never fires — the account is
    // refused fail-closed before the delegate-balance read is even attempted.
    expect(response.statusCode).toBe(410)
    expect(response.json().error).toBe(allowanceModuleRailRetired('account').body.error)
    expect(allowanceMocks.getTokenBalance).not.toHaveBeenCalled()
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

    // #1986: the existing-pending-approval reuse this pinned never runs —
    // fail-closed refuses the account before the approval lookup even fires,
    // so the queued row (an artifact from before the rail was retired) is
    // never surfaced.
    expect(response.statusCode).toBe(410)
    expect(response.json().error).toBe(allowanceModuleRailRetired('account').body.error)
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

    // #1986: the "already executed, retry the original request" reply this
    // pinned never runs — fail-closed refuses the account before the
    // approval lookup, so an executed legacy approval can no longer be
    // surfaced through this entry point either.
    expect(response.statusCode).toBe(410)
    expect(response.json().error).toBe(allowanceModuleRailRetired('account').body.error)
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

    // #1986: the idempotency-conflict-reload race this pinned never runs —
    // fail-closed refuses the account before the approval lookup fires even
    // once, so the ON CONFLICT race it characterized cannot happen on the
    // retired rail.
    expect(response.statusCode).toBe(410)
    expect(response.json().error).toBe(allowanceModuleRailRetired('account').body.error)
    expect(approvalReads).toBe(0)
    expect(findCall(/INSERT INTO approval_requests/)).toBeUndefined()
  })
})
