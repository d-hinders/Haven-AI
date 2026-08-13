import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import machinePaymentRoutes from '../machine-payments.js'
import { authorizeMachinePayment } from '../../modules/mpp/index.js'

const { mockQuery, allowanceMocks, fiatMocks, reportingMocks } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  allowanceMocks: {
    getTokenAllowance: vi.fn(),
    getLatestBlockTimeSec: vi.fn(),
    computeEffectiveAllowance: vi.fn(),
    generateTransferHash: vi.fn(),
    recoverSigner: vi.fn(),
    executeAllowanceTransfer: vi.fn(),
  },
  fiatMocks: {
    getFiatValuesForTokenAmount: vi.fn(),
    getBookTimeSekValue: vi.fn().mockResolvedValue(null),
  },
  reportingMocks: {
    lateAttachMerchantReceipt: vi.fn().mockResolvedValue(undefined),
    // modules/mpp/evidence.ts's fire-and-forget feed hook — also part of the
    // modules/reporting/ barrel post-#998, so it needs a mock here too (an
    // unmocked call threw and 500'd the settle/evidence routes).
    feedSettledPaymentBestEffort: vi.fn(),
  },
}))

// #1196 wired the allowance-nonce coordinator into this path, so it now reads
// the shared watermark alongside its chain reads. It is fail-open and
// orthogonal to what these tests assert — stub the repository rather than
// answer its query through the content-dispatch stub below.
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

// Fee recording at settlement must not consume a mocked DB call in these
// sequence-based tests; neutralize it (the module is dark anyway).
vi.mock('../../modules/fee/index.js', () => ({
  quoteFee: () => ({ paymentId: '', rail: '', feeAtomic: 0n, feeToken: '', basisPoints: 0, isZero: true }),
  recordSettledFee: async () => {},
}))

// #956 late-attach: fire-and-forget, mocked so its own DB reads never
// interleave with these tests.
vi.mock('../../modules/reporting/index.js', () => reportingMocks)

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
const RECIPIENT = '0x15179876c595922999C2d5DC7c23Cc7711fE799a'
const SIGN_HASH = `0x${'11'.repeat(32)}`
const PAYMENT_ID = '33333333-3333-3333-3333-333333333333'
const TX_HASH = `0x${'ab'.repeat(32)}`

const challenge = {
  rail: 'mpp_demo',
  version: '2026-05-12',
  challengeId: 'challenge-123',
  resource: 'https://haven.example/demo/mpp/market-summary',
  description: 'Haven market summary demo',
  network: { chainId: 8453, name: 'base' },
  asset: { symbol: 'USDC', address: USDC, decimals: 6 },
  amount: { display: '0.01', atomic: '10000' },
  recipient: RECIPIENT,
  expiresAt: '2099-01-01T00:00:00.000Z',
  metadata: { demoResource: 'market-summary' },
}

function expectNoAuthorizationWork() {
  expect(allowanceMocks.getTokenAllowance).not.toHaveBeenCalled()
  expect(allowanceMocks.getLatestBlockTimeSec).not.toHaveBeenCalled()
  expect(allowanceMocks.computeEffectiveAllowance).not.toHaveBeenCalled()
  expect(allowanceMocks.generateTransferHash).not.toHaveBeenCalled()
  expect(allowanceMocks.recoverSigner).not.toHaveBeenCalled()
  expect(allowanceMocks.executeAllowanceTransfer).not.toHaveBeenCalled()
}

// ── Content-dispatch DB stub (#1226) ─────────────────────────────────────────
//
// Routes match on SQL FRAGMENTS, first hit wins, anything unmatched returns
// zero rows. This replaces the positional mockResolvedValueOnce chains that
// re-shuffled whenever a handler gained a query (#775) — what the database
// DOES with these statements is proven in the repository suites on the real
// harness (payment-intents.test.ts, approval-requests.test.ts et al., epic
// #1219); these tests own only the handler: status codes, response shapes,
// and which writes were requested.

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
/** Auth lookup answered with an overridden agent row (rail refusals, characterization). */
const authAs = (row: Record<string, unknown>): DbRoute => [/api_key_hash = \$1/, () => ({ rows: [row] })]

/** authorizeMachinePayment: loadExecutionRailState found nothing → legacy rail. */
const RAIL_LEGACY: DbRoute = [/FROM agents a/, () => ({ rows: [] })]
/** authorizeMachinePayment: loadExecutionRailState resolves the delegation rail. */
const RAIL_DELEGATION: DbRoute = [/FROM agents a/, () => ({ rows: [{ execution_rail: 'delegation' }] })]

/** hasTokenAllowanceConfigured (send + authorize policy gate). */
const allowanceConfigured = (configured: boolean): DbRoute => [
  /LOWER\(token_address\) = LOWER\(\$2\)/,
  () => ({ rows: configured ? [{ allowance_amount: '10000' }] : [] }),
]

/** listAllowanceConfigForAgent (GET /allowances, legacy rail). */
const allowanceConfigRows = (rows: unknown[]): DbRoute => [
  /FROM agent_allowances\s+WHERE agent_id = \$1\s+ORDER BY created_at ASC/,
  () => ({ rows }),
]

/** deriveDelegationBudgets / listDelegationJsonByIds (GET /allowances, delegation rail). */
const delegationRows = (rows: unknown[]): DbRoute => [/FROM agent_delegations/, () => ({ rows })]

/** findMachineIntentByKeyOrChallenge — the authorize idempotency lookup. */
const existingIntent = (row: Record<string, unknown> | null): DbRoute => [
  /COALESCE\(payment_rail, source\) = \$4/,
  () => ({ rows: row ? [row] : [] }),
]
/** findMachineApprovalByKeyOrChallenge — the authorize idempotency lookup. */
const existingApproval = (row: Record<string, unknown> | null): DbRoute => [
  /status <> 'expired'/,
  () => ({ rows: row ? [row] : [] }),
]
/** INSERT INTO payment_intents (send's plain insert, or authorize's ON CONFLICT machine insert). */
const insertIntent = (row: Record<string, unknown> | null): DbRoute => [
  /INSERT INTO payment_intents/,
  () => ({ rows: row ? [row] : [] }),
]
/** INSERT INTO approval_requests (send's plain insert, or authorize's ON CONFLICT machine insert). */
const insertApproval = (row: Record<string, unknown> | null): DbRoute => [
  /INSERT INTO approval_requests/,
  () => ({ rows: row ? [row] : [] }),
]
/** refreshMachineIntentNonce — the duplicate-pending stale-nonce guard. */
const refreshNonce = (row: Record<string, unknown> | null): DbRoute => [
  /SET allowance_nonce = \$1/,
  () => ({ rows: row ? [row] : [] }),
]
/** recordMachineIntentSignature: pending_signature → signed, no status flip. */
const recordSignature = (ok: boolean): DbRoute => [
  /SET signature = \$1, signed_at = NOW\(\)/,
  () => ({ rows: ok ? [{ id: PAYMENT_ID }] : [] }),
]
/** confirmMachineIntent: pending_signature → confirmed, one-shot. */
const confirm = (ok: boolean): DbRoute => [
  /SET status = 'confirmed'/,
  () => ({ rows: ok ? [{ id: PAYMENT_ID }] : [] }),
]
/** getIntentStatus, read after a guarded write comes back empty. */
const intentStatus = (status: string): DbRoute => [
  /SELECT status FROM payment_intents/,
  () => ({ rows: [{ status }] }),
]

/** findSendIntentByIdempotencyKey (POST /send idempotency lookup). */
const sendIntentLookup = (rows: unknown[]): DbRoute => [
  /send_idempotency_key = \$2[\s\S]*FROM payment_intents|FROM payment_intents[\s\S]*send_idempotency_key = \$2/,
  () => ({ rows }),
]
/** findSendApprovalByIdempotencyKey (POST /send idempotency lookup). */
const sendApprovalLookup = (rows: unknown[]): DbRoute => [
  /send_idempotency_key = \$2[\s\S]*FROM approval_requests|FROM approval_requests[\s\S]*send_idempotency_key = \$2/,
  () => ({ rows }),
]

/**
 * findIntentStatusRow (getAgentPaymentStatus's payment_intents projection).
 * Shared by GET /:id/status and every replay path that reports "real status".
 */
const intentStatusRow = (row: Record<string, unknown> | null): DbRoute => [
  /LEFT JOIN machine_payment_reconciliation_events/,
  () => ({ rows: row ? [row] : [] }),
]
/**
 * findApprovalStatusRow / findReconciliationApproval / findApprovalForEvidenceScoped
 * — all three share the same `id = $1 AND agent_id = $2` shape against
 * approval_requests; never more than one runs in a single test.
 */
const approvalById = (row: Record<string, unknown> | null): DbRoute => [
  /FROM approval_requests\s+WHERE id = \$1 AND agent_id = \$2/,
  () => ({ rows: row ? [row] : [] }),
]
/**
 * findIntentForEvidenceScoped / findReconciliationIntent — both share the
 * same `id = $1 AND agent_id = $2` shape against payment_intents; never more
 * than one runs in a single test.
 */
const intentById = (row: Record<string, unknown> | null): DbRoute => [
  /FROM payment_intents\s+WHERE id = \$1 AND agent_id = \$2/,
  () => ({ rows: row ? [row] : [] }),
]

