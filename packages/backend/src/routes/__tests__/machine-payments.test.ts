import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import machinePaymentRoutes from '../machine-payments.js'
// #1444: validate the real payload against the spec's own schema.
import { expectMatchesSpec } from '../../openapi/response-shape.js'
// #1987 (epic #1440 slice #1987): `modules/mpp/authorize.ts` — and its
// exported `authorizeMachinePayment` / `AuthorizeMachinePaymentInput` — is
// DELETED. It had no production caller left: `POST /machine-payments/authorize`
// has been a #1328 `mppDemoRetired()` stub since before this slice, and #1986
// put an HTTP 410 on the legacy rail underneath it. The block of tests that
// called `authorizeMachinePayment` directly (intent creation, idempotency
// replay, stale-sign-data refresh, insert-conflict reload, over-allowance
// approval queueing, rejected-approval retry, malformed-payTo/merchantPayTo
// rejection, wrong-delegate signature, one-shot signature recording,
// one-shot execution-failure handling, and terminal-state races) was removed
// in this pass — those cases exercised orchestration that no longer exists,
// not coverage that was silently dropped. The route-level 410/422 refusals
// on POST /send and POST /machine-payments/authorize below are UNCHANGED and
// still prove the retirement from the HTTP surface.
// #1986: the ONE producer of the Safe-rail refusal body — every converted
// legacy-rail characterization below compares against this, never a
// copy-pasted string.
import { allowanceModuleRailRetired } from '../../rails/execution-rail.js'

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

/** hasTokenAllowanceConfigured (send + authorize policy gate). */
const allowanceConfigured = (configured: boolean): DbRoute => [
  /LOWER\(token_address\) = LOWER\(\$2\)/,
  () => ({ rows: configured ? [{ allowance_amount: '10000' }] : [] }),
]

// #2020: `allowanceConfigRows` (listAllowanceConfigForAgent, GET /allowances
// on the legacy rail) is gone — that rail's allowances read is retired and
// the SQL it primed no longer runs; see "GET /allowances — Safe rail retired
// (#2020, reversing #1986)" below.

/** deriveDelegationBudgets / listDelegationJsonByIds (GET /allowances, delegation rail). */
const delegationRows = (rows: unknown[]): DbRoute => [/FROM agent_delegations/, () => ({ rows })]

/** INSERT INTO payment_intents (send's plain insert, or authorize's ON CONFLICT machine insert). */
const insertIntent = (row: Record<string, unknown> | null): DbRoute => [
  /INSERT INTO payment_intents/,
  () => ({ rows: row ? [row] : [] }),
]
// #2055 (epic #1440, #2021 readability waiver): `insertApproval`,
// `sendApprovalLookup` and `approvalById` below route SQL shapes that no code
// in `src` can issue any more — `approval_requests` is dropped, and every
// function that queried it (`findSendApprovalByIdempotencyKey`,
// `findApprovalStatusRow`, `findReconciliationApproval`,
// `findApprovalForEvidenceScoped`) is deleted. They were ALREADY unreachable
// on the mocked-out legacy rail before this slice (#1986 fail-closes the
// account gate first); #2055 makes them doubly so. Kept, not deleted: the
// few call sites still using them prime a route that can never fire either
// way, and rewriting every one of those sites was judged higher-risk than
// leaving a no-op prime that documents its own history. New tests should not
// add more.
/** INSERT INTO approval_requests (send's plain insert, or authorize's ON CONFLICT machine insert). */
const insertApproval = (row: Record<string, unknown> | null): DbRoute => [
  /INSERT INTO approval_requests/,
  () => ({ rows: row ? [row] : [] }),
]
/** findSendIntentByIdempotencyKey (POST /send idempotency lookup). */
const sendIntentLookup = (rows: unknown[]): DbRoute => [
  /send_idempotency_key = \$2[\s\S]*FROM payment_intents|FROM payment_intents[\s\S]*send_idempotency_key = \$2/,
  () => ({ rows }),
]
/** findSendApprovalByIdempotencyKey (POST /send idempotency lookup) — gone, see above. */
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
 * — all three are gone (see above); this matched the shared
 * `id = $1 AND agent_id = $2` shape they queried against approval_requests.
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
      delegate_address: AGENT.delegate_address,
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
    expectMatchesSpec('GET', '/machine-payments/agent', response.json())
    expect(response.json()).toEqual({
      id: AGENT.id,
      name: AGENT.name,
      status: AGENT.status,
      safe_address: AGENT.safe_address,
      delegate_address: AGENT.delegate_address,
      // #1472: null here BECAUSE the fixture buckets into legacy — the
      // delegate account only exists on the delegation rail.
      delegate_account_address: null,
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

  // #2020 (epic #1440), reversing #1986's left-readable decision (owner call
  // recorded 2026-08-25 on the issue): a `retired_allowance` account — the
  // implicit-null rail AUTH/AGENT resolves to, same as an explicit
  // 'allowance_module' — now gets the fail-closed 410 from
  // `allowanceModuleRailRetired('account')` rather than a state read. This
  // replaces both the standalone "returns configured allowances with
  // on-chain remaining spend" pin and the "GET /allowances — legacy-rail
  // characterization (#1135, pinned BEFORE the rail branch)" suite (the
  // byte-identical AllowanceModule snapshot, the empty-array-for-no-tokens
  // case, and the 502-on-chain-failure case) — all three pinned a read that
  // no longer happens on this rail.
  describe('GET /allowances — Safe rail retired (#2020, reversing #1986)', () => {
    function expectNoAllowanceStateRead() {
      expect(allowanceMocks.getTokenAllowance).not.toHaveBeenCalled()
      expect(allowanceMocks.getLatestBlockTimeSec).not.toHaveBeenCalled()
      expect(sqlCalls().some((c) => /FROM agent_allowances|FROM agent_delegations/.test(c.sql))).toBe(false)
    }

    it('an implicit retired-rail agent (no execution_rail column) gets the 410, not a chain read', async () => {
      primeDb(AUTH)

      const response = await app.inject({
        method: 'GET',
        url: '/machine-payments/allowances',
        headers: { authorization: 'Bearer sk_agent_test' },
      })

      const retired = allowanceModuleRailRetired('account')
      expect(response.statusCode).toBe(retired.statusCode)
      expect(response.json()).toEqual(retired.body)
      expectNoAllowanceStateRead()
    })

    it('an explicit allowance_module rail gets the same 410', async () => {
      primeDb(authAs({ ...AGENT, execution_rail: 'allowance_module' }))

      const response = await app.inject({
        method: 'GET',
        url: '/machine-payments/allowances',
        headers: { authorization: 'Bearer sk_agent_test' },
      })

      const retired = allowanceModuleRailRetired('account')
      expect(response.statusCode).toBe(retired.statusCode)
      expect(response.json()).toEqual(retired.body)
      expectNoAllowanceStateRead()
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

  // ── POST /authorize is retired (#1328) ──────────────────────────────────
  // Acceptance: "POST /machine-payments/authorize no longer accepts or
  // creates mpp_demo payments; no new legacy MPP demo challenge can be
  // authorized." The route now refuses UNCONDITIONALLY — fail-closed,
  // mirroring the #834 session-rail 410 pattern — before the body is even
  // inspected. (The generic MPP orchestrator this route used to delegate to,
  // `modules/mpp/authorize.ts`, was deleted outright in #1987 — see the file
  // header comment.)
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
      payer_address: AGENT.delegate_address,
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

  // #2055 (epic #1440, #2021 readability waiver): was "returns unified status
  // for approval request IDs", pinning `phase: 'user_approval_required'` /
  // `next_action: 'wait_for_user_approval'` for a queued (`status: 'pending'`)
  // approval row. `approvalState()` — the only producer of that phase/action
  // pair — is deleted along with `findApprovalStatusRow`; `payment_intents`
  // has no equivalent status (its own "not yet signed" state is
  // `pending_signature`, which maps to `agent_signature_required` /
  // `sign_and_submit_payment` instead, already pinned in the sign-path
  // suite). There is nothing left to re-anchor: this exact status is
  // unreachable now, not just re-sourced, so the test is deleted rather than
  // converted. The `payment_intent`-sourced unified-status contract stays
  // proven above by "returns unified status for confirmed payment intents"
  // and "returns funded_but_unsettled phase...".

  // #2055: was primed with `approvalById(null)` alongside `intentStatusRow
  // (null)` — `findApprovalStatusRow` is gone, so there is no approval
  // fallback left to prime a route for; an id that resolves neither is 404
  // on the intent lookup alone.
  it('does not return status for another agent payment or approval', async () => {
    primeDb(AUTH, intentStatusRow(null))

    const response = await app.inject({
      method: 'GET',
      url: `/machine-payments/${PAYMENT_ID}/status`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: 'Payment or approval request not found' })
    expect(sqlCalls().some((c) => /approval_requests/i.test(c.sql))).toBe(false)
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

  // #2055 (epic #1440, #2021 readability waiver): was "records a
  // reconciliation event for executed approval requests rejected by the
  // merchant retry" — `findReconciliationApproval` is gone with
  // `approval_requests`, so `handleReconciliationEvent` has no approval
  // fallback left: a payment id that isn't a `payment_intents` row (which an
  // executed approval always was) is simply unknown now. There was no
  // existing 404 pin for this route (unlike `POST /evidence`'s "does not
  // attach evidence to another agent payment"), so this fills that gap
  // rather than being deleted outright.
  it('404s a reconciliation event for a payment id that is not a payment intent', async () => {
    primeDb(AUTH, intentById(null))

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/reconciliation-events',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        paymentId: PAYMENT_ID,
        rail: 'mpp_demo',
        eventType: 'merchant_retry_rejected_after_payment',
        txHash: TX_HASH,
        reason: 'Merchant returned HTTP 402',
      },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json().error).toBe('Payment not found')
    expect(sqlCalls().some((c) => /approval_requests/i.test(c.sql))).toBe(false)
    expect(sqlCalls().some((c) => /INSERT|UPDATE|DELETE/i.test(c.sql))).toBe(false)
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

  // #2055: was "does not reopen resolved reconciliation events for executed
  // approval requests" — same retirement as its sibling above
  // (`findReconciliationApproval` gone), and now fully redundant with the
  // 404 test that replaced it: there is no longer a way to reach the
  // approval-anchored reload query (`WHERE approval_request_id = $1`) at
  // all, resolved or not, so there is nothing left here to distinguish from
  // "payment not found". Deleted rather than converted.

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

  // #2055 (epic #1440, #2021 readability waiver): was "attaches SDK-reported
  // merchant evidence for executed approval requests" — `findApprovalForEvi
  // denceScoped` is gone with `approval_requests`, so `POST /evidence` has no
  // approval fallback left either: an approval-only id is unknown, same as
  // any other id that is not a `payment_intents` row. That is already pinned
  // below by "does not attach evidence to another agent payment", so this
  // test is deleted rather than converted to a duplicate 404 pin. The WRITE
  // side this test exercised (`UPDATE ... WHERE approval_request_id = $1`)
  // still exists in `infra/repositories/machine-payments.ts` — unreachable
  // through the route, on purpose, per #2055's instructions.

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
    // #2055: `approvalById(null)` dropped — `findApprovalForEvidenceScoped`
    // is gone with `approval_requests`, so the intent lookup alone decides.
    primeDb(AUTH, intentById(null))

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

    // #1986 (epic #1440 slice 3): the legacy AllowanceModule rail is
    // retired. `/send` refuses BEFORE it does anything else — before the
    // idempotency mismatch check, before resolving the asset, before any
    // allowance read or intent/approval write. These cases characterized
    // that legacy pre-refusal behaviour; machinery and the cases are
    // scheduled for deletion in #1987.
    describe('Safe rail retired (#1986) — send: fresh-request creation paths on the legacy rail', () => {
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

        // #1986: the mismatch check this test characterized never runs —
        // the rail refusal fires before the idempotency lookup even
        // executes. Was: 409 with a recipient/amount mismatch message.
        expect(response.statusCode).toBe(410)
        expect(response.json()).toEqual(allowanceModuleRailRetired('account').body)
        // Nothing minted, no chain read, no idempotency lookup.
        expect(allowanceMocks.getTokenAllowance).not.toHaveBeenCalled()
        expect(sqlCalls().some((c) => /send_idempotency_key/.test(c.sql))).toBe(false)
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

        // #1986: 410 fail-closed, nothing minted. Was: 201 with sign_data
        // for a signable pending_signature intent.
        expect(response.statusCode).toBe(410)
        expect(response.json()).toEqual(allowanceModuleRailRetired('account').body)
        expect(allowanceMocks.generateTransferHash).not.toHaveBeenCalled()
        expect(findCall(/INSERT INTO payment_intents/)).toBeUndefined()
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

        // #1986: no approval queue reachable for a retired-rail account —
        // 410 fail-closed, nothing queued. Was: 202 pending_approval with a
        // manufactured approval_requests row.
        expect(response.statusCode).toBe(410)
        expect(response.json()).toEqual(allowanceModuleRailRetired('account').body)
        expect(allowanceMocks.generateTransferHash).not.toHaveBeenCalled()
        expect(findCall(/INSERT INTO approval_requests/)).toBeUndefined()
      })
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

    // #1986 (epic #1440 slice 3): the legacy AllowanceModule rail is
    // retired. `/send` refuses BEFORE the allowance-configuration check even
    // runs. Machinery and this case are scheduled for deletion in #1987.
    describe('Safe rail retired (#1986) — send: allowance-configuration policy gate on the legacy rail', () => {
      it('rejects when agent has no allowance configured for the token', async () => {
        primeDb(AUTH, allowanceConfigured(false))

        const response = await app.inject({
          method: 'POST',
          url: '/machine-payments/send',
          headers: { authorization: 'Bearer sk_agent_test' },
          payload: { asset: 'USDC', recipient: SEND_RECIPIENT, amount: '1' },
        })

        // #1986: the rail refusal fires before hasTokenAllowanceConfigured
        // is even queried. Was: 403 "not configured".
        expect(response.statusCode).toBe(410)
        expect(response.json()).toEqual(allowanceModuleRailRetired('account').body)
        expect(sqlCalls().some((c) => /LOWER\(token_address\) = LOWER\(\$2\)/.test(c.sql))).toBe(false)
      })
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

    // #1986 (epic #1440 slice 3): the legacy AllowanceModule rail is
    // retired. `/send`'s idempotency machinery (replay, persistence, and
    // the insert-conflict race) is unreachable on a retired-rail account —
    // the rail refusal fires first, before any idempotency lookup or write.
    // Machinery and these cases are scheduled for deletion in #1987.
    describe('Safe rail retired (#1986) — send: idempotency replay/persistence paths on the legacy rail', () => {
      it('replays an idempotent request and returns the original intent without re-reading chain', async () => {
        primeDb(AUTH, sendIntentLookup([existingIntentRow()]))

        const response = await app.inject({
          method: 'POST',
          url: '/machine-payments/send',
          headers: { authorization: 'Bearer sk_agent_test' },
          payload: { asset: 'USDC', recipient: SEND_RECIPIENT, amount: '1.50', idempotency_key: 'send-key-1' },
        })

        // #1986: no idempotency lookup happens at all — the rail refusal
        // fires first. Was: 201 with the original sign_data replayed.
        expect(response.statusCode).toBe(410)
        expect(response.json()).toEqual(allowanceModuleRailRetired('account').body)
        expect(allowanceMocks.getTokenAllowance).not.toHaveBeenCalled()
        expect(allowanceMocks.generateTransferHash).not.toHaveBeenCalled()
        expect(mockQuery).toHaveBeenCalledTimes(1) // auth only — no dedup lookup
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

        // #1986: nothing minted, so nothing to persist the key onto. Was:
        // 201 with the idempotency_key carried on the new insert.
        expect(response.statusCode).toBe(410)
        expect(response.json()).toEqual(allowanceModuleRailRetired('account').body)
        expect(findCall(/INSERT INTO payment_intents/)).toBeUndefined()
      })

      it('replays the winner when a concurrent insert wins the idempotency race', async () => {
        allowanceWithRemaining(1_000_000_000n)
        allowanceMocks.generateTransferHash.mockResolvedValue(SEND_HASH)

        const uniqueViolation = Object.assign(new Error('duplicate key value'), { code: '23505' })
        // Stateful counter kept from the original characterization (#1226
        // style) — it now proves the insert (and its conflict-reload) never
        // runs, because the rail refusal fires first.
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

        // #1986: the race this test characterized never happens — the
        // insert is never attempted. 410 fail-closed, zero idempotency
        // reads. Was: 201 with the winner's intent replayed.
        expect(response.statusCode).toBe(410)
        expect(response.json()).toEqual(allowanceModuleRailRetired('account').body)
        expect(intentReads).toBe(0)
      })
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

    // #1986 (epic #1440 slice 3): the legacy AllowanceModule rail is
    // retired. The real-status-on-replay reporting this describe block
    // characterized never runs for a retired-rail account — the rail
    // refusal fires before any replay lookup. Machinery and these cases are
    // scheduled for deletion in #1987.
    describe('Safe rail retired (#1986) — send: real-status-on-replay reporting on the legacy rail', () => {
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

        // #1986: no replay status lookup happens — 410 fail-closed. Was:
        // 200 reporting the real confirmed status.
        expect(response.statusCode).toBe(410)
        expect(response.json()).toEqual(allowanceModuleRailRetired('account').body)
        expect(allowanceMocks.generateTransferHash).not.toHaveBeenCalled()
        expect(sqlCalls().some((c) => /LEFT JOIN machine_payment_reconciliation_events/.test(c.sql))).toBe(false)
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

        // #1986: no approval-status lookup happens — 410 fail-closed. Was:
        // 200 reporting the real executed status.
        expect(response.statusCode).toBe(410)
        expect(response.json()).toEqual(allowanceModuleRailRetired('account').body)
        expect(
          sqlCalls().some((c) => /FROM approval_requests\s+WHERE id = \$1 AND agent_id = \$2/.test(c.sql)),
        ).toBe(false)
      })
    })
  })
})