describe('machine payment routes', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(machinePaymentRoutes, { prefix: '/machine-payments' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockQuery.mockReset()
    for (const mock of Object.values(allowanceMocks)) mock.mockReset()
    for (const mock of Object.values(fiatMocks)) mock.mockReset()
    // mockClear (not mockReset): lateAttachMerchantReceipt is awaited via
    // `.catch()` in the fire-and-forget call site — it must keep resolving
    // to a promise across tests, just with a clean call history.
    reportingMocks.lateAttachMerchantReceipt.mockClear()
  })

  function pendingIntent(overrides: Record<string, unknown> = {}) {
    return {
      id: PAYMENT_ID,
      status: 'pending_signature',
      expires_at: '2099-01-01T00:10:00.000Z',
      chain_id: 8453,
      safe_address: AGENT.safe_address,
      token_symbol: 'USDC',
      token_address: USDC,
      amount_human: '0.01',
      amount_raw: '10000',
      to_address: RECIPIENT.toLowerCase(),
      merchant_address: RECIPIENT.toLowerCase(),
      payment_resource_url: challenge.resource,
      payment_rail: 'mpp_demo',
      machine_challenge_id: challenge.challengeId,
      machine_idempotency_key: 'mpp_demo:test',
      machine_metadata: JSON.stringify({
        protocol: 'mpp',
        network: challenge.network.name,
        description: challenge.description,
      }),
      sign_hash: SIGN_HASH,
      allowance_nonce: 3,
      ...overrides,
    }
  }

  function confirmedPayment(overrides: Record<string, unknown> = {}) {
    return {
      id: PAYMENT_ID,
      kind: 'payment_intent',
      agent_id: AGENT.id,
      user_id: AGENT.user_id,
      safe_address: AGENT.safe_address,
      chain_id: 8453,
      token_symbol: 'USDC',
      token_address: USDC,
      to_address: RECIPIENT.toLowerCase(),
      amount_raw: '10000',
      amount_human: '0.01',
      tx_hash: TX_HASH,
      status: 'confirmed',
      payment_rail: 'mpp_demo',
      source: 'mpp_demo',
      payment_resource_url: challenge.resource,
      x402_resource_url: null,
      merchant_address: RECIPIENT.toLowerCase(),
      x402_merchant_address: null,
      machine_challenge_id: challenge.challengeId,
      machine_idempotency_key: 'mpp_demo:test',
      machine_metadata: JSON.stringify({
        protocol: 'mpp',
        network: challenge.network.name,
        description: challenge.description,
      }),
      x402_idempotency_key: null,
      confirmed_at: '2026-05-15T12:00:00.000Z',
      funded_but_unsettled: false,
      ...overrides,
    }
  }

  function executedApproval(overrides: Record<string, unknown> = {}) {
    return {
      id: PAYMENT_ID,
      kind: 'approval_request',
      agent_id: AGENT.id,
      user_id: AGENT.user_id,
      safe_address: AGENT.safe_address,
      chain_id: 8453,
      token_symbol: 'USDC',
      token_address: USDC,
      to_address: RECIPIENT.toLowerCase(),
      amount_raw: '10000',
      amount_human: '0.01',
      tx_hash: TX_HASH,
      status: 'executed',
      payment_rail: 'mpp_demo',
      source: 'mpp_demo',
      payment_resource_url: challenge.resource,
      x402_resource_url: null,
      merchant_address: RECIPIENT.toLowerCase(),
      machine_challenge_id: challenge.challengeId,
      machine_idempotency_key: 'mpp_demo:test',
      machine_metadata: JSON.stringify({
        protocol: 'mpp',
        network: challenge.network.name,
        description: challenge.description,
      }),
      executed_at: '2026-05-15T12:00:00.000Z',
      ...overrides,
    }
  }

  it('returns the authenticated agent identity for MCP clients', async () => {
    primeDb(AUTH)

    const response = await app.inject({
      method: 'GET',
      url: '/machine-payments/agent',
      headers: { authorization: 'Bearer sk_agent_test' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      id: AGENT.id,
      name: AGENT.name,
      status: AGENT.status,
      safe_address: AGENT.safe_address,
      delegate_address: AGENT.delegate_address,
      chain_id: AGENT.chain_id,
      // #1306: AGENT fixture carries no execution_rail — buckets into legacy,
      // same as handleGetAllowances' own branch below.
      execution_rail: 'legacy',
    })
  })

  it('returns execution_rail: delegation for a delegation-rail agent (#1306)', async () => {
    primeDb(authAs({ ...AGENT, execution_rail: 'delegation' }))

    const response = await app.inject({
      method: 'GET',
      url: '/machine-payments/agent',
      headers: { authorization: 'Bearer sk_agent_test' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().execution_rail).toBe('delegation')
  })

  it('returns configured allowances with on-chain remaining spend', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValue({
      amount: 10000n,
      spent: 2500n,
      resetTimeMin: 60,
      lastResetMin: 100,
      nonce: 7,
    })
    allowanceMocks.computeEffectiveAllowance.mockReturnValue({
      remaining: 7500n,
      effectiveSpent: 2500n,
      isResetPending: false,
    })

    primeDb(
      AUTH,
      allowanceConfigRows([{
        id: 'allowance-1',
        token_address: USDC,
        token_symbol: 'USDC',
        allowance_amount: '10000',
        reset_period_min: 60,
      }]),
    )

    const response = await app.inject({
      method: 'GET',
      url: '/machine-payments/allowances',
      headers: { authorization: 'Bearer sk_agent_test' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      agent_id: AGENT.id,
      safe_address: AGENT.safe_address,
      delegate_address: AGENT.delegate_address,
      chain_id: AGENT.chain_id,
      allowances: [{
        id: 'allowance-1',
        token_address: USDC,
        token_symbol: 'USDC',
        configured_amount: '10000',
        reset_period_min: 60,
        onchain: {
          amount: '10000',
          spent: '2500',
          remaining: '7500',
          effective_spent: '2500',
          reset_time_min: 60,
          last_reset_min: 100,
          nonce: 7,
          is_reset_pending: false,
        },
      }],
    })
    expect(allowanceMocks.getTokenAllowance).toHaveBeenCalledWith(
      AGENT.chain_id,
      AGENT.safe_address,
      AGENT.delegate_address,
      USDC,
    )
  })

  describe('GET /allowances — legacy-rail characterization (#1135, pinned BEFORE the rail branch)', () => {
    // money.md: the legacy AllowanceModule rail's response is pinned here —
    // exact JSON shape, exact onchain.* fields — so the rail-aware change can
    // prove it left this rail untouched.

    function legacyOnchainRead() {
      allowanceMocks.getTokenAllowance.mockResolvedValue({
        amount: 10000n,
        spent: 2500n,
        resetTimeMin: 60,
        lastResetMin: 100,
        nonce: 7,
      })
      allowanceMocks.getLatestBlockTimeSec.mockResolvedValue(1_750_000_000)
      allowanceMocks.computeEffectiveAllowance.mockReturnValue({
        remaining: 7500n,
        effectiveSpent: 2500n,
        isResetPending: false,
      })
    }

    it('an explicit allowance_module rail returns the AllowanceModule snapshot byte-identically', async () => {
      legacyOnchainRead()
      primeDb(
        authAs({ ...AGENT, execution_rail: 'allowance_module' }),
        allowanceConfigRows([{
          id: 'allowance-1',
          token_address: USDC,
          token_symbol: 'USDC',
          allowance_amount: '10000',
          reset_period_min: 60,
        }]),
      )

      const response = await app.inject({
        method: 'GET',
        url: '/machine-payments/allowances',
        headers: { authorization: 'Bearer sk_agent_test' },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        agent_id: AGENT.id,
        safe_address: AGENT.safe_address,
        delegate_address: AGENT.delegate_address,
        chain_id: AGENT.chain_id,
        allowances: [{
          id: 'allowance-1',
          token_address: USDC,
          token_symbol: 'USDC',
          configured_amount: '10000',
          reset_period_min: 60,
          onchain: {
            amount: '10000',
            spent: '2500',
            remaining: '7500',
            effective_spent: '2500',
            reset_time_min: 60,
            last_reset_min: 100,
            nonce: 7,
            is_reset_pending: false,
          },
        }],
      })
      expect(allowanceMocks.getTokenAllowance).toHaveBeenCalledWith(
        AGENT.chain_id,
        AGENT.safe_address,
        AGENT.delegate_address,
        USDC,
      )
    })

    it('a legacy agent with no configured tokens returns an empty allowances array (200)', async () => {
      primeDb(AUTH, allowanceConfigRows([]))

      const response = await app.inject({
        method: 'GET',
        url: '/machine-payments/allowances',
        headers: { authorization: 'Bearer sk_agent_test' },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        agent_id: AGENT.id,
        safe_address: AGENT.safe_address,
        delegate_address: AGENT.delegate_address,
        chain_id: AGENT.chain_id,
        allowances: [],
      })
      expect(allowanceMocks.getTokenAllowance).not.toHaveBeenCalled()
    })

    it('an on-chain read failure returns 502 naming the token that failed', async () => {
      allowanceMocks.getTokenAllowance.mockRejectedValueOnce(new Error('rpc down'))
      allowanceMocks.getLatestBlockTimeSec.mockResolvedValue(1_750_000_000)
      primeDb(
        AUTH,
        allowanceConfigRows([{
          id: 'allowance-1',
          token_address: USDC,
          token_symbol: 'USDC',
          allowance_amount: '10000',
          reset_period_min: 60,
        }]),
      )

      const response = await app.inject({
        method: 'GET',
        url: '/machine-payments/allowances',
        headers: { authorization: 'Bearer sk_agent_test' },
      })

      expect(response.statusCode).toBe(502)
      expect(response.json()).toEqual({
        error: 'Failed to read on-chain allowance',
        token_address: USDC,
        details: 'rpc down',
      })
    })
  })

  describe('GET /allowances — rail-aware (#1135)', () => {
    const SEPOLIA_USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
    const DELEGATION_AGENT = {
      ...AGENT,
      chain_id: 84532,
      execution_rail: 'delegation',
      account_type: 'delegator_hybrid',
    }

    it('delegation rail: remaining = the ACTIVE delegation period budget, no AllowanceModule read, frozen mirror never consulted', async () => {
      primeDb(
        authAs(DELEGATION_AGENT),
        delegationRows([{
          id: 'd-1',
          agent_id: AGENT.id,
          chain_id: 84532,
          token_address: SEPOLIA_USDC,
          budget_atomic: '10000000',
          period_seconds: 86_400,
        }]),
      )

      const response = await app.inject({
        method: 'GET',
        url: '/machine-payments/allowances',
        headers: { authorization: 'Bearer sk_agent_test' },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        agent_id: AGENT.id,
        safe_address: AGENT.safe_address,
        delegate_address: AGENT.delegate_address,
        chain_id: 84532,
        allowances: [{
          id: 'd-1',
          token_address: SEPOLIA_USDC,
          token_symbol: 'USDC',
          configured_amount: '10.00',
          reset_period_min: 1440,
          onchain: {
            amount: '10000000',
            spent: '0',
            remaining: '10000000',
            effective_spent: '0',
            reset_time_min: 1440,
            last_reset_min: 0,
            nonce: 0,
            is_reset_pending: false,
            // #1319: no delegation_json row is primed in this fixture, so
            // readRemainingBudget is never even reached — the same fallback
            // path #1145 takes on an RPC failure. Provenance says so.
            remaining_is_from_chain: false,
          },
        }],
      })
      // No Safe, no AllowanceModule on this rail — the contract read must not run.
      expect(allowanceMocks.getTokenAllowance).not.toHaveBeenCalled()
      expect(allowanceMocks.getLatestBlockTimeSec).not.toHaveBeenCalled()
      // agent_allowances is a frozen onboarding mirror on this rail (#1090) —
      // consulting it would report the onboarding budget forever.
      expect(sqlCalls().some((c) => /FROM agent_allowances/.test(c.sql))).toBe(false)
    })

    it('delegation rail: NO active budget returns an empty allowances array — derived readiness stays needs_approval', async () => {
      primeDb(authAs(DELEGATION_AGENT), delegationRows([]))

      const response = await app.inject({
        method: 'GET',
        url: '/machine-payments/allowances',
        headers: { authorization: 'Bearer sk_agent_test' },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        agent_id: AGENT.id,
        safe_address: AGENT.safe_address,
        delegate_address: AGENT.delegate_address,
        chain_id: 84532,
        allowances: [],
      })
      expect(allowanceMocks.getTokenAllowance).not.toHaveBeenCalled()
    })

    it('session_key rail: 410 fail-closed — no state read on the retired rail (#834/#993)', async () => {
      primeDb(authAs({ ...AGENT, execution_rail: 'session_key' }))

      const response = await app.inject({
        method: 'GET',
        url: '/machine-payments/allowances',
        headers: { authorization: 'Bearer sk_agent_test' },
      })

      expect(response.statusCode).toBe(410)
      expect(response.json().error).toMatch(/session rail is retired/)
      // The refusal is produced from the auth context alone: no allowance
      // config read, no delegation read, no on-chain read.
      expect(sqlCalls().some((c) => /FROM agent_allowances|FROM agent_delegations/.test(c.sql))).toBe(false)
      expect(allowanceMocks.getTokenAllowance).not.toHaveBeenCalled()
    })
  })

  it('receipts join the intent so settlement_scheme is agent-visible (#1063 finding)', async () => {
    primeDb(AUTH)
    const response = await app.inject({
      method: 'GET',
      url: '/machine-payments/receipts?limit=5',
      headers: { authorization: 'Bearer sk_agent_test' },
    })
    expect(response.statusCode).toBe(200)
    // The scheme lives in payment_intents.machine_metadata (#946); without
    // this join the QA delegation leg has nowhere to read which branch ran.
    const receiptsCall = findCall(/FROM machine_payment_evidence e/)
    expect(receiptsCall).toBeDefined()
    expect(receiptsCall!.sql).toContain("machine_metadata->>'settlement_scheme'")
    expect(receiptsCall!.sql).toContain('LEFT JOIN payment_intents')
  })

  it('lists recent receipts without returning payment proof headers', async () => {
    primeDb(
      AUTH,
      [/FROM machine_payment_evidence e/, () => ({
        rows: [{
          id: 'evidence-1',
          payment_intent_id: PAYMENT_ID,
          approval_request_id: null,
          agent_id: AGENT.id,
          user_id: AGENT.user_id,
          rail: 'mpp_demo',
          proof_status: 'payment_confirmed',
          tx_hash: TX_HASH,
          chain_id: 8453,
          resource_url: challenge.resource,
          merchant_address: RECIPIENT.toLowerCase(),
          payer_address: AGENT.safe_address.toLowerCase(),
          settlement_address: RECIPIENT.toLowerCase(),
          token_symbol: 'USDC',
          token_address: USDC,
          amount_raw: '10000',
          amount_human: '0.01',
          challenge_id: challenge.challengeId,
          idempotency_key: 'mpp_demo:test',
          challenge_payload: { rail: 'mpp_demo' },
          selected_payment: null,
          payment_proof_header_name: 'MACHINE-PAYMENT-PROOF',
          payment_proof_header: 'secret-proof-header',
          protocol_receipt_header_name: 'Payment-Receipt',
          protocol_receipt_header: 'receipt-header',
          protocol_receipt_payload: { ok: true },
          merchant_status: 200,
          confirmed_at: '2026-05-15T12:00:00.000Z',
          created_at: '2026-05-15T12:00:01.000Z',
          updated_at: '2026-05-15T12:00:01.000Z',
          settlement_scheme: 'eip3009',
        }],
      })],
    )

    const response = await app.inject({
      method: 'GET',
      url: '/machine-payments/receipts?limit=10',
      headers: { authorization: 'Bearer sk_agent_test' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      receipts: [{
        id: 'evidence-1',
        settlement_scheme: 'eip3009',
        budget_delegation_hash: null,
        payment_id: PAYMENT_ID,
        payment_intent_id: PAYMENT_ID,
        approval_request_id: null,
        rail: 'mpp_demo',
        proof_status: 'payment_confirmed',
        tx_hash: TX_HASH,
        chain_id: 8453,
        resource_url: challenge.resource,
        merchant_address: RECIPIENT.toLowerCase(),
        payer_address: AGENT.safe_address.toLowerCase(),
        settlement_address: RECIPIENT.toLowerCase(),
        token_symbol: 'USDC',
        token_address: USDC,
        amount_raw: '10000',
        amount_human: '0.01',
        challenge_id: challenge.challengeId,
        idempotency_key: 'mpp_demo:test',
        challenge_payload: { rail: 'mpp_demo' },
        selected_payment: null,
        payment_proof_header_name: 'MACHINE-PAYMENT-PROOF',
        protocol_receipt_header_name: 'Payment-Receipt',
        protocol_receipt_payload: { ok: true },
        merchant_status: 200,
        confirmed_at: '2026-05-15T12:00:00.000Z',
        created_at: '2026-05-15T12:00:01.000Z',
        updated_at: '2026-05-15T12:00:01.000Z',
      }],
    })
    expect(JSON.stringify(response.json())).not.toContain('secret-proof-header')
  })

  // #993 (review finding on #1120): /send never consulted the seam — a
  // session-marked account could still move money through it.
  it('REFUSES a delegation-rail account on /send — 422, zero writes (#1251)', async () => {
    // Found live during the #908 mainnet canary: without this refusal a
    // Hybrid account fell through to LEGACY allowance coverage and queued
    // an approval that could never execute.
    primeDb(authAs({ ...AGENT, execution_rail: 'delegation' }))
    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/send',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { asset: 'USDC', recipient: RECIPIENT, amount: '0.01' },
    })
    expect(response.statusCode).toBe(422)
    expect(response.json().error_code).toBe('rail_not_supported')
    expect(response.json().error).toMatch(/POST \/payments/)
    expect(sqlCalls().some((c) => /INSERT|UPDATE|DELETE/i.test(c.sql))).toBe(false)
  })

  // #1328: the HTTP /authorize route no longer calls authorizeMachinePayment
  // for any rail — it always refuses (see the "POST /authorize is retired"
  // describe block below). The underlying rail-gate behavior this test used
  // to characterize through the route is generic orchestration
  // (`modules/mpp/authorize.ts`) kept for a future non-demo MPP rail
  // (#1328's file-ownership scope explicitly excludes it) — proven here by
  // calling the function directly instead of through the retired HTTP path.
  it('authorizeMachinePayment REFUSES a delegation-rail account — 422, zero writes, no approval manufactured (#1251)', async () => {
    primeDb(RAIL_DELEGATION)
    const result = await authorizeMachinePayment({
      agent: AGENT,
      rail: 'mpp_demo',
      resourceUrl: challenge.resource,
      payTo: challenge.recipient,
      merchantPayTo: challenge.recipient,
      amountAtomic: challenge.amount.atomic,
      asset: challenge.asset.address,
      chainId: challenge.network.chainId,
      description: challenge.description,
      challengeId: challenge.challengeId,
      idempotencyKey: 'mpp_demo:delegation-refusal',
      metadata: { protocol: 'mpp', network: challenge.network.name, description: challenge.description },
    })
    expect(result.statusCode).toBe(422)
    expect((result.body as { error_code?: string }).error_code).toBe('rail_not_supported')
    // The bug's signature was a manufactured approval_requests row — assert
    // the refusal writes NOTHING.
    expect(sqlCalls().some((c) => /INSERT INTO approval_requests/.test(c.sql))).toBe(false)
    expect(sqlCalls().some((c) => /INSERT INTO payment_intents/.test(c.sql))).toBe(false)
  })

  it('REFUSES a session-marked account on /send — 410, zero writes', async () => {
    primeDb(authAs({ ...AGENT, execution_rail: 'session_key' }))
    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/send',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { asset: 'USDC', recipient: RECIPIENT, amount: '0.01' },
    })
    expect(response.statusCode).toBe(410)
    expect(response.json().error).toMatch(/session rail is retired/)
    expect(sqlCalls().some((c) => /INSERT|UPDATE|DELETE/i.test(c.sql))).toBe(false)
  })

  // #993 characterization (written BEFORE the seam change): a replayed
  // idempotency key whose EXISTING intent is session-rail gets 410 with ZERO
  // writes — no refresh, no status flip, no partial state. Direct call per
  // the #1328 note above (the HTTP /authorize route itself now always 410s).
  it('authorizeMachinePayment replay of a session-rail intent — 410, zero writes (#834/#993)', async () => {
    primeDb(existingIntent(pendingIntent({ execution_rail: 'session_key' })))

    const result = await authorizeMachinePayment({
      agent: AGENT,
      rail: 'mpp_demo',
      resourceUrl: challenge.resource,
      payTo: challenge.recipient,
      merchantPayTo: challenge.recipient,
      amountAtomic: challenge.amount.atomic,
      asset: challenge.asset.address,
      chainId: challenge.network.chainId,
      description: challenge.description,
      challengeId: challenge.challengeId,
      idempotencyKey: 'mpp_demo:test',
      metadata: { protocol: 'mpp', network: challenge.network.name, description: challenge.description },
    })

    expect(result.statusCode).toBe(410)
    expect((result.body as { error?: string }).error).toMatch(/session rail is retired/)
    expect(sqlCalls().some((c) => /INSERT|UPDATE|DELETE/i.test(c.sql))).toBe(false)
  })

  // ── POST /authorize is retired (#1328) ──────────────────────────────────
  // Acceptance: "POST /machine-payments/authorize no longer accepts or
  // creates mpp_demo payments; no new legacy MPP demo challenge can be
  // authorized." The route now refuses UNCONDITIONALLY — fail-closed,
  // mirroring the #834 session-rail 410 pattern — before the body is even
  // inspected. authorizeMachinePayment's own behavior stays characterized
  // (above and below, via direct calls) because the generic MPP orchestrator
  // is kept for a future non-demo MPP rail; only the demo-specific HTTP
  // wiring is retired.
  describe('POST /machine-payments/authorize (#1328: mpp_demo retired)', () => {
    it('refuses a well-formed mpp_demo challenge — 410, zero writes', async () => {
      primeDb(AUTH)

      const response = await app.inject({
        method: 'POST',
        url: '/machine-payments/authorize',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: { challenge, idempotencyKey: 'mpp_demo:test' },
      })

      expect(response.statusCode).toBe(410)
      expect(response.json().error).toMatch(/mpp_demo/i)
      expect(response.json().error).toMatch(/retired/i)
      // Zero authorization work — the refusal is produced before anything
      // resembling challenge validation or coverage decisioning runs.
      expectNoAuthorizationWork()
      expect(sqlCalls().some((c) => /INSERT|UPDATE|DELETE/i.test(c.sql))).toBe(false)
    })

    it('refuses an empty/garbage body the same way — 410 before any body validation', async () => {
      primeDb(AUTH)

      const response = await app.inject({
        method: 'POST',
        url: '/machine-payments/authorize',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: {},
      })

      expect(response.statusCode).toBe(410)
      expect(response.json().error).toMatch(/retired/i)
      expect(sqlCalls().some((c) => /INSERT|UPDATE|DELETE/i.test(c.sql))).toBe(false)
    })

    it('refuses even a signed one-shot authorize attempt — no execution, no partial state', async () => {
      primeDb(AUTH)

      const response = await app.inject({
        method: 'POST',
        url: '/machine-payments/authorize',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: { challenge, idempotencyKey: 'mpp_demo:test', signature: '0xsig' },
      })

      expect(response.statusCode).toBe(410)
      expect(allowanceMocks.executeAllowanceTransfer).not.toHaveBeenCalled()
      expect(sqlCalls().some((c) => /INSERT|UPDATE|DELETE/i.test(c.sql))).toBe(false)
    })

    it('still requires agent auth — an unauthenticated request never reaches the refusal body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/machine-payments/authorize',
        payload: { challenge, idempotencyKey: 'mpp_demo:test' },
      })

      expect(response.statusCode).toBe(401)
    })
  })

  it('authorizeMachinePayment creates a payment intent with generic rail metadata', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValue({ nonce: 3 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 10000n })
    allowanceMocks.generateTransferHash.mockResolvedValue(SIGN_HASH)

    primeDb(
      existingIntent(null),
      existingApproval(null),
      RAIL_LEGACY,
      allowanceConfigured(true),
      insertIntent(pendingIntent()),
    )

    const result = await authorizeMachinePayment({
      agent: AGENT,
      rail: 'mpp_demo',
      resourceUrl: challenge.resource,
      payTo: challenge.recipient,
      merchantPayTo: challenge.recipient,
      amountAtomic: challenge.amount.atomic,
      asset: challenge.asset.address,
      chainId: challenge.network.chainId,
      description: challenge.description,
      challengeId: challenge.challengeId,
      idempotencyKey: 'mpp_demo:test',
      metadata: { protocol: 'mpp', network: challenge.network.name, description: challenge.description },
    })

    expect(result.statusCode).toBe(201)
    expect(result.body).toMatchObject({
      payment_id: PAYMENT_ID,
      status: 'pending_signature',
      rail: 'mpp_demo',
      challenge_id: challenge.challengeId,
      amount: '0.01',
      amount_atomic: '10000',
      token: 'USDC',
      asset: USDC,
      network: challenge.network.name,
      description: challenge.description,
      idempotency_key: 'mpp_demo:test',
      resource_url: challenge.resource,
      merchant_address: RECIPIENT.toLowerCase(),
      mpp: {
        amount_atomic: '10000',
        asset: USDC,
        network: challenge.network.name,
        resource_url: challenge.resource,
        merchant_address: RECIPIENT.toLowerCase(),
        description: challenge.description,
        idempotency_key: 'mpp_demo:test',
        challenge_id: challenge.challengeId,
      },
      to: RECIPIENT.toLowerCase(),
      sign_data: {
        hash: SIGN_HASH,
        components: {
          safe: AGENT.safe_address,
          token: USDC,
          to: RECIPIENT.toLowerCase(),
          amount: '10000',
          nonce: 3,
        },
      },
    })

    expect(allowanceMocks.generateTransferHash).toHaveBeenCalledWith(
      8453,
      AGENT.safe_address,
      USDC,
      RECIPIENT,
      10000n,
      '0x0000000000000000000000000000000000000000',
      0n,
      3,
    )

    // The write carries the rail + idempotency identity — HANDLER concern
    // (which write was requested); the ON CONFLICT dedupe semantics are the
    // repository's, proven on the real harness.
    const insert = findCall(/INSERT INTO payment_intents/)
    expect(insert).toBeDefined()
    expect(insert!.sql).toContain('payment_rail')
    expect(insert!.sql).toContain('machine_challenge_id')
    expect(insert!.sql).toContain('machine_idempotency_key')
    expect(insert!.params).toContain('mpp_demo')
    expect(insert!.params).toContain(challenge.challengeId)
    expect(insert!.params).toContain('mpp_demo:test')
  })

  it('authorizeMachinePayment returns a confirmed payment for idempotency replay', async () => {
    primeDb(existingIntent(pendingIntent({ status: 'confirmed', tx_hash: `0x${'ab'.repeat(32)}` })))

    const result = await authorizeMachinePayment({
      agent: AGENT,
      rail: 'mpp_demo',
      resourceUrl: challenge.resource,
      payTo: challenge.recipient,
      merchantPayTo: challenge.recipient,
      amountAtomic: challenge.amount.atomic,
      asset: challenge.asset.address,
      chainId: challenge.network.chainId,
      description: challenge.description,
      challengeId: challenge.challengeId,
      idempotencyKey: 'mpp_demo:test',
      metadata: { protocol: 'mpp', network: challenge.network.name, description: challenge.description },
    })

    expect(result.statusCode).toBe(200)
    expect(result.body).toMatchObject({
      success: true,
      payment_id: PAYMENT_ID,
      status: 'confirmed',
      tx_hash: `0x${'ab'.repeat(32)}`,
      rail: 'mpp_demo',
      challenge_id: challenge.challengeId,
      amount_atomic: '10000',
      asset: USDC,
      network: challenge.network.name,
      idempotency_key: 'mpp_demo:test',
      mpp: {
        challenge_id: challenge.challengeId,
        resource_url: challenge.resource,
        merchant_address: RECIPIENT.toLowerCase(),
      },
    })
    expect(allowanceMocks.generateTransferHash).not.toHaveBeenCalled()

    const lookup = findCall(/COALESCE\(payment_rail, source\) = \$4/)
    expect(lookup).toBeDefined()
    expect(lookup!.params).toEqual([AGENT.id, 'mpp_demo:test', challenge.challengeId, 'mpp_demo'])
  })

  it('authorizeMachinePayment guards stale sign data refreshes for duplicate pending intents', async () => {
    const refreshedHash = `0x${'22'.repeat(32)}`
    allowanceMocks.getTokenAllowance.mockResolvedValue({ nonce: 4 })
    allowanceMocks.generateTransferHash.mockResolvedValue(refreshedHash)

    primeDb(
      existingIntent(pendingIntent({ allowance_nonce: 3, sign_hash: SIGN_HASH })),
      refreshNonce({ id: PAYMENT_ID }),
    )

    const result = await authorizeMachinePayment({
      agent: AGENT,
      rail: 'mpp_demo',
      resourceUrl: challenge.resource,
      payTo: challenge.recipient,
      merchantPayTo: challenge.recipient,
      amountAtomic: challenge.amount.atomic,
      asset: challenge.asset.address,
      chainId: challenge.network.chainId,
      description: challenge.description,
      challengeId: challenge.challengeId,
      idempotencyKey: 'mpp_demo:test',
      metadata: { protocol: 'mpp', network: challenge.network.name, description: challenge.description },
    })

    expect(result.statusCode).toBe(200)
    expect((result.body as { sign_data: unknown }).sign_data).toMatchObject({
      hash: refreshedHash,
      components: { nonce: 4 },
    })

    const refreshCall = findCall(/SET allowance_nonce = \$1/)
    expect(refreshCall).toBeDefined()
    expect(refreshCall!.sql).toContain('UPDATE payment_intents')
    expect(refreshCall!.sql).toContain('agent_id = $4')
    expect(refreshCall!.sql).toContain('COALESCE(payment_rail, source) = $5')
    expect(refreshCall!.sql).toContain("status = 'pending_signature'")
    expect(refreshCall!.sql).toContain('tx_hash IS NULL')
    expect(refreshCall!.params).toEqual([4, refreshedHash, PAYMENT_ID, AGENT.id, 'mpp_demo'])
  })

  it('authorizeMachinePayment reloads rail-scoped existing intents after insert idempotency conflicts', async () => {
    // Called twice (the preflight read, then returnExistingIntent's nonce
    // compare) — both calls want the same answer, so a persistent mock covers
    // both without a sequence.
    allowanceMocks.getTokenAllowance.mockResolvedValue({ nonce: 3 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 10000n })
    allowanceMocks.generateTransferHash.mockResolvedValue(SIGN_HASH)

    // findMachineIntentByKeyOrChallenge runs TWICE with the identical
    // statement: once up front (a fresh key — nothing found) and again after
    // the INSERT ... ON CONFLICT DO NOTHING loses the race. A stateful
    // counter is the only way a content-dispatch stub can answer one
    // statement differently across its two calls (#1226 style, mirroring
    // x402.test.ts's "returns the existing approval..." case); the ON
    // CONFLICT semantics themselves are the repository's to prove.
    let intentReads = 0
    primeDb(
      [/COALESCE\(payment_rail, source\) = \$4/, () => {
        intentReads += 1
        return { rows: intentReads > 1 ? [pendingIntent()] : [] }
      }],
      existingApproval(null),
      RAIL_LEGACY,
      allowanceConfigured(true),
      insertIntent(null),
    )

    const result = await authorizeMachinePayment({
      agent: AGENT,
      rail: 'mpp_demo',
      resourceUrl: challenge.resource,
      payTo: challenge.recipient,
      merchantPayTo: challenge.recipient,
      amountAtomic: challenge.amount.atomic,
      asset: challenge.asset.address,
      chainId: challenge.network.chainId,
      description: challenge.description,
      challengeId: challenge.challengeId,
      idempotencyKey: 'mpp_demo:test',
      metadata: { protocol: 'mpp', network: challenge.network.name, description: challenge.description },
    })

    expect(result.statusCode).toBe(200)
    expect(result.body).toMatchObject({
      payment_id: PAYMENT_ID,
      status: 'pending_signature',
      rail: 'mpp_demo',
      sign_data: { hash: SIGN_HASH },
    })
    expect(intentReads).toBe(2)
  })

  it('returns unified status for confirmed payment intents', async () => {
    primeDb(AUTH, intentStatusRow(confirmedPayment({ expires_at: '2099-01-02T00:00:00.000Z' })))

    const response = await app.inject({
      method: 'GET',
      url: `/machine-payments/${PAYMENT_ID}/status`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      payment_id: PAYMENT_ID,
      kind: 'payment_intent',
      rail: 'mpp_demo',
      status: 'confirmed',
      phase: 'payment_confirmed',
      next_action: 'none',
      amount: '0.01',
      token: 'USDC',
      tx_hash: TX_HASH,
      resource_url: challenge.resource,
      merchant_address: RECIPIENT.toLowerCase(),
      amount_atomic: '10000',
      asset: USDC,
      network: challenge.network.name,
      description: challenge.description,
      idempotency_key: 'mpp_demo:test',
      mpp: {
        amount_atomic: '10000',
        asset: USDC,
        network: challenge.network.name,
        resource_url: challenge.resource,
        merchant_address: RECIPIENT.toLowerCase(),
        description: challenge.description,
        idempotency_key: 'mpp_demo:test',
        challenge_id: challenge.challengeId,
      },
    })
  })

  it('returns funded_but_unsettled phase when merchant retry was rejected after funding', async () => {
    primeDb(
      AUTH,
      intentStatusRow(confirmedPayment({ funded_but_unsettled: true, expires_at: '2099-01-02T00:00:00.000Z' })),
    )

    const response = await app.inject({
      method: 'GET',
      url: `/machine-payments/${PAYMENT_ID}/status`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      payment_id: PAYMENT_ID,
      status: 'confirmed',
      phase: 'funded_but_unsettled',
      next_action: 'sweep_stranded_funds',
    })
    // Message must tell the agent to stop and surface the failure.
    expect(response.json().message).toMatch(/stranded|merchant rejected|sweep/i)
  })

  it('returns unified status for approval request IDs', async () => {
    primeDb(
      AUTH,
      intentStatusRow(null),
      approvalById({
        id: 'approval-123',
        chain_id: 8453,
        token_symbol: 'USDC',
        token_address: USDC,
        amount_human: '0.01',
        amount_raw: '10000',
        status: 'pending',
        tx_hash: null,
        expires_at: '2099-01-02T00:00:00.000Z',
        source: 'mpp_demo',
        payment_rail: 'mpp_demo',
        payment_resource_url: challenge.resource,
        x402_resource_url: null,
        merchant_address: RECIPIENT.toLowerCase(),
        machine_challenge_id: challenge.challengeId,
        machine_idempotency_key: 'mpp_demo:test',
        machine_metadata: JSON.stringify({
          protocol: 'mpp',
          network: challenge.network.name,
          description: challenge.description,
        }),
      }),
    )

    const response = await app.inject({
      method: 'GET',
      url: '/machine-payments/approval-123/status',
      headers: { authorization: 'Bearer sk_agent_test' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      payment_id: 'approval-123',
      kind: 'approval_request',
      rail: 'mpp_demo',
      status: 'pending',
      phase: 'user_approval_required',
      next_action: 'wait_for_user_approval',
      amount: '0.01',
      token: 'USDC',
      amount_atomic: '10000',
      asset: USDC,
      network: challenge.network.name,
      description: challenge.description,
      idempotency_key: 'mpp_demo:test',
      mpp: {
        challenge_id: challenge.challengeId,
      },
    })
  })

  it('does not return status for another agent payment or approval', async () => {
    primeDb(AUTH, intentStatusRow(null), approvalById(null))

    const response = await app.inject({
      method: 'GET',
      url: `/machine-payments/${PAYMENT_ID}/status`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: 'Payment or approval request not found' })
  })

  it('authorizeMachinePayment queues over-allowance payments for approval with rail metadata', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValue({ nonce: 3 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 1n })

    primeDb(
      existingIntent(null),
      existingApproval(null),
      RAIL_LEGACY,
      allowanceConfigured(true),
      insertApproval({
        id: 'approval-123',
        status: 'pending',
        token_symbol: 'USDC',
        amount_human: '0.01',
        expires_at: '2099-01-02T00:00:00.000Z',
        tx_hash: null,
        machine_challenge_id: challenge.challengeId,
        payment_rail: 'mpp_demo',
      }),
    )

    const result = await authorizeMachinePayment({
      agent: AGENT,
      rail: 'mpp_demo',
      resourceUrl: challenge.resource,
      payTo: challenge.recipient,
      merchantPayTo: challenge.recipient,
      amountAtomic: challenge.amount.atomic,
      asset: challenge.asset.address,
      chainId: challenge.network.chainId,
      description: challenge.description,
      challengeId: challenge.challengeId,
      idempotencyKey: 'mpp_demo:test',
      metadata: { protocol: 'mpp', network: challenge.network.name, description: challenge.description },
    })

    expect(result.statusCode).toBe(202)
    expect(result.body).toMatchObject({
      payment_id: 'approval-123',
      status: 'pending_approval',
      rail: 'mpp_demo',
      challenge_id: challenge.challengeId,
      token: 'USDC',
      requested: '0.01',
      resource_url: challenge.resource,
      merchant_address: RECIPIENT.toLowerCase(),
      amount_atomic: '10000',
      asset: USDC,
      network: challenge.network.name,
      description: challenge.description,
      idempotency_key: 'mpp_demo:test',
      mpp: {
        amount_atomic: '10000',
        asset: USDC,
        network: challenge.network.name,
        resource_url: challenge.resource,
        merchant_address: RECIPIENT.toLowerCase(),
        description: challenge.description,
        idempotency_key: 'mpp_demo:test',
        challenge_id: challenge.challengeId,
      },
    })

    const insert = findCall(/INSERT INTO approval_requests/)
    expect(insert).toBeDefined()
    expect(insert!.sql).toContain('machine_idempotency_key')
    expect(insert!.params).toContain('mpp_demo:test')
  })

  it('authorizeMachinePayment returns a specific response for rejected approval retries', async () => {
    primeDb(
      existingIntent(null),
      existingApproval({
        id: 'approval-123',
        status: 'rejected',
        token_symbol: 'USDC',
        amount_human: '0.01',
        expires_at: '2099-01-02T00:00:00.000Z',
        tx_hash: null,
        machine_challenge_id: challenge.challengeId,
        payment_rail: 'mpp_demo',
      }),
    )

    const result = await authorizeMachinePayment({
      agent: AGENT,
      rail: 'mpp_demo',
      resourceUrl: challenge.resource,
      payTo: challenge.recipient,
      merchantPayTo: challenge.recipient,
      amountAtomic: challenge.amount.atomic,
      asset: challenge.asset.address,
      chainId: challenge.network.chainId,
      description: challenge.description,
      challengeId: challenge.challengeId,
      idempotencyKey: 'mpp_demo:test',
      metadata: { protocol: 'mpp', network: challenge.network.name, description: challenge.description },
    })

    expect(result.statusCode).toBe(409)
    expect(result.body).toMatchObject({
      payment_id: 'approval-123',
      status: 'rejected',
      error: 'Payment was rejected by the account owner',
    })
  })

  it('authorizeMachinePayment rejects malformed MPP payTo before allowance, hash, or execution work', async () => {
    const result = await authorizeMachinePayment({
      agent: AGENT,
      rail: 'mpp_demo',
      resourceUrl: challenge.resource,
      payTo: 'not-an-address',
      merchantPayTo: challenge.recipient,
      amountAtomic: challenge.amount.atomic,
      asset: challenge.asset.address,
      chainId: challenge.network.chainId,
      description: challenge.description,
      challengeId: challenge.challengeId,
      idempotencyKey: 'mpp_demo:test',
      metadata: { protocol: 'mpp', network: challenge.network.name, description: challenge.description },
    })

    expect(result).toEqual({
      statusCode: 400,
      body: { error: 'Valid payTo address is required' },
    })
    expect(mockQuery).not.toHaveBeenCalled()
    expectNoAuthorizationWork()
  })

  it('rejects malformed MPP merchantPayTo before allowance, hash, or execution work', async () => {
    const result = await authorizeMachinePayment({
      agent: AGENT,
      rail: 'mpp_demo',
      resourceUrl: challenge.resource,
      payTo: RECIPIENT,
      merchantPayTo: 'not-an-address',
      amountAtomic: challenge.amount.atomic,
      asset: challenge.asset.address,
      chainId: challenge.network.chainId,
      description: challenge.description,
      challengeId: challenge.challengeId,
      idempotencyKey: 'mpp_demo:test',
      metadata: {
        ...challenge.metadata,
        protocol: 'mpp',
        network: challenge.network.name,
        description: challenge.description,
      },
    })

    expect(result).toEqual({
      statusCode: 400,
      body: { error: 'Valid merchantPayTo address is required' },
    })
    expect(mockQuery).not.toHaveBeenCalled()
    expectNoAuthorizationWork()
  })

  it('authorizeMachinePayment rejects signatures from the wrong delegate', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValue({ nonce: 3 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 10000n })
    allowanceMocks.generateTransferHash.mockResolvedValue(SIGN_HASH)
    allowanceMocks.recoverSigner.mockReturnValueOnce('0x0000000000000000000000000000000000000001')

    primeDb(
      existingIntent(null),
      existingApproval(null),
      RAIL_LEGACY,
      allowanceConfigured(true),
      insertIntent(pendingIntent()),
    )

    const result = await authorizeMachinePayment({
      agent: AGENT,
      rail: 'mpp_demo',
      resourceUrl: challenge.resource,
      payTo: challenge.recipient,
      merchantPayTo: challenge.recipient,
      amountAtomic: challenge.amount.atomic,
      asset: challenge.asset.address,
      chainId: challenge.network.chainId,
      description: challenge.description,
      challengeId: challenge.challengeId,
      idempotencyKey: 'mpp_demo:test',
      metadata: { protocol: 'mpp', network: challenge.network.name, description: challenge.description },
      signature: '0xsig',
    })

    expect(result.statusCode).toBe(403)
    expect(result.body).toMatchObject({
      error: 'Signature does not match delegate address',
      recovered: '0x0000000000000000000000000000000000000001',
    })
    expect(allowanceMocks.executeAllowanceTransfer).not.toHaveBeenCalled()
  })

  it('authorizeMachinePayment records one-shot signatures without marking the payment submitted before execution', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValue({ nonce: 3 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 10000n })
    allowanceMocks.generateTransferHash.mockResolvedValue(SIGN_HASH)
    allowanceMocks.recoverSigner.mockReturnValueOnce(AGENT.delegate_address)
    allowanceMocks.executeAllowanceTransfer.mockResolvedValue({ txHash: TX_HASH })
    fiatMocks.getFiatValuesForTokenAmount.mockResolvedValue({ usd: 0.01, eur: 0.01 })

    primeDb(
      existingIntent(null),
      existingApproval(null),
      RAIL_LEGACY,
      allowanceConfigured(true),
      insertIntent(pendingIntent()),
      recordSignature(true),
      confirm(true),
    )

    const result = await authorizeMachinePayment({
      agent: AGENT,
      rail: 'mpp_demo',
      resourceUrl: challenge.resource,
      payTo: challenge.recipient,
      merchantPayTo: challenge.recipient,
      amountAtomic: challenge.amount.atomic,
      asset: challenge.asset.address,
      chainId: challenge.network.chainId,
      description: challenge.description,
      challengeId: challenge.challengeId,
      idempotencyKey: 'mpp_demo:test',
      metadata: { protocol: 'mpp', network: challenge.network.name, description: challenge.description },
      signature: '0xsig',
    })

    expect(result.statusCode).toBe(201)
    expect(result.body).toMatchObject({
      success: true,
      payment_id: PAYMENT_ID,
      status: 'confirmed',
      tx_hash: TX_HASH,
    })

    // The one-shot ordering invariant: the signature is durably recorded
    // BEFORE on-chain execution runs (see the route's comment on why status
    // never flips to 'submitted' here). What the guarded UPDATE's WHERE
    // clause enforces is proven in the repository suite; the property this
    // test owns is ordering and the exact values written.
    const signatureUpdate = findCall(/SET signature = \$1, signed_at = NOW\(\)/)
    expect(signatureUpdate).toBeDefined()
    expect(signatureUpdate!.sql).toContain("status = 'pending_signature'")
    expect(signatureUpdate!.sql).toContain('agent_id = $3')
    expect(signatureUpdate!.sql).toContain('payment_rail = $4')
    expect(signatureUpdate!.sql).toContain('tx_hash IS NULL')
    expect(signatureUpdate!.sql).not.toContain("status = 'submitted'")
    expect(signatureUpdate!.sql).not.toContain('submitted_at')
    expect(signatureUpdate!.params).toEqual(['0xsig', PAYMENT_ID, AGENT.id, 'mpp_demo'])

    const signatureCallIndex = mockQuery.mock.calls.findIndex(([sql]) =>
      typeof sql === 'string' && /SET signature = \$1, signed_at = NOW\(\)/.test(sql),
    )
    const executionOrder = allowanceMocks.executeAllowanceTransfer.mock.invocationCallOrder[0]
    expect(mockQuery.mock.invocationCallOrder[signatureCallIndex]).toBeLessThan(executionOrder)

    const confirmedUpdate = findCall(/SET status = 'confirmed'/)
    expect(confirmedUpdate).toBeDefined()
    expect(confirmedUpdate!.sql).toContain('tx_hash = $1')
    expect(confirmedUpdate!.sql).toContain('submitted_at = NOW()')
    expect(confirmedUpdate!.sql).toContain("status = 'pending_signature'")
    expect(confirmedUpdate!.sql).toContain('agent_id = $5')
    expect(confirmedUpdate!.sql).toContain('payment_rail = $6')
    expect(confirmedUpdate!.sql).toContain('tx_hash IS NULL')
    expect(confirmedUpdate!.params).toEqual([TX_HASH, PAYMENT_ID, 0.01, 0.01, AGENT.id, 'mpp_demo'])
  })

  it('authorizeMachinePayment does not overwrite one-shot terminal state after execution failures', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValue({ nonce: 3 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 10000n })
    allowanceMocks.generateTransferHash.mockResolvedValue(SIGN_HASH)
    allowanceMocks.recoverSigner.mockReturnValueOnce(AGENT.delegate_address)
    allowanceMocks.executeAllowanceTransfer.mockRejectedValueOnce(new Error('relayer unavailable'))

    primeDb(
      existingIntent(null),
      existingApproval(null),
      RAIL_LEGACY,
      allowanceConfigured(true),
      insertIntent(pendingIntent()),
      recordSignature(true),
    )

    const result = await authorizeMachinePayment({
      agent: AGENT,
      rail: 'mpp_demo',
      resourceUrl: challenge.resource,
      payTo: challenge.recipient,
      merchantPayTo: challenge.recipient,
      amountAtomic: challenge.amount.atomic,
      asset: challenge.asset.address,
      chainId: challenge.network.chainId,
      description: challenge.description,
      challengeId: challenge.challengeId,
      idempotencyKey: 'mpp_demo:test',
      metadata: { protocol: 'mpp', network: challenge.network.name, description: challenge.description },
      signature: '0xsig',
    })

    expect(result.statusCode).toBe(502)
    expect(result.body).toMatchObject({
      payment_id: PAYMENT_ID,
      status: 'failed',
      error: 'On-chain execution failed',
    })

    const failedUpdate = findCall(/SET status = 'failed'/)
    expect(failedUpdate).toBeDefined()
    expect(failedUpdate!.sql).toContain("status = 'pending_signature'")
    expect(failedUpdate!.sql).toContain('agent_id = $3')
    expect(failedUpdate!.sql).toContain('payment_rail = $4')
    expect(failedUpdate!.sql).toContain('tx_hash IS NULL')
    expect(failedUpdate!.params).toEqual(['relayer unavailable', PAYMENT_ID, AGENT.id, 'mpp_demo'])
  })

  it('authorizeMachinePayment does not record evidence when a one-shot confirmation loses a terminal-state race', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValue({ nonce: 3 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 10000n })
    allowanceMocks.generateTransferHash.mockResolvedValue(SIGN_HASH)
    allowanceMocks.recoverSigner.mockReturnValueOnce(AGENT.delegate_address)
    allowanceMocks.executeAllowanceTransfer.mockResolvedValue({ txHash: TX_HASH })
    fiatMocks.getFiatValuesForTokenAmount.mockResolvedValue({ usd: 0.01, eur: 0.01 })

    primeDb(
      existingIntent(null),
      existingApproval(null),
      RAIL_LEGACY,
      allowanceConfigured(true),
      insertIntent(pendingIntent()),
      recordSignature(true),
      confirm(false), // lost the terminal-state race
      intentStatus('confirmed'),
    )

    const result = await authorizeMachinePayment({
      agent: AGENT,
      rail: 'mpp_demo',
      resourceUrl: challenge.resource,
      payTo: challenge.recipient,
      merchantPayTo: challenge.recipient,
      amountAtomic: challenge.amount.atomic,
      asset: challenge.asset.address,
      chainId: challenge.network.chainId,
      description: challenge.description,
      challengeId: challenge.challengeId,
      idempotencyKey: 'mpp_demo:test',
      metadata: { protocol: 'mpp', network: challenge.network.name, description: challenge.description },
      signature: '0xsig',
    })

    expect(result.statusCode).toBe(409)
    expect(result.body).toMatchObject({
      payment_id: PAYMENT_ID,
      status: 'confirmed',
      error: 'Payment intent changed after on-chain execution',
    })
    expect(allowanceMocks.executeAllowanceTransfer).toHaveBeenCalledOnce()
    expect(sqlCalls().some((c) => /machine_payment_evidence/.test(c.sql))).toBe(false)
  })

  it('records a reconciliation event for confirmed payments rejected by the merchant retry', async () => {
    primeDb(
      AUTH,
      intentById(confirmedPayment()),
      [/INSERT INTO machine_payment_reconciliation_events/, () => ({
        rows: [{ id: 'event-123', status: 'open', created_at: '2026-05-15T12:00:00.000Z' }],
      })],
    )

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/reconciliation-events',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        paymentId: PAYMENT_ID,
        rail: 'mpp_demo',
        eventType: 'merchant_retry_rejected_after_payment',
        txHash: TX_HASH,
        reason: 'Merchant returned HTTP 402 after payment',
        details: { retryStatus: 402, resourceUrl: challenge.resource },
      },
    })

    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({
      event_id: 'event-123',
      status: 'open',
      payment_id: PAYMENT_ID,
      rail: 'mpp_demo',
      event_type: 'merchant_retry_rejected_after_payment',
    })

    const insert = findCall(/INSERT INTO machine_payment_reconciliation_events/)
    expect(insert).toBeDefined()
    expect(insert!.sql).toContain('ON CONFLICT (payment_intent_id, event_type)')
    expect(insert!.sql).toContain("machine_payment_reconciliation_events.status <> 'resolved'")
    expect(insert!.params).toContain(PAYMENT_ID)
    expect(insert!.params).toContain('mpp_demo')
    expect(insert!.params).toContain('merchant_retry_rejected_after_payment')
    expect(insert!.params).toContain(TX_HASH)
    expect(insert!.params).toContain(challenge.resource)
    expect(insert!.params).toContain(RECIPIENT.toLowerCase())
    expect(insert!.params).toContain(challenge.challengeId)
    expect(insert!.params).toContain('mpp_demo:test')
  })

  it('records a reconciliation event for executed approval requests rejected by the merchant retry', async () => {
    primeDb(
      AUTH,
      intentById(null),
      approvalById(executedApproval()),
      [/INSERT INTO machine_payment_reconciliation_events/, () => ({
        rows: [{ id: 'event-approval', status: 'open', created_at: '2026-05-15T12:00:00.000Z' }],
      })],
    )

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/reconciliation-events',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        paymentId: PAYMENT_ID,
        rail: 'mpp_demo',
        eventType: 'merchant_retry_rejected_after_payment',
        txHash: TX_HASH,
        reason: 'Merchant returned HTTP 402 after approval-funded payment',
        details: { retryStatus: 402, resourceUrl: challenge.resource },
      },
    })

    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({
      event_id: 'event-approval',
      payment_id: PAYMENT_ID,
      event_type: 'merchant_retry_rejected_after_payment',
    })

    const insert = findCall(/INSERT INTO machine_payment_reconciliation_events/)
    expect(insert).toBeDefined()
    expect(insert!.sql).toContain('approval_request_id')
    expect(insert!.sql).toContain('ON CONFLICT (approval_request_id, event_type)')
    expect(insert!.sql).toContain("machine_payment_reconciliation_events.status <> 'resolved'")
    expect(insert!.params).toContain(PAYMENT_ID)
    expect(insert!.params).toContain('merchant_retry_rejected_after_payment')
  })

  it('does not reopen resolved reconciliation events for confirmed payments', async () => {
    primeDb(
      AUTH,
      intentById(confirmedPayment()),
      [/INSERT INTO machine_payment_reconciliation_events/, () => ({ rows: [] })], // already resolved — guarded upsert matched nothing
      [/FROM machine_payment_reconciliation_events/, () => ({
        rows: [{ id: 'event-resolved', status: 'resolved', created_at: '2026-05-15T12:00:00.000Z' }],
      })],
    )

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/reconciliation-events',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        paymentId: PAYMENT_ID,
        rail: 'mpp_demo',
        eventType: 'merchant_retry_rejected_after_payment',
        txHash: TX_HASH,
        reason: 'Merchant returned HTTP 402 after a resolved event',
        details: { retryStatus: 402, retryAttempt: 2 },
      },
    })

    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({
      event_id: 'event-resolved',
      status: 'resolved',
      payment_id: PAYMENT_ID,
    })
    const upsert = findCall(/INSERT INTO machine_payment_reconciliation_events/)
    expect(upsert!.sql).toContain("machine_payment_reconciliation_events.status <> 'resolved'")
    const reload = findCall(/FROM machine_payment_reconciliation_events/)
    expect(reload).toBeDefined()
    expect(reload!.sql).toContain('WHERE payment_intent_id = $1')
    expect(reload!.params).toEqual([PAYMENT_ID, AGENT.id, 'merchant_retry_rejected_after_payment'])
  })

  it('does not reopen resolved reconciliation events for executed approval requests', async () => {
    primeDb(
      AUTH,
      intentById(null),
      approvalById(executedApproval()),
      [/INSERT INTO machine_payment_reconciliation_events/, () => ({ rows: [] })],
      [/FROM machine_payment_reconciliation_events/, () => ({
        rows: [{ id: 'event-approval-resolved', status: 'resolved', created_at: '2026-05-15T12:00:00.000Z' }],
      })],
    )

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/reconciliation-events',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        paymentId: PAYMENT_ID,
        rail: 'mpp_demo',
        eventType: 'merchant_retry_rejected_after_payment',
        txHash: TX_HASH,
        reason: 'Merchant returned HTTP 402 after a resolved approval event',
      },
    })

    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({
      event_id: 'event-approval-resolved',
      status: 'resolved',
      payment_id: PAYMENT_ID,
    })
    const upsert = findCall(/INSERT INTO machine_payment_reconciliation_events/)
    expect(upsert!.sql).toContain("machine_payment_reconciliation_events.status <> 'resolved'")
    const reload = findCall(/FROM machine_payment_reconciliation_events/)
    expect(reload).toBeDefined()
    expect(reload!.sql).toContain('WHERE approval_request_id = $1')
    expect(reload!.params).toEqual([PAYMENT_ID, AGENT.id, 'merchant_retry_rejected_after_payment'])
  })

  it('attaches SDK-reported merchant evidence for confirmed machine payments', async () => {
    primeDb(
      AUTH,
      intentById(confirmedPayment()),
      [/UPDATE machine_payment_evidence/, () => ({
        rows: [{
          id: 'evidence-123',
          payment_intent_id: PAYMENT_ID,
          agent_id: AGENT.id,
          user_id: AGENT.user_id,
          rail: 'mpp_demo',
          proof_status: 'protocol_receipt_attached',
          tx_hash: TX_HASH,
          chain_id: 8453,
          resource_url: challenge.resource,
          merchant_address: RECIPIENT.toLowerCase(),
          payer_address: AGENT.safe_address.toLowerCase(),
          settlement_address: RECIPIENT.toLowerCase(),
          token_symbol: 'USDC',
          token_address: USDC.toLowerCase(),
          amount_raw: '10000',
          amount_human: '0.01',
          challenge_id: challenge.challengeId,
          idempotency_key: 'mpp_demo:test',
          challenge_payload: challenge,
          selected_payment: null,
          payment_proof_header_name: 'MACHINE-PAYMENT-PROOF',
          payment_proof_header: 'proof-header',
          protocol_receipt_header_name: 'Payment-Receipt',
          protocol_receipt_header: 'receipt-header',
          protocol_receipt_payload: { status: 'settled' },
          merchant_status: 200,
          confirmed_at: '2026-05-15T12:00:00.000Z',
          created_at: '2026-05-15T12:00:00.000Z',
          updated_at: '2026-05-15T12:00:01.000Z',
        }],
      })],
    )

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/evidence',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        paymentId: PAYMENT_ID,
        rail: 'mpp_demo',
        txHash: TX_HASH,
        resourceUrl: challenge.resource,
        merchantStatus: 200,
        challengePayload: challenge,
        paymentProofHeaderName: 'MACHINE-PAYMENT-PROOF',
        paymentProofHeader: 'proof-header',
        protocolReceiptHeaderName: 'Payment-Receipt',
        protocolReceiptHeader: 'receipt-header',
        protocolReceiptPayload: { status: 'settled' },
      },
    })

    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({
      evidence: {
        payment_id: PAYMENT_ID,
        rail: 'mpp_demo',
        proof_status: 'protocol_receipt_attached',
        tx_hash: TX_HASH,
        payment_proof_header_name: 'MACHINE-PAYMENT-PROOF',
        protocol_receipt_header_name: 'Payment-Receipt',
        protocol_receipt_payload: { status: 'settled' },
      },
    })

    expect(findCall(/INSERT INTO machine_payment_evidence/)).toBeDefined()
    const attach = findCall(/UPDATE machine_payment_evidence/)
    expect(attach).toBeDefined()
    const resolve = findCall(/UPDATE machine_payment_reconciliation_events/)
    expect(resolve).toBeDefined()
    expect(resolve!.sql).toContain("status = 'resolved'")
    expect(resolve!.sql).toContain('WHERE payment_intent_id = $1')
  })

  it('attaches SDK-reported merchant evidence for executed approval requests', async () => {
    primeDb(
      AUTH,
      intentById(null),
      approvalById(executedApproval()),
      [/UPDATE machine_payment_evidence/, () => ({
        rows: [{
          id: 'evidence-approval',
          payment_intent_id: null,
          approval_request_id: PAYMENT_ID,
          agent_id: AGENT.id,
          user_id: AGENT.user_id,
          rail: 'mpp_demo',
          proof_status: 'protocol_receipt_attached',
          tx_hash: TX_HASH,
          chain_id: 8453,
          resource_url: challenge.resource,
          merchant_address: RECIPIENT.toLowerCase(),
          payer_address: AGENT.safe_address.toLowerCase(),
          settlement_address: RECIPIENT.toLowerCase(),
          token_symbol: 'USDC',
          token_address: USDC.toLowerCase(),
          amount_raw: '10000',
          amount_human: '0.01',
          challenge_id: challenge.challengeId,
          idempotency_key: 'mpp_demo:test',
          challenge_payload: challenge,
          selected_payment: null,
          payment_proof_header_name: 'MACHINE-PAYMENT-PROOF',
          payment_proof_header: 'proof-header',
          protocol_receipt_header_name: 'Payment-Receipt',
          protocol_receipt_header: 'receipt-header',
          protocol_receipt_payload: { status: 'settled' },
          merchant_status: 200,
          confirmed_at: '2026-05-15T12:00:00.000Z',
          created_at: '2026-05-15T12:00:00.000Z',
          updated_at: '2026-05-15T12:00:01.000Z',
        }],
      })],
    )

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/evidence',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        paymentId: PAYMENT_ID,
        rail: 'mpp_demo',
        txHash: TX_HASH,
        resourceUrl: challenge.resource,
        merchantStatus: 200,
        paymentProofHeaderName: 'MACHINE-PAYMENT-PROOF',
        paymentProofHeader: 'proof-header',
        protocolReceiptHeaderName: 'Payment-Receipt',
        protocolReceiptHeader: 'receipt-header',
        protocolReceiptPayload: { status: 'settled' },
      },
    })

    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({
      evidence: {
        payment_id: PAYMENT_ID,
        payment_intent_id: null,
        approval_request_id: PAYMENT_ID,
        proof_status: 'protocol_receipt_attached',
      },
    })
    const attach = findCall(/UPDATE machine_payment_evidence/)
    expect(attach).toBeDefined()
    expect(attach!.sql).toContain('approval_request_id')
    expect(attach!.sql).toContain('WHERE approval_request_id = $1')
    const resolve = findCall(/UPDATE machine_payment_reconciliation_events/)
    expect(resolve).toBeDefined()
    expect(resolve!.sql).toContain("status = 'resolved'")
    expect(resolve!.sql).toContain('WHERE approval_request_id = $1')
  })

  it('rejects evidence reports whose tx hash does not match the payment', async () => {
    primeDb(AUTH, intentById(confirmedPayment()))

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/evidence',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        paymentId: PAYMENT_ID,
        rail: 'mpp_demo',
        txHash: `0x${'cd'.repeat(32)}`,
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toBe('txHash does not match payment intent')
    // The rejection must be write-free — a guard that still writes is the
    // regression class this asserts against (review finding on #1292).
    expect(sqlCalls().some((c) => /INSERT|UPDATE|DELETE/i.test(c.sql))).toBe(false)
  })

  it('rejects evidence reports for unconfirmed payments', async () => {
    primeDb(AUTH, intentById(confirmedPayment({ status: 'pending_signature', tx_hash: null })))

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/evidence',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        paymentId: PAYMENT_ID,
        rail: 'mpp_demo',
        txHash: TX_HASH,
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toBe('Evidence requires a confirmed payment')
    expect(sqlCalls().some((c) => /INSERT|UPDATE|DELETE/i.test(c.sql))).toBe(false)
  })

  it('does not attach evidence to another agent payment', async () => {
    primeDb(AUTH, intentById(null), approvalById(null))

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/evidence',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        paymentId: PAYMENT_ID,
        rail: 'mpp_demo',
        txHash: TX_HASH,
      },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json().error).toBe('Payment not found')
    expect(sqlCalls().some((c) => /INSERT|UPDATE|DELETE/i.test(c.sql))).toBe(false)
  })

  // ── attachMachinePaymentEvidence rejection paths (#997) ─────────────────────
  // Before this pass only tx_hash_mismatch, payment_not_confirmed and the
  // "not found" 404 were pinned. unsupported_rail, tx_hash_invalid,
  // rail_mismatch and resource_mismatch had zero coverage — each is an
  // attach-time authorization check (this evidence report belongs to THIS
  // exact settled payment) that a refactor could silently loosen.

  it('rejects an unsupported evidence rail before any payment lookup (400)', async () => {
    primeDb(AUTH)

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/evidence',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        paymentId: PAYMENT_ID,
        rail: 'stripe_deposit', // a real MachinePaymentRail, but NOT evidence-eligible
        txHash: TX_HASH,
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('Unsupported evidence rail')
    expect(mockQuery).toHaveBeenCalledTimes(1) // only the auth lookup
  })

  it('rejects a malformed txHash before any payment lookup (400)', async () => {
    primeDb(AUTH)

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/evidence',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        paymentId: PAYMENT_ID,
        rail: 'mpp_demo',
        txHash: '0xnothex',
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('txHash must be a 0x-prefixed transaction hash')
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it('rejects an out-of-range merchantStatus before any payment lookup (400)', async () => {
    primeDb(AUTH)

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/evidence',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        paymentId: PAYMENT_ID,
        rail: 'mpp_demo',
        txHash: TX_HASH,
        merchantStatus: 999,
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('merchantStatus must be an HTTP status code')
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it('rejects evidence whose rail does not match the payment intent\'s actual rail (409)', async () => {
    primeDb(AUTH, intentById(confirmedPayment({ payment_rail: 'mpp_demo', source: 'mpp_demo' })))

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/evidence',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        paymentId: PAYMENT_ID,
        rail: 'x402', // a real evidence-eligible rail, just the WRONG one for this payment
        txHash: TX_HASH,
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toBe('rail does not match payment intent')
  })

  it('rejects evidence whose resourceUrl does not match the payment intent (409)', async () => {
    primeDb(AUTH, intentById(confirmedPayment()))

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/evidence',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        paymentId: PAYMENT_ID,
        rail: 'mpp_demo',
        txHash: TX_HASH,
        resourceUrl: 'https://a-different-merchant.example/resource',
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toBe('resourceUrl does not match payment intent')
  })

  // ── POST /:id/merchant-receipt (#956) — zero HTTP-layer coverage before ────
  // #997. `captureMerchantReceipt` itself was unit-tested
  // (lib/__tests__/merchant-receipt.test.ts, now modules/mpp/__tests__/), but
  // the ROUTE'S OWN wiring — status-code mapping and the #956 late-attach
  // fire-and-forget call — had none.
  describe('POST /machine-payments/:id/merchant-receipt (#956)', () => {
    it('rejects a request with neither url nor json (400), no evidence lookup', async () => {
      primeDb(AUTH)

      const response = await app.inject({
        method: 'POST',
        url: `/machine-payments/${PAYMENT_ID}/merchant-receipt`,
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: {},
      })

      expect(response.statusCode).toBe(400)
      expect(mockQuery).toHaveBeenCalledTimes(1)
      expect(reportingMocks.lateAttachMerchantReceipt).not.toHaveBeenCalled()
    })

    it('404s when no settled evidence exists for the payment', async () => {
      primeDb(AUTH, [/FROM machine_payment_evidence mpe/, () => ({ rows: [] })]) // findEvidenceAnchorForAgent miss

      const response = await app.inject({
        method: 'POST',
        url: `/machine-payments/${PAYMENT_ID}/merchant-receipt`,
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: { json: { fakturanummer: 'FAK-1' } },
      })

      expect(response.statusCode).toBe(404)
      expect(reportingMocks.lateAttachMerchantReceipt).not.toHaveBeenCalled()
    })

    it('stores a first-reported receipt (201) and fires the #956 late-attach', async () => {
      primeDb(
        AUTH,
        [/FROM machine_payment_evidence mpe/, () => ({ rows: [{ id: 'evidence-1', user_id: AGENT.user_id }] })],
        [/INSERT INTO merchant_receipts/, () => ({ rows: [{ evidence_id: 'evidence-1' }] })], // insert won
      )

      const response = await app.inject({
        method: 'POST',
        url: `/machine-payments/${PAYMENT_ID}/merchant-receipt`,
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: { json: { fakturanummer: 'FAK-1' } },
      })

      expect(response.statusCode).toBe(201)
      expect(response.json()).toEqual({ stored: true })
      await vi.waitFor(() => {
        expect(reportingMocks.lateAttachMerchantReceipt).toHaveBeenCalledWith(
          AGENT.user_id,
          PAYMENT_ID,
          { url: null, inlineJson: { fakturanummer: 'FAK-1' } },
        )
      })
    })

    it('first write wins: a duplicate report (200) does NOT re-fire the late-attach', async () => {
      primeDb(
        AUTH,
        [/FROM machine_payment_evidence mpe/, () => ({ rows: [{ id: 'evidence-1', user_id: AGENT.user_id }] })],
        [/INSERT INTO merchant_receipts/, () => ({ rows: [] })], // ON CONFLICT DO NOTHING — already recorded
      )

      const response = await app.inject({
        method: 'POST',
        url: `/machine-payments/${PAYMENT_ID}/merchant-receipt`,
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: { json: { fakturanummer: 'FAK-2' } },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ stored: false })
      expect(response.json().message).toMatch(/first write wins/)
      expect(reportingMocks.lateAttachMerchantReceipt).not.toHaveBeenCalled()
    })
  })

  it('does not record reconciliation events for unconfirmed payments', async () => {
    primeDb(AUTH, intentById(confirmedPayment({ status: 'pending_signature', tx_hash: null })))

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/reconciliation-events',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        paymentId: PAYMENT_ID,
        rail: 'mpp_demo',
        eventType: 'merchant_retry_rejected_after_payment',
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({
      error: 'Reconciliation events require a confirmed payment',
      status: 'pending_signature',
    })
    expect(sqlCalls().some((c) => /INSERT|UPDATE|DELETE/i.test(c.sql))).toBe(false)
  })

  it('rejects reconciliation events whose tx hash does not match the payment', async () => {
    primeDb(AUTH, intentById(confirmedPayment()))

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/reconciliation-events',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        paymentId: PAYMENT_ID,
        rail: 'mpp_demo',
        eventType: 'merchant_retry_rejected_after_payment',
        txHash: `0x${'cd'.repeat(32)}`,
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toBe('txHash does not match payment intent')
    expect(sqlCalls().some((c) => /INSERT|UPDATE|DELETE/i.test(c.sql))).toBe(false)
  })

  // ── POST /send ─────────────────────────────────────────────────────────────

  describe('POST /machine-payments/send', () => {
    const SEND_PAYMENT_ID = '44444444-4444-4444-4444-444444444444'
    const SEND_HASH = `0x${'22'.repeat(32)}`
    const SEND_RECIPIENT = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'

    function sendIntentRow(overrides: Record<string, unknown> = {}) {
      return {
        id: SEND_PAYMENT_ID,
        status: 'pending_signature',
        expires_at: '2099-01-01T00:10:00.000Z',
        ...overrides,
      }
    }

    function allowanceWithRemaining(remaining: bigint) {
      allowanceMocks.getTokenAllowance.mockResolvedValue({
        amount: 1_000_000n,
        spent: 0n,
        resetTimeMin: 1440,
        lastResetMin: 0,
        nonce: 5,
      })
      allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({
        remaining,
        effectiveSpent: 0n,
        isResetPending: false,
      })
    }

    it('409s a key reused for a DIFFERENT transfer — including one created via POST /payments (#1207)', async () => {
      // The key column is shared with POST /payments (migration 020). The
      // mismatch refusal must hold in BOTH routes, or a /payments-created key
      // replays here with the new request's labels on the old sign_data
      // (review finding on #1207 — this test fails on the pre-fix code).
      primeDb(
        AUTH,
        sendIntentLookup([{
          id: SEND_PAYMENT_ID,
          status: 'pending_signature',
          expires_at: '2099-01-01T00:10:00.000Z',
          token_address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
          token_symbol: 'USDC',
          to_address: '0x0000000000000000000000000000000000000abc',
          amount_raw: '10000000',
          amount_human: '10',
          allowance_nonce: 5,
          sign_hash: SEND_HASH,
          execution_rail: null,
          prepared_user_op: null,
          chain_id: 8453,
        }]),
      )

      const response = await app.inject({
        method: 'POST',
        url: '/machine-payments/send',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: {
          asset: 'USDC',
          recipient: SEND_RECIPIENT,
          amount: '1.50',
          idempotency_key: 'shared-key-1',
        },
      })

      expect(response.statusCode).toBe(409)
      expect(response.json().error).toMatch(/different recipient|different amount/)
      // Nothing minted, no chain read.
      expect(allowanceMocks.getTokenAllowance).not.toHaveBeenCalled()
    })

    it('creates a USDC payment intent within allowance and returns sign_data', async () => {
      allowanceWithRemaining(1_000_000_000n)
      allowanceMocks.generateTransferHash.mockResolvedValue(SEND_HASH)

      primeDb(AUTH, allowanceConfigured(true), insertIntent(sendIntentRow()))

      const response = await app.inject({
        method: 'POST',
        url: '/machine-payments/send',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: { asset: 'USDC', recipient: SEND_RECIPIENT, amount: '1.50' },
      })

      expect(response.statusCode).toBe(201)
      const body = response.json()
      expect(body.payment_id).toBe(SEND_PAYMENT_ID)
      expect(body.status).toBe('pending_signature')
      expect(body.asset).toBe('USDC')
      expect(body.amount).toBe('1.50')
      expect(body.recipient).toBe(SEND_RECIPIENT.toLowerCase())
      expect(body.sign_data.hash).toBe(SEND_HASH)
      expect(body.sign_data.instructions).toContain('delegate private key')
      expect(allowanceMocks.generateTransferHash).toHaveBeenCalledTimes(1)
    })

    it('queues over-allowance transfer as pending_approval (202)', async () => {
      allowanceWithRemaining(0n)

      primeDb(
        AUTH,
        allowanceConfigured(true),
        insertApproval({ id: SEND_PAYMENT_ID, status: 'pending', expires_at: '2099-01-02T00:00:00.000Z' }),
      )

      const response = await app.inject({
        method: 'POST',
        url: '/machine-payments/send',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: { asset: 'USDC', recipient: SEND_RECIPIENT, amount: '999' },
      })

      expect(response.statusCode).toBe(202)
      const body = response.json()
      expect(body.status).toBe('pending_approval')
      expect(body.payment_id).toBe(SEND_PAYMENT_ID)
      expect(body.asset).toBe('USDC')
      expect(allowanceMocks.generateTransferHash).not.toHaveBeenCalled()
    })

    it('rejects unknown asset with 400', async () => {
      primeDb(AUTH)

      const response = await app.inject({
        method: 'POST',
        url: '/machine-payments/send',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: { asset: 'DOGE', recipient: SEND_RECIPIENT, amount: '1' },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toContain('ETH, USDC')
      expect(allowanceMocks.getTokenAllowance).not.toHaveBeenCalled()
    })

    it('rejects invalid recipient address with 400', async () => {
      primeDb(AUTH)

      const response = await app.inject({
        method: 'POST',
        url: '/machine-payments/send',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: { asset: 'USDC', recipient: 'not-an-address', amount: '1' },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toContain('recipient')
    })

    it('rejects missing amount with 400', async () => {
      primeDb(AUTH)

      const response = await app.inject({
        method: 'POST',
        url: '/machine-payments/send',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: { asset: 'USDC', recipient: SEND_RECIPIENT },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toContain('amount')
    })

    it('rejects when agent has no allowance configured for the token', async () => {
      primeDb(AUTH, allowanceConfigured(false))

      const response = await app.inject({
        method: 'POST',
        url: '/machine-payments/send',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: { asset: 'USDC', recipient: SEND_RECIPIENT, amount: '1' },
      })

      expect(response.statusCode).toBe(403)
      expect(response.json().error).toContain('not configured')
    })

    // ── Idempotency ──────────────────────────────────────────────────────────

    function existingIntentRow(overrides: Record<string, unknown> = {}) {
      return {
        id: SEND_PAYMENT_ID,
        status: 'pending_signature',
        expires_at: '2099-01-01T00:10:00.000Z',
        token_address: USDC,
        to_address: SEND_RECIPIENT.toLowerCase(),
        amount_raw: '1500000',
        amount_human: '1.50',
        allowance_nonce: 5,
        sign_hash: SEND_HASH,
        ...overrides,
      }
    }

    it('replays an idempotent request and returns the original intent without re-reading chain', async () => {
      primeDb(AUTH, sendIntentLookup([existingIntentRow()]))

      const response = await app.inject({
        method: 'POST',
        url: '/machine-payments/send',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: { asset: 'USDC', recipient: SEND_RECIPIENT, amount: '1.50', idempotency_key: 'send-key-1' },
      })

      expect(response.statusCode).toBe(201)
      const body = response.json()
      expect(body.payment_id).toBe(SEND_PAYMENT_ID)
      expect(body.idempotent_replay).toBe(true)
      expect(body.sign_data.hash).toBe(SEND_HASH)
      expect(body.sign_data.components.nonce).toBe(5)
      // No second intent minted and no on-chain reads on a replay.
      expect(allowanceMocks.getTokenAllowance).not.toHaveBeenCalled()
      expect(allowanceMocks.generateTransferHash).not.toHaveBeenCalled()
      expect(mockQuery).toHaveBeenCalledTimes(2) // auth + single dedup lookup
    })

    it('persists the idempotency_key when creating a new intent', async () => {
      allowanceWithRemaining(1_000_000_000n)
      allowanceMocks.generateTransferHash.mockResolvedValue(SEND_HASH)

      primeDb(
        AUTH,
        sendIntentLookup([]),
        sendApprovalLookup([]),
        allowanceConfigured(true),
        insertIntent(sendIntentRow()),
      )

      const response = await app.inject({
        method: 'POST',
        url: '/machine-payments/send',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: { asset: 'USDC', recipient: SEND_RECIPIENT, amount: '1.50', idempotency_key: 'send-key-2' },
      })

      expect(response.statusCode).toBe(201)
      const insert = findCall(/INSERT INTO payment_intents/)
      expect(insert).toBeDefined()
      expect(insert!.params).toContain('send-key-2')
    })

    it('replays the winner when a concurrent insert wins the idempotency race', async () => {
      allowanceWithRemaining(1_000_000_000n)
      allowanceMocks.generateTransferHash.mockResolvedValue(SEND_HASH)

      const uniqueViolation = Object.assign(new Error('duplicate key value'), { code: '23505' })
      // findSendIntentByIdempotencyKey runs TWICE with the identical
      // statement: once up front (a fresh key — nothing found) and again
      // after the INSERT loses the unique-index race. A stateful counter is
      // the only way a content-dispatch stub can answer one statement
      // differently across its two calls (#1226 style).
      let intentReads = 0
      primeDb(
        AUTH,
        [/send_idempotency_key = \$2[\s\S]*FROM payment_intents|FROM payment_intents[\s\S]*send_idempotency_key = \$2/, () => {
          intentReads += 1
          return { rows: intentReads > 1 ? [existingIntentRow()] : [] }
        }],
        sendApprovalLookup([]),
        allowanceConfigured(true),
        [/INSERT INTO payment_intents/, () => {
          throw uniqueViolation // INSERT loses the race
        }],
      )

      const response = await app.inject({
        method: 'POST',
        url: '/machine-payments/send',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: { asset: 'USDC', recipient: SEND_RECIPIENT, amount: '1.50', idempotency_key: 'send-key-3' },
      })

      expect(response.statusCode).toBe(201)
      expect(response.json().payment_id).toBe(SEND_PAYMENT_ID)
      expect(response.json().idempotent_replay).toBe(true)
    })

    it('rejects an empty idempotency_key with 400', async () => {
      primeDb(AUTH)

      const response = await app.inject({
        method: 'POST',
        url: '/machine-payments/send',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: { asset: 'USDC', recipient: SEND_RECIPIENT, amount: '1', idempotency_key: '' },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toContain('idempotency_key')
      expect(allowanceMocks.getTokenAllowance).not.toHaveBeenCalled()
    })

    it('reports the real status (not a stale sign request) when replaying an already-confirmed intent', async () => {
      primeDb(
        AUTH,
        sendIntentLookup([existingIntentRow({ status: 'confirmed' })]),
        intentStatusRow(confirmedPayment({ expires_at: '2099-01-02T00:00:00.000Z' })),
      )

      const response = await app.inject({
        method: 'POST',
        url: '/machine-payments/send',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: { asset: 'USDC', recipient: SEND_RECIPIENT, amount: '1.50', idempotency_key: 'send-key-confirmed' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body.status).toBe('confirmed')
      expect(body.phase).toBe('payment_confirmed')
      expect(body.idempotent_replay).toBe(true)
      // Must NOT re-emit a sign request for a settled payment.
      expect(body.sign_data).toBeUndefined()
      expect(allowanceMocks.generateTransferHash).not.toHaveBeenCalled()
    })

    it('reports the real status (not still-pending) when replaying an approval the owner already executed', async () => {
      primeDb(
        AUTH,
        sendIntentLookup([]),
        // approval_requests dedup hits, but it has already been executed.
        // #1207: the bidirectional mismatch check reads these — they must
        // match the request or the replay is (correctly) refused as 409.
        sendApprovalLookup([{
          id: 'approval-exec',
          status: 'executed',
          expires_at: '2099-01-02T00:00:00.000Z',
          token_symbol: 'USDC',
          amount_human: '999',
          token_address: USDC,
          to_address: SEND_RECIPIENT.toLowerCase(),
          amount_raw: '999000000',
        }]),
        intentStatusRow(null),
        approvalById({
          id: 'approval-exec',
          chain_id: 8453,
          token_symbol: 'USDC',
          token_address: USDC,
          amount_human: '999',
          amount_raw: '999000000',
          status: 'executed',
          tx_hash: TX_HASH,
          expires_at: '2099-01-02T00:00:00.000Z',
          source: 'agent_transfer',
          payment_rail: null,
          payment_resource_url: null,
          x402_resource_url: null,
          merchant_address: null,
          machine_challenge_id: null,
          machine_idempotency_key: null,
          machine_metadata: null,
        }),
      )

      const response = await app.inject({
        method: 'POST',
        url: '/machine-payments/send',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: { asset: 'USDC', recipient: SEND_RECIPIENT, amount: '999', idempotency_key: 'send-key-executed' },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json()
      expect(body.kind).toBe('approval_request')
      expect(body.status).toBe('executed')
      expect(body.idempotent_replay).toBe(true)
      // Must NOT tell the agent to keep waiting for an approval that already completed.
      expect(body.next_action).not.toBe('wait_for_user_approval')
    })
  })
})
