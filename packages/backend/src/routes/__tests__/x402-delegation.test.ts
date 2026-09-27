/**
 * #830 x402 delegation-rail settlement route. Mocks the network seams; the
 * settlement compiler runs REAL so the child delegation and header are genuine.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { expectMatchesSpec } from '../../openapi/response-shape.js'
import Fastify, { type FastifyInstance } from 'fastify'

const {
  mockQuery, mockSelect, mockCompute, mockCreateIntent, mockPrepareFunding, mockEnsureDeployed,
  mockReadRemaining, mockRecordRefusal,
} = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockSelect: vi.fn(),
  mockCompute: vi.fn(),
  mockCreateIntent: vi.fn(),
  mockPrepareFunding: vi.fn(),
  mockEnsureDeployed: vi.fn(),
  mockReadRemaining: vi.fn(),
  mockRecordRefusal: vi.fn(),
}))
vi.mock('../../db.js', () => ({ default: { query: (...a: unknown[]) => mockQuery(...a) } }))

// #1053 finding 3 gave /settle real signature verification, so the tests sign
// for REAL: a fixed-key delegate account whose address the agent mock carries.
// Dummy hex now (correctly) 400s — see the wrong-signer regression test.
import { privateKeyToAccount } from 'viem/accounts'
import { delegationSigningPayload } from '../../rails/delegation-policy.js'
import { settlementSalt, typedDataDigest } from '../../modules/x402/x402-delegation.js'
import { hashDelegation } from '@metamask/smart-accounts-kit/utils'
import { RelayerBudgetExceededError } from '../../infra/relayer-spend-guard.js'
const DELEGATE_SIGNER = privateKeyToAccount(('0x' + '11'.repeat(32)) as `0x${string}`)
async function signChild(child: unknown): Promise<`0x${string}`> {
  const payload = delegationSigningPayload(child as never, 84532)
  return DELEGATE_SIGNER.signTypedData({
    domain: payload.domain,
    types: payload.types,
    primaryType: payload.primaryType,
    message: payload.message as never,
  })
}
vi.mock('../../middleware/agentAuth.js', () => ({
  agentAuthMiddleware: async (request: { agent?: unknown }) => {
    request.agent = {
      id: 'agent-1', user_id: 'user-1', name: 'A',
      delegate_address: DELEGATE_SIGNER.address,
      account_address: '0x' + 'aa'.repeat(20),
      chain_id: 84532, status: 'active',
      execution_rail: 'delegation', account_type: 'delegator_hybrid',
    }
  },
}))
vi.mock('../../rails/delegation-authorization.js', () => ({
  selectDelegation: mockSelect,
  prepareDelegationPayment: mockPrepareFunding,
}))
// #2082: the erc7710 branch now reads the live remaining budget before it
// builds a settlement child. Mocked here rather than left to fall through:
// unmocked, every erc7710 test would make a real Base-Sepolia RPC call, take
// the 2s timeout, and fail OPEN — so the suite would pass without ever
// exercising the check it is meant to pin.
vi.mock('../../infra/chain/delegation-budget-reader.js', () => ({
  readRemainingBudget: (...a: unknown[]) => mockReadRemaining(...a),
}))
vi.mock('../../rails/hybrid-provisioning.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rails/hybrid-provisioning.js')>()
  return { ...actual, computeHybridAccountAddress: mockCompute, ensureHybridDeployed: mockEnsureDeployed }
})
// The delegation-rail authorize orchestration writes the intent via the
// repository directly now (#997 removed the `lib/machine-payments.js`
// pass-through wrapper) — mock the repository export it actually calls.
vi.mock('../../infra/repositories/payment-intents.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../infra/repositories/payment-intents.js')>()
  return { ...actual, insertMachineIntent: mockCreateIntent }
})
// #2945: the refusal ledger is fire-and-forget from the route's point of
// view — it can never throw into the handler (the real module swallows its
// own write failures). Mocked here so the tests can assert WHICH refusal was
// recorded (reason, source, detail allowlist) and that the response is
// identical whether the ledger succeeds or its write fails; the write itself
// is proven against real Postgres in the repository and ledger suites.
vi.mock('../../modules/payments/refusal-ledger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../modules/payments/refusal-ledger.js')>()
  return { ...actual, recordRefusalFireAndForget: (...a: unknown[]) => mockRecordRefusal(...a) }
})

const x402Routes = (await import('../x402.js')).default
const { installRequestValidation } = await import('../../openapi/request-validation.js')
const { buildBudgetDelegation } = await import('../../rails/delegation-policy.js')

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const MERCHANT = '0x' + 'cc'.repeat(20)
const DELEGATE_ACCT = '0x' + 'dd'.repeat(20)
const INTENT_ID = '33333333-3333-3333-3333-333333333333'
const NOW = Math.floor(Date.now() / 1000)

const signedBudget = {
  ...buildBudgetDelegation({
    agentId: 'agent-1', chainId: 84532, treasuryAddress: '0x' + 'aa'.repeat(20) as `0x${string}`,
    delegateAccountAddress: DELEGATE_ACCT as `0x${string}`, tokenAddress: USDC as `0x${string}`,
    budgetAtomic: 5_000_000n, periodSeconds: 86_400, startDate: NOW - 60,
    expiresAt: NOW + 86_400, version: 1,
  }),
  signature: '0x' + 'ab'.repeat(65),
}

function authorizeBody(overrides: Record<string, unknown> = {}) {
  return {
    url: 'https://merchant.example/resource',
    payTo: MERCHANT,
    amount: '100000',
    asset: USDC,
    network: 'eip155:84532',
    ...overrides,
  }
}

describe('x402 delegation-rail settlement (#830)', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    // 3009-mode responses carry the expected-context binding (#946); the
    // signer needs the dedicated key (test-only value, same as x402.test.ts).
    process.env.X402_BINDING_PRIVATE_KEY =
      '0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d'
    app = Fastify({ logger: false })
    // #3031: production wiring — `routes/x402.ts` is in `enforcedModules`,
    // so the request schema refuses off-spec shapes before the handler.
    installRequestValidation(app, { mode: 'enforce', enforcedModules: ['routes/x402.ts'] })
    await app.register(x402Routes, { prefix: '/x402' })
  })
  afterAll(async () => app.close())
  beforeEach(() => {
    mockQuery.mockReset()
    mockSelect.mockReset()
    mockCompute.mockReset()
    mockCreateIntent.mockReset()
    mockPrepareFunding.mockReset()
    mockEnsureDeployed.mockReset()
    mockReadRemaining.mockReset()
    mockRecordRefusal.mockReset()
    // #2082: default to a live enforcer read with the FULL 5 USDC budget
    // available — every existing case authorizes 0.1 USDC, so the pre-check
    // is a no-op for them and the erc7710 assertions below stay about what
    // they were about. The over-budget block overrides this.
    mockReadRemaining.mockResolvedValue({ remainingAtomic: '5000000', fromChain: true })
    mockCompute.mockResolvedValue(DELEGATE_ACCT)
    // #1667: default to an already-deployed delegate account; the regression
    // block below overrides this to exercise the counterfactual first payment.
    mockEnsureDeployed.mockResolvedValue({ address: DELEGATE_ACCT, alreadyDeployed: true })
    // #961: every delegation authorize consults the hourly cap; default to
    // an uncapped agent with no existing intents.
    mockQuery.mockImplementation((sql: string) => {
      if (/max_x402_per_hour/.test(String(sql))) return Promise.resolve({ rows: [{ max_x402_per_hour: 100 }] })
      if (/COUNT\(\*\)/.test(String(sql))) return Promise.resolve({ rows: [{ cnt: '0' }] })
      return Promise.resolve({ rows: [] })
    })
  })

  it('authorize builds a settlement child + returns typed data; no funding leg', async () => {
    mockSelect.mockResolvedValueOnce({
      delegation_hash: `0x${'12'.repeat(32)}`,
      delegation_json: JSON.stringify(signedBudget),
      recipient_address: null,
    })
    mockCreateIntent.mockResolvedValueOnce({ id: INTENT_ID, status: 'pending_signature', expires_at: 'x' })

    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody(),
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.sign_data.signature_scheme).toBe('eip712_delegation')
    expect(body.sign_data.typed_data.domain.name).toBe('DelegationManager')
    expect(body.sign_data.instructions).toMatch(/X-PAYMENT header/)
    // #1474: parity with the 3009 branch — the response carries its own
    // Haven-signed declaration, so a client signing straight from it (the SDK's
    // settleX402Erc7710) does not need a second round-trip to sign-context.
    expect(body.x402_expected_auth).toBeDefined()
    expect(body.x402_expected_auth.version).toBe(2)
    // The binding must cover the BYTES being signed, not a hash travelling
    // beside them: the declaration's digest has to be the digest of the typed
    // data in the SAME response. Asserted here because a mismatch is exactly
    // what makes a signer's verification vacuous.
    expect(body.x402_expected_auth.message).toContain(
      typedDataDigest(body.sign_data.typed_data),
    )
    // The intent was pinned to the delegation rail, and the METERING budget
    // is recorded uniformly (#1059): delegation_hash carries the signed CHILD,
    // budget_delegation_hash the parent budget — never equal on erc7710.
    expect(mockCreateIntent).toHaveBeenCalledWith(expect.objectContaining({
      executionRail: 'delegation',
      preparedUserOp: expect.any(String),
      budgetDelegationHash: `0x${'12'.repeat(32)}`,
    }))
    const call = mockCreateIntent.mock.calls[0][0] as { delegationHash: string; budgetDelegationHash: string }
    expect(call.delegationHash).not.toBe(call.budgetDelegationHash)
    // No allowance/funding query ran — there is no funding leg on this rail:
    expect(mockQuery.mock.calls.some((c) => /allowance/i.test(String(c[0])))).toBe(false)
  })

  it('THE SWEEPER CONTRACT (#2094): the stored intent id is the salt preimage of the stored child', async () => {
    // What #2117's passive sweeper will do, run here as an assertion: take the
    // intent row, re-derive the salt from its id, and expect the child the
    // backend actually stored. It fails if the id the child was salted from is
    // ever not the id the row is written under — which no other test can see,
    // because both halves look individually correct.
    // Non-positional on purpose: this test asserts ONE authorize's wiring, not
    // a sequence of queries, so it must not lengthen the positional mock chain
    // the #1227 ratchet exists to shrink. `beforeEach` resets both.
    mockSelect.mockResolvedValue({
      delegation_hash: `0x${'12'.repeat(32)}`,
      delegation_json: JSON.stringify(signedBudget),
      recipient_address: null,
    })
    mockCreateIntent.mockImplementation(async (input: { id?: string }) => ({
      // Echo the id the route supplied — the real insert writes the row under it.
      id: input.id ?? INTENT_ID,
      status: 'pending_signature',
      expires_at: 'x',
    }))

    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody(),
    })
    expect(res.statusCode).toBe(201)

    const call = mockCreateIntent.mock.calls[0][0] as {
      id?: string
      delegationHash: string
      preparedUserOp: string
    }
    // The route supplied an explicit id at all…
    expect(call.id).toEqual(expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-/))
    // …the response names that same row…
    expect(res.json().payment_id).toBe(call.id)
    // …and the child stored under it carries exactly that id's salt.
    const child = JSON.parse(call.preparedUserOp).child as { salt: string }
    expect(child.salt).toBe(settlementSalt(call.id!))
    // The full recompute: intent id → salt → child → hash === delegation_hash.
    expect(hashDelegation({ ...child, signature: '0x' } as never)).toBe(call.delegationHash)
  })

  // ── #1667: the settlement child's delegator must EXIST on-chain ──────────
  // The child's delegator is the delegate HYBRID account; the DelegationManager
  // verifies its signature via EIP-1271 (code) or ecrecover (no code). Against
  // a counterfactual account the EOA signature recovers to the EOA ≠ delegator
  // → InvalidEOASignature (0x3db6791c), the exact prod failure. The 3009
  // funding leg deploys the account via its UserOp's initCode; a fresh agent
  // whose FIRST payment is erc7710 — and every recipient-pinned agent, which
  // can never run a 3009 leg — needs the authorize to deploy it.
  describe('delegate-account deploy on erc7710 authorize (#1667)', () => {
    function primeErc7710() {
      mockSelect.mockResolvedValue({
        delegation_hash: `0x${'12'.repeat(32)}`,
        delegation_json: JSON.stringify(signedBudget),
        recipient_address: null,
      })
      mockCreateIntent.mockResolvedValue({ id: INTENT_ID, status: 'pending_signature', expires_at: 'x' })
    }

    it('REGRESSION: authorize ensures the delegate hybrid account is deployed, attributed to the agent', async () => {
      primeErc7710()
      mockEnsureDeployed.mockResolvedValue({
        address: DELEGATE_ACCT, alreadyDeployed: false, txHash: '0x' + '77'.repeat(32),
      })
      const res = await app.inject({
        method: 'POST', url: '/x402/authorize',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: authorizeBody(),
      })
      expect(res.statusCode).toBe(201)
      // Deployed from the delegate EOA's owner config, pinned to the SAME
      // address the child was built against, billed to this agent (#717):
      expect(mockEnsureDeployed).toHaveBeenCalledWith(
        84532,
        { ownerAddress: DELEGATE_SIGNER.address },
        DELEGATE_ACCT,
        { agentId: 'agent-1', userId: 'user-1' },
      )
    })

    it('fail-closed: a deploy failure 502s BEFORE any intent row exists, so authorize is retryable', async () => {
      mockSelect.mockResolvedValue({
        delegation_hash: `0x${'12'.repeat(32)}`,
        delegation_json: JSON.stringify(signedBudget),
        recipient_address: null,
      })
      mockEnsureDeployed.mockRejectedValue(new Error('relayer has no provider'))
      const res = await app.inject({
        method: 'POST', url: '/x402/authorize',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: authorizeBody(),
      })
      expect(res.statusCode).toBe(502)
      expect(res.json().error).toMatch(/deploy the delegate account/)
      expect(mockCreateIntent).not.toHaveBeenCalled()
    })

    it('maps a relayer budget breach to 429 (#717 discipline, same as grant activation)', async () => {
      mockSelect.mockResolvedValue({
        delegation_hash: `0x${'12'.repeat(32)}`,
        delegation_json: JSON.stringify(signedBudget),
        recipient_address: null,
      })
      mockEnsureDeployed.mockRejectedValue(new RelayerBudgetExceededError('hybrid_deploy', 5, 60))
      const res = await app.inject({
        method: 'POST', url: '/x402/authorize',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: authorizeBody(),
      })
      expect(res.statusCode).toBe(429)
      expect(res.json().error).toMatch(/Relayer budget exceeded/)
      expect(mockCreateIntent).not.toHaveBeenCalled()
    })

    it('the 3009 funding shape never calls it — that leg deploys via its own UserOp initCode', async () => {
      mockPrepareFunding.mockResolvedValue(PREPARED)
      mockCreateIntent.mockResolvedValue({ id: INTENT_ID, status: 'pending_signature', expires_at: 'x' })
      const res = await app.inject({
        method: 'POST', url: '/x402/authorize',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT }),
      })
      expect(res.statusCode).toBe(201)
      expect(mockEnsureDeployed).not.toHaveBeenCalled()
    })
  })

  // ── #2082: fail-fast remaining-budget pre-check on erc7710 ───────────────
  //
  // The gap this closes, measured live against dev on 2026-08-25 (#1993): an
  // over-budget erc7710 authorize returned 201 `pending_signature` WITH
  // `sign_data`. The money was never at risk — the child is chained under the
  // budget delegation and `ERC20PeriodTransferEnforcer` reverts at merchant
  // redemption — but Haven handed the agent a header that could not settle,
  // and the refusal arrived after a signature and four round trips. The two
  // sibling entry points (`POST /payments`, the 3009 funding shape) both
  // refuse at authorize; this made the PREFERRED scheme (#1450) the last one
  // to say no.
  //
  // The chain is still the gate. Every case below is about WHEN the refusal
  // arrives, never about whether an over-budget payment could succeed.
  describe('remaining-budget pre-check on erc7710 authorize (#2082)', () => {
    function primeErc7710() {
      mockSelect.mockResolvedValue({
        delegation_hash: `0x${'12'.repeat(32)}`,
        delegation_json: JSON.stringify(signedBudget),
        recipient_address: null,
      })
      mockCreateIntent.mockResolvedValue({ id: INTENT_ID, status: 'pending_signature', expires_at: 'x' })
    }

    it('REGRESSION: an over-budget authorize is refused 403 with NOTHING written', async () => {
      // Delete the pre-check and this returns 201 with a signable child —
      // which is exactly the pre-#2082 behaviour, so this case is the mutant
      // detector for the whole block.
      primeErc7710()
      mockReadRemaining.mockResolvedValue({ remainingAtomic: '50000', fromChain: true }) // 0.05 USDC
      const res = await app.inject({
        method: 'POST', url: '/x402/authorize',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: authorizeBody({ amount: '100000' }), // 0.1 USDC
      })
      expect(res.statusCode).toBe(403)
      const body = res.json()
      expect(body.sign_data).toBeUndefined()
      expect(body.payment_id).toBeUndefined()
      expect(mockCreateIntent).not.toHaveBeenCalled()
      // Pre-funding means pre-EVERYTHING expensive: the relayer-paid delegate
      // deploy (#1667) must not run for a payment that cannot settle either.
      expect(mockEnsureDeployed).not.toHaveBeenCalled()
    })

    it('the refusal is actionable, not a bare error — taxonomy fields and the shortfall', async () => {
      // MCP's normalizeError reads `phase`/`next_action` straight off the
      // body, so these fields are what turn the 403 into "ask the owner to
      // raise the budget" instead of "retry".
      primeErc7710()
      mockReadRemaining.mockResolvedValue({ remainingAtomic: '50000', fromChain: true })
      const res = await app.inject({
        method: 'POST', url: '/x402/authorize',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: authorizeBody({ amount: '100000' }),
      })
      expect(res.json()).toMatchObject({
        error_code: 'delegation_budget_exceeded',
        phase: 'insufficient_funds',
        next_action: 'fund_account_or_raise_allowance',
        rail: 'x402',
        token: 'USDC',
        amount_atomic: '100000',
        remaining_atomic: '50000',
        shortfall_atomic: '50000',
        chain_id: 84532,
      })
      expect(res.json().error).toMatch(/no approval queue on the delegation rail/)
    })

    it('the read is keyed on the SELECTED budget delegation, and on the agent chain', async () => {
      // A pre-check that read some other delegation would refuse (or admit)
      // for a budget the settlement child is not chained under.
      primeErc7710()
      await app.inject({
        method: 'POST', url: '/x402/authorize',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: authorizeBody(),
      })
      expect(mockReadRemaining).toHaveBeenCalledWith(84532, JSON.stringify(signedBudget), '100000')
    })

    it('POSITIVE CONTROL: a within-budget authorize is unchanged — 201 with a signable child', async () => {
      primeErc7710()
      mockReadRemaining.mockResolvedValue({ remainingAtomic: '5000000', fromChain: true })
      const res = await app.inject({
        method: 'POST', url: '/x402/authorize',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: authorizeBody({ amount: '100000' }),
      })
      expect(res.statusCode).toBe(201)
      expect(res.json().sign_data.signature_scheme).toBe('eip712_delegation')
      expect(mockCreateIntent).toHaveBeenCalled()
    })

    it('spends the LAST of the budget: remaining exactly equal to the amount is allowed', async () => {
      // The comparison is `remaining < amount`, not `<=`. Getting this wrong
      // would strand the final payment of every period behind a refusal the
      // chain would not have made.
      primeErc7710()
      mockReadRemaining.mockResolvedValue({ remainingAtomic: '100000', fromChain: true })
      const res = await app.inject({
        method: 'POST', url: '/x402/authorize',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: authorizeBody({ amount: '100000' }),
      })
      expect(res.statusCode).toBe(201)
    })

    it('FAILS OPEN: a degraded read never refuses — the chain stays the gate', async () => {
      // `fromChain: false` is a fallback number, not a measurement. Refusing
      // on it would turn an RPC outage into a stopped agent; the enforcer
      // still reverts at redemption if the payment really is over budget.
      primeErc7710()
      mockReadRemaining.mockResolvedValue({ remainingAtomic: '1', fromChain: false })
      const res = await app.inject({
        method: 'POST', url: '/x402/authorize',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: authorizeBody({ amount: '100000' }),
      })
      expect(res.statusCode).toBe(201)
      expect(res.json().sign_data).toBeDefined()
    })

    it('FAILS OPEN: a THROWN read never refuses either', async () => {
      // readRemainingBudget catches its own failures today, so this pins the
      // seam rather than the reader: a future reader that rejects must not
      // become a new way for authorize to 500 on a fundable payment.
      primeErc7710()
      mockReadRemaining.mockRejectedValue(new Error('rpc exploded'))
      const res = await app.inject({
        method: 'POST', url: '/x402/authorize',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: authorizeBody({ amount: '100000' }),
      })
      expect(res.statusCode).toBe(201)
    })

    it('FAILS OPEN: an UNPARSEABLE remaining value never refuses either', async () => {
      // `BigInt()` throws on a malformed string, so the parse lives inside the
      // same guard as the read. Outside it, a reader that returned garbage
      // would turn a fundable payment into a 500 — the one outcome this whole
      // block must be incapable of producing.
      primeErc7710()
      mockReadRemaining.mockResolvedValue({ remainingAtomic: 'not-a-number', fromChain: true })
      const res = await app.inject({
        method: 'POST', url: '/x402/authorize',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: authorizeBody({ amount: '100000' }),
      })
      expect(res.statusCode).toBe(201)
    })

    it('the 3009 funding shape does not consult it — that leg refuses at prepare', async () => {
      // Scope guard: #2082 is the erc7710 branch only. The funding leg already
      // refuses over-budget at authorize (502, decoded enforcer), and a second
      // pre-check there would be a second source of truth for one condition.
      mockPrepareFunding.mockResolvedValue(PREPARED)
      mockCreateIntent.mockResolvedValue({ id: INTENT_ID, status: 'pending_signature', expires_at: 'x' })
      const res = await app.inject({
        method: 'POST', url: '/x402/authorize',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT }),
      })
      expect(res.statusCode).toBe(201)
      expect(mockReadRemaining).not.toHaveBeenCalled()
    })
  })

  // ── #2706: the EIP-3009 funding leg now refuses like erc7710 (#2082) ──────
  // The characterization pins this block replaces lived one commit earlier
  // (bdc62d0c): an over-budget funding authorize 502'd with the raw viem dump.
  // Now the same condition produces #2082's typed 403 BEFORE any prepare —
  // field-for-field the sibling body — while genuine bundler/infrastructure
  // failures keep the 502. Fail-open posture is inherited verbatim.
  describe('EIP-3009 funding-leg budget refusal (#2706)', () => {
    function primeFundingLeg() {
      mockSelect.mockResolvedValue({
        delegation_hash: `0x${'12'.repeat(32)}`,
        delegation_json: JSON.stringify(signedBudget),
        recipient_address: null,
      })
    }

    it('REGRESSION: an over-budget funding authorize is refused 403 typed, BEFORE any prepare — nothing written', async () => {
      // Mutant detector: delete the funding-leg pre-check and prepare runs,
      // its enforcer revert collapses into the untyped 502, and this fails.
      primeFundingLeg()
      mockReadRemaining.mockResolvedValue({ remainingAtomic: '50000', fromChain: true }) // 0.05 USDC
      mockPrepareFunding.mockRejectedValueOnce(
        new Error('ERC20PeriodTransferEnforcer:transfer-amount-exceeded'),
      )
      const res = await app.inject({
        method: 'POST', url: '/x402/authorize',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT, amount: '100000' }),
      })
      expect(res.statusCode).toBe(403)
      const body = res.json()
      expect(body.error_code).toBe('delegation_budget_exceeded')
      expect(body.sign_data).toBeUndefined()
      expect(body.payment_id).toBeUndefined()
      expect(mockPrepareFunding).not.toHaveBeenCalled()
      expect(mockCreateIntent).not.toHaveBeenCalled()
    })

    it('the refusal matches the #2082 erc7710 body field-for-field', async () => {
      primeFundingLeg()
      mockReadRemaining.mockResolvedValue({ remainingAtomic: '50000', fromChain: true })
      const res = await app.inject({
        method: 'POST', url: '/x402/authorize',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT, amount: '100000' }),
      })
      expect(res.json()).toMatchObject({
        error_code: 'delegation_budget_exceeded',
        phase: 'insufficient_funds',
        next_action: 'fund_account_or_raise_allowance',
        rail: 'x402',
        token: 'USDC',
        amount_atomic: '100000',
        remaining_atomic: '50000',
        shortfall_atomic: '50000',
        chain_id: 84532,
        // On the funding leg payTo is the delegate EOA; the merchant is the
        // separate field, so the refusal names MERCHANT, not the funding target.
        merchant_address: MERCHANT.toLowerCase(),
      })
      expect(res.json().error).toMatch(/no approval queue on the delegation rail/)
    })

    it('the read is keyed on the SELECTED funding delegation, and on the agent chain', async () => {
      // The prepare after this pre-check re-selects the same delegation — a
      // pre-check that read some other grant would refuse (or admit) for a
      // budget the funding redemption is not chained under.
      primeFundingLeg()
      mockPrepareFunding.mockResolvedValue(PREPARED)
      mockCreateIntent.mockResolvedValue({ id: INTENT_ID, status: 'pending_signature', expires_at: 'x' })
      await app.inject({
        method: 'POST', url: '/x402/authorize',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT }),
      })
      expect(mockReadRemaining).toHaveBeenCalledWith(84532, JSON.stringify(signedBudget), '100000')
    })

    it('POSITIVE CONTROL: a within-budget funding authorize is unchanged — 201 with a signable child', async () => {
      primeFundingLeg()
      mockReadRemaining.mockResolvedValue({ remainingAtomic: '5000000', fromChain: true })
      mockPrepareFunding.mockResolvedValue(PREPARED)
      mockCreateIntent.mockResolvedValue({ id: INTENT_ID, status: 'pending_signature', expires_at: 'x' })
      const res = await app.inject({
        method: 'POST', url: '/x402/authorize',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT }),
      })
      expect(res.statusCode).toBe(201)
      expect(res.json().sign_data.signature_scheme).toBe('eip712_userop')
      // #2914 (naming epic #2906 phase 5, the contraction): `components.safe`
      // is gone — `payer_account` is the only name now, on a REAL response,
      // not a source regex.
      const components = res.json().sign_data.components
      expect(components.safe).toBeUndefined()
      expect(components.payer_account).toBeDefined()
      expect(components.payer_account).not.toBe(components.account)
    })

    it('spends the LAST of the budget: remaining exactly equal to the amount is allowed', async () => {
      // `<`, never `<=` — same boundary as #2082. Refusing equality would
      // strand the final payment of every period behind a refusal the
      // enforcer would not have made.
      primeFundingLeg()
      mockReadRemaining.mockResolvedValue({ remainingAtomic: '100000', fromChain: true })
      mockPrepareFunding.mockResolvedValue(PREPARED)
      mockCreateIntent.mockResolvedValue({ id: INTENT_ID, status: 'pending_signature', expires_at: 'x' })
      const res = await app.inject({
        method: 'POST', url: '/x402/authorize',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT }),
      })
      expect(res.statusCode).toBe(201)
    })

    it('FAILS OPEN: a degraded read never refuses — prepare runs and the enforcer stays the gate', async () => {
      primeFundingLeg()
      mockReadRemaining.mockResolvedValue({ remainingAtomic: '1', fromChain: false })
      mockPrepareFunding.mockResolvedValue(PREPARED)
      mockCreateIntent.mockResolvedValue({ id: INTENT_ID, status: 'pending_signature', expires_at: 'x' })
      const res = await app.inject({
        method: 'POST', url: '/x402/authorize',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT }),
      })
      expect(res.statusCode).toBe(201)
      expect(res.json().sign_data).toBeDefined()
    })

    it('FAILS OPEN: a THROWN read never refuses either', async () => {
      primeFundingLeg()
      mockReadRemaining.mockRejectedValue(new Error('rpc exploded'))
      mockPrepareFunding.mockResolvedValue(PREPARED)
      mockCreateIntent.mockResolvedValue({ id: INTENT_ID, status: 'pending_signature', expires_at: 'x' })
      const res = await app.inject({
        method: 'POST', url: '/x402/authorize',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT }),
      })
      expect(res.statusCode).toBe(201)
    })

    it('FAILS OPEN: an UNPARSEABLE remaining value never refuses either', async () => {
      // BigInt() throws on garbage; the parse lives inside the same guard as
      // the read, so a reader returning malformed values degrades to skip.
      primeFundingLeg()
      mockReadRemaining.mockResolvedValue({ remainingAtomic: 'not-a-number', fromChain: true })
      mockPrepareFunding.mockResolvedValue(PREPARED)
      mockCreateIntent.mockResolvedValue({ id: INTENT_ID, status: 'pending_signature', expires_at: 'x' })
      const res = await app.inject({
        method: 'POST', url: '/x402/authorize',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT }),
      })
      expect(res.statusCode).toBe(201)
    })

    it('a NULL selection skips the pre-check — the no-fundable-delegation 403 below keeps its own wording', async () => {
      // selectDelegation returning null must NOT be read as "budget fine":
      // the null-handling after the pre-check answers 403 with the
      // open-budget-specific message, and this block must never preempt it.
      mockSelect.mockResolvedValue(null)
      const res = await app.inject({
        method: 'POST', url: '/x402/authorize',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT }),
      })
      expect(res.statusCode).toBe(403)
      expect(res.json().error).toMatch(/no delegation able to fund/)
      expect(res.json().error_code).toBeUndefined()
      expect(mockReadRemaining).not.toHaveBeenCalled()
      // prepare still runs — with a null selection it resolves null and the
      // null-handling above answers; the pre-check merely skips its read.
      expect(mockPrepareFunding).toHaveBeenCalledTimes(1)
    })

    it('a genuine bundler failure STILL 502s with the raw error — #2706 does not swallow it', async () => {
      // The typed refusal is for policy, not for infrastructure. Collapsing a
      // bundler outage into the budget taxonomy would tell a retrying agent
      // to ask its owner to raise a budget that is fine.
      primeFundingLeg()
      mockReadRemaining.mockResolvedValue({ remainingAtomic: '5000000', fromChain: true })
      mockPrepareFunding.mockRejectedValueOnce(new Error('bundler: aa_sendUserOperation timeout'))
      const res = await app.inject({
        method: 'POST', url: '/x402/authorize',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT }),
      })
      expect(res.statusCode).toBe(502)
      expect(res.json().error).toMatch(/funding authorization failed/)
      expect(res.json().details).toContain('aa_sendUserOperation timeout')
      expect(mockCreateIntent).not.toHaveBeenCalled()
    })

    // #3052 (epic #3056 slice 1) THE DEGRADED-READ PROMOTION BOX. The
    // #2706 pre-check in front of the prepare is the leg's named refusal for
    // an over-budget funding redemption — but only when the enforcer read is
    // usable. With `fromChain: false` the read is degraded, the pre-check
    // fails open (pinned above), and the ONLY gate left is the period enforcer
    // inside `prepareDelegationPayment`, whose revert arrives at the 502
    // catch. Before #3052 that revert was booked for the byte-identical
    // `POST /payments` sibling (`routes/payments.ts`, the classifier with no
    // wrapping) and recorded nothing here, so the degraded-read path — the
    // path #2706 says this catch is now actually reached on — had no audit
    // trail at all. This is the promotion box the epic names for that path:
    // degraded read + enforcer revert ⇒ the catch asks for
    // `delegation_budget_exceeded` with the x402 source and the real merchant.
    // Mutation-proven: removing the catch's writer turns this test red (the
    // assertion on the ask, and the real row in the module harness suite
    // `modules/x402/__tests__/delegation-authorize-refusal-ledger.test.ts`).
    it('a DEGRADED read (fromChain:false) plus an enforcer revert at the prepare seam is booked as delegation_budget_exceeded (#3052)', async () => {
      primeFundingLeg()
      // The degraded read: the number is a fallback and must not refuse
      // (the case above pins that), so control passes to the prepare.
      mockReadRemaining.mockResolvedValue({ remainingAtomic: '1', fromChain: false })
      // The enforcer's own revert text, the way viem surfaces it: wrapped in
      // the estimation error, the period-budget custom error inside.
      mockPrepareFunding.mockRejectedValue(
        new Error('EstimateGasExecutionError: ERC20PeriodTransferEnforcer:transfer-amount-exceeded'),
      )
      mockRecordRefusal.mockImplementation(() => {})
      const res = await app.inject({
        method: 'POST', url: '/x402/authorize',
        headers: { authorization: 'Bearer ' + ['sk', 'agent', 'test', 'key', '0001'].join('_') },
        payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT }),
      })
      // The refusal response itself is the 502 it has always been — the
      // writer classifies the error, it does not act on it.
      expect(res.statusCode).toBe(502)
      expect(res.json().error).toMatch(/funding authorization failed/)
      expect(mockPrepareFunding).toHaveBeenCalledTimes(1)
      expect(mockCreateIntent).not.toHaveBeenCalled()
      expect(mockRecordRefusal).toHaveBeenCalledTimes(1)
      const ask = mockRecordRefusal.mock.calls[0][0] as Record<string, unknown>
      expect(ask).toMatchObject({
        reason: 'delegation_budget_exceeded',
        source: 'x402_authorize',
        merchantTo: MERCHANT.toLowerCase(),
        accountAddress: '0x' + 'aa'.repeat(20),
      })
      expect(ask.detail).toEqual({ error_code: 'delegation_budget_exceeded' })
    })
  })

  // ── #1058: facilitator redeemers ─────────────────────────────────────────
  it('authorize pins the child to forwarded facilitators and stores them verbatim', async () => {
    mockSelect.mockResolvedValueOnce({
      delegation_hash: `0x${'12'.repeat(32)}`,
      delegation_json: JSON.stringify(signedBudget),
      recipient_address: null,
    })
    mockCreateIntent.mockResolvedValueOnce({ id: INTENT_ID, status: 'pending_signature', expires_at: 'x' })
    const facilitators = ['0x' + 'Fa'.repeat(20)] // mixed case: stored verbatim, caveat normalized

    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ facilitatorAddresses: facilitators }),
    })
    expect(res.statusCode).toBe(201)
    const stored = JSON.parse(
      (mockCreateIntent.mock.calls[0][0] as { preparedUserOp: string }).preparedUserOp,
    )
    // The echo source is the VERBATIM client value…
    expect(stored.facilitatorAddresses).toEqual(facilitators)
    // …and the child grew a redeemer caveat (one more than a bare build).
    const bare = await (async () => {
      mockSelect.mockResolvedValueOnce({
        delegation_hash: `0x${'12'.repeat(32)}`,
        delegation_json: JSON.stringify(signedBudget),
        recipient_address: null,
      })
      mockCreateIntent.mockResolvedValueOnce({ id: 'pi_other', status: 'pending_signature', expires_at: 'x' })
      await app.inject({
        method: 'POST', url: '/x402/authorize',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: authorizeBody(),
      })
      return JSON.parse((mockCreateIntent.mock.calls[1][0] as { preparedUserOp: string }).preparedUserOp)
    })()
    expect(stored.child.caveats.length).toBe(bare.child.caveats.length + 1)
  })

  it('persists mcpCallContext into machine_metadata on BOTH delegation branches (#1307 write path)', async () => {
    // Review finding on #1316: the read endpoint was tested against fabricated
    // rows, but nothing proved the quote actually STORES the context. Without
    // this, dropping the mcp_call_context line regresses silently — the settle
    // leg would just 409 asking for explicit re-send.
    const mcpCallContext = {
      merchantUrl: 'https://merchant.example/mcp',
      toolName: 'buy_vpn',
      arguments: { plan: 'basic' },
      mcpTransport: { handshakeRequired: true, source: 'path' },
    }

    // Branch 1: eip3009 funding leg (default scheme).
    mockSelect.mockResolvedValue({
      delegation_hash: `0x${'12'.repeat(32)}`,
      delegation_json: JSON.stringify(signedBudget),
      recipient_address: null,
    })
    mockCreateIntent.mockResolvedValue({ id: INTENT_ID, status: 'pending_signature', expires_at: 'x' })
    let res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ mcpCallContext }),
    })
    expect(res.statusCode).toBe(201)
    expect(mockCreateIntent).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        mcp_call_context: expect.objectContaining({ merchantUrl: mcpCallContext.merchantUrl, toolName: 'buy_vpn' }),
      }),
    }))

    // Branch 2: erc7710 direct settlement.
    mockCreateIntent.mockClear()
    mockSelect.mockResolvedValue({
      delegation_hash: `0x${'12'.repeat(32)}`,
      delegation_json: JSON.stringify(signedBudget),
      recipient_address: null,
    })
    mockCreateIntent.mockResolvedValue({ id: INTENT_ID, status: 'pending_signature', expires_at: 'x' })
    res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({
        settlementScheme: 'erc7710',
        facilitatorAddresses: ['0x' + 'fa'.repeat(20)],
        mcpCallContext,
      }),
    })
    expect(res.statusCode).toBe(201)
    expect(mockCreateIntent).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        mcp_call_context: expect.objectContaining({ toolName: 'buy_vpn' }),
      }),
    }))
  })

  it('persists paymentRequired into machine_metadata on BOTH delegation branches (#1355 write path)', async () => {
    // Same discipline as the #1307 write-path test above: prove the quote
    // STORES the blob, or dropping the metadata line regresses silently and
    // every signer falls back to demanding the agent-relayed copy.
    const paymentRequired = {
      x402Version: 2,
      resource: { url: 'https://merchant.example/resource' },
      accepts: [{ scheme: 'exact', network: 'base', amount: '100000', asset: USDC, payTo: MERCHANT }],
    }

    mockSelect.mockResolvedValue({
      delegation_hash: `0x${'12'.repeat(32)}`,
      delegation_json: JSON.stringify(signedBudget),
      recipient_address: null,
    })
    mockCreateIntent.mockResolvedValue({ id: INTENT_ID, status: 'pending_signature', expires_at: 'x' })
    let res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ paymentRequired }),
    })
    expect(res.statusCode).toBe(201)
    expect(mockCreateIntent).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        payment_required: expect.objectContaining({ x402Version: 2 }),
      }),
    }))

    mockCreateIntent.mockClear()
    mockSelect.mockResolvedValue({
      delegation_hash: `0x${'12'.repeat(32)}`,
      delegation_json: JSON.stringify(signedBudget),
      recipient_address: null,
    })
    mockCreateIntent.mockResolvedValue({ id: INTENT_ID, status: 'pending_signature', expires_at: 'x' })
    res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({
        settlementScheme: 'erc7710',
        facilitatorAddresses: ['0x' + 'fa'.repeat(20)],
        paymentRequired,
      }),
    })
    expect(res.statusCode).toBe(201)
    expect(mockCreateIntent).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        payment_required: expect.objectContaining({ x402Version: 2 }),
      }),
    }))
  })

  // #3117: settle echoes the stored challenge's own matching offer, so a
  // caller whose decomposed fields disagree with the challenge it sent has
  // nothing to echo. That must be a 400 HERE, not a 409 at settle — by then
  // the agent has signed the child and every retry fails identically.
  it.each([
    { label: 'a maxTimeoutSeconds the challenge does not advertise', body: { maxTimeoutSeconds: 60 }, expect400: true },
    { label: 'a facilitator the challenge does not advertise', body: { facilitatorAddresses: [`0x${'ee'.repeat(20)}`] }, expect400: true },
    { label: 'fields taken from the advertised option', body: {}, expect400: false },
  ])('authorize refuses $label before any child is signed', async ({ body, expect400 }) => {
    const advertised = {
      scheme: 'exact', network: 'eip155:84532', amount: '100000', asset: USDC, payTo: MERCHANT,
      maxTimeoutSeconds: 300,
      extra: { assetTransferMethod: 'erc7710', facilitatorAddresses: [`0x${'fa'.repeat(20)}`] },
    }
    mockSelect.mockResolvedValue({
      delegation_hash: `0x${'12'.repeat(32)}`,
      delegation_json: JSON.stringify(signedBudget),
      recipient_address: null,
    })
    mockCreateIntent.mockResolvedValue({ id: INTENT_ID, status: 'pending_signature', expires_at: 'x' })
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({
        settlementScheme: 'erc7710',
        facilitatorAddresses: [`0x${'fa'.repeat(20)}`],
        paymentRequired: { x402Version: 2, resource: { url: 'https://merchant.example/resource' }, accepts: [advertised] },
        ...body,
      }),
    })
    if (expect400) {
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toMatch(/does not advertise one erc7710 option/)
      expect(mockCreateIntent).not.toHaveBeenCalled()
    } else {
      expect(res.statusCode).toBe(201)
    }
  })

  it('persists delegate_account_address into machine_metadata on BOTH delegation branches (#2960 write path)', async () => {
    // Same discipline as the #1307/#1355 write-path tests above: prove the
    // authorize call STORES the delegate account, or dropping the metadata
    // line regresses receipts/status `parties.delegate_account` silently.
    // `payTo === agent.delegate_address` (with `merchantPayTo` set) selects
    // the eip3009 funding-leg shape (`deriveFundingShape`); `payTo` = the
    // merchant, the default, selects erc7710 direct settlement.

    // Branch 1: eip3009 funding leg — `fundingAuth.prepared.delegateAccountAddress`.
    mockPrepareFunding.mockResolvedValue(PREPARED)
    mockCreateIntent.mockResolvedValue({ id: INTENT_ID, status: 'pending_signature', expires_at: 'x' })
    let res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT }),
    })
    expect(res.statusCode).toBe(201)
    expect(mockCreateIntent).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        settlement_scheme: 'eip3009',
        delegate_account_address: PREPARED.prepared.delegateAccountAddress,
      }),
    }))

    // Branch 2: erc7710 direct settlement — the settlement child's own delegator.
    mockCreateIntent.mockClear()
    mockSelect.mockResolvedValue({
      delegation_hash: `0x${'12'.repeat(32)}`,
      delegation_json: JSON.stringify(signedBudget),
      recipient_address: null,
    })
    mockCreateIntent.mockResolvedValue({ id: INTENT_ID, status: 'pending_signature', expires_at: 'x' })
    res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody(),
    })
    expect(res.statusCode).toBe(201)
    expect(mockCreateIntent).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        settlement_scheme: 'erc7710',
        delegate_account_address: DELEGATE_ACCT,
      }),
    }))
  })

  // #3031: still 400, still naming the field — but the two halves are refused
  // by DIFFERENT layers now, and the test says which. A wrong TYPE is the
  // schema's job (`paymentRequired` is declared `type: 'object'`); the 64 KB
  // bound is not expressible in JSON Schema, so that rung stayed in the
  // handler and answers with its own sentence.
  it('authorize 400s a malformed or oversized paymentRequired instead of silently dropping it', async () => {
    for (const bad of ['a-string', [1, 2]]) {
      const res = await app.inject({
        method: 'POST', url: '/x402/authorize',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: authorizeBody({ paymentRequired: bad }),
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe('Request does not match the API spec')
      expect(res.json().details).toMatch(/paymentRequired/)
    }

    const oversized = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ paymentRequired: { blob: 'x'.repeat(70000) } }),
    })
    expect(oversized.statusCode).toBe(400)
    expect(oversized.json().error).toMatch(/paymentRequired exceeds 64KB/)
  })

  // #3031: every one of these four is a SHAPE the schema now declares —
  // `minItems: 1`, `maxItems: 16`, `items` on the address pattern, and the
  // array type itself — so all four are refused before the handler. The rung
  // that used to say this sentence is deleted; the guarantee is not.
  it('authorize 400s malformed facilitatorAddresses — garbage cannot half-pin a child', async () => {
    for (const bad of [[], ['not-an-address'], 'x', new Array(17).fill('0x' + 'aa'.repeat(20))]) {
      const res = await app.inject({
        method: 'POST', url: '/x402/authorize',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: authorizeBody({ facilitatorAddresses: bad }),
      })
      expect(res.statusCode).toBe(400)
      expect(res.json().error).toBe('Request does not match the API spec')
      expect(res.json().details).toMatch(/facilitatorAddresses/)
    }
  })

  it('authorize 400s facilitatorAddresses on the 3009 funding shape — no redeemer there', async () => {
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({
        payTo: DELEGATE_EOA,
        merchantPayTo: MERCHANT,
        facilitatorAddresses: ['0x' + 'fa'.repeat(20)],
      }),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/erc7710 direct settlement only/)
  })

  it('authorize rejects native-token x402 on the delegation rail (characterization, #946)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ asset: '0x0000000000000000000000000000000000000000' }),
    })
    // Native has no ERC20 transfer to pin/meter — the rail refuses it whole.
    expect([400, 403]).toContain(res.statusCode)
    expect(mockCreateIntent).not.toHaveBeenCalled()
  })

  it('authorize 403s when the agent has no active budget delegation for the merchant', async () => {
    mockSelect.mockResolvedValueOnce(null)
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody(),
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toMatch(/no active budget delegation/)
    expect(mockCreateIntent).not.toHaveBeenCalled()
  })

  // ── #946: EIP-3009 fallback (delegation-metered funding leg) ──────────────
  const DELEGATE_EOA = DELEGATE_SIGNER.address // = the mocked agent.delegate_address
  const PREPARED = {
    delegationHash: `0x${'34'.repeat(32)}`,
    prepared: {
      userOperation: { sender: DELEGATE_ACCT, nonce: '1' },
      userOpHash: `0x${'56'.repeat(32)}`,
      // A COMPLETE EIP-712 payload, not a stub: since #1138 the route hashes
      // this to build the v2 expected-context commitment, and the edge signer
      // re-derives the same digest before signing. A payload that cannot be
      // hashed is one no signer could ever accept.
      signingTypedData: {
        domain: {
          chainId: 84532,
          name: 'HybridDeleGator',
          version: '1',
          verifyingContract: DELEGATE_ACCT,
        },
        types: {
          PackedUserOperation: [
            { name: 'sender', type: 'address' },
            { name: 'nonce', type: 'uint256' },
          ],
        },
        primaryType: 'PackedUserOperation',
        message: { sender: DELEGATE_ACCT, nonce: '1' },
      },
      delegateAccountAddress: DELEGATE_ACCT,
    },
  }

  it('payTo = delegate EOA selects 3009-mode: funding redemption + eip712_userop sign_data (#946)', async () => {
    mockPrepareFunding.mockResolvedValueOnce(PREPARED)
    mockCreateIntent.mockResolvedValueOnce({ id: INTENT_ID, status: 'pending_signature', expires_at: 'x' })

    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT }),
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    // The funding leg signs the ACCOUNT's UserOp typed data, not a child delegation:
    expect(body.sign_data.signature_scheme).toBe('eip712_userop')
    expect(body.sign_data.hash).toBe(PREPARED.prepared.userOpHash)
    expect(body.sign_data.instructions).toMatch(/\/payments\//)
    // #3272: the funding leg's expected context must bind the typed data
    // digest, not the bare 4337 hash — that binding is what makes this a
    // version-2 context. `signX402ExpectedContext` derives the version from
    // whether `typedDataHash` was passed; asserting `2` here pins that this
    // call site (delegation-authorize.ts's EIP-3009 funding leg) always
    // supplies it and can never silently regress to the retired version 1.
    expect(body.x402_expected_auth).toBeDefined()
    expect(body.x402_expected_auth.version).toBe(2)
    expect(body.x402_expected_auth.message).toContain(
      typedDataDigest(body.sign_data.typed_data),
    )
    // Funding goes to the EOA; the LEDGER records the real merchant + the scheme:
    expect(mockCreateIntent).toHaveBeenCalledWith(expect.objectContaining({
      executionRail: 'delegation',
      merchantAddress: MERCHANT.toLowerCase(),
      metadata: expect.objectContaining({ settlement_scheme: 'eip3009' }),
      delegationHash: PREPARED.delegationHash,
      // #1059: on the funding leg the budget IS the signed instrument.
      budgetDelegationHash: PREPARED.delegationHash,
    }))
    // The funding redemption targeted the EOA with the exact amount. #3329:
    // a 5th (task-budget) argument now always accompanies the call — this
    // request carried no task_budget_id, so it is undefined.
    expect(mockPrepareFunding).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'agent-1' }), USDC, DELEGATE_EOA.toLowerCase(), 100000n, undefined,
    )
    // The erc7710 SELECTOR for the merchant was never consulted (#2706 note:
    // the funding leg now calls selectDelegation itself, keyed on the funding
    // target — asserted above via the budget read).
    expect(mockSelect).not.toHaveBeenCalledWith(
      'agent-1', USDC, MERCHANT.toLowerCase(),
    )
  })

  it('3009-mode requires merchantPayTo — the ledger must record the real merchant', async () => {
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ payTo: DELEGATE_EOA }),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/merchantPayTo is required/)
    expect(mockPrepareFunding).not.toHaveBeenCalled()
  })

  it('3009-mode 403s without a fundable (open) budget — pinned budgets stay erc7710-only', async () => {
    mockPrepareFunding.mockResolvedValueOnce(null)
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT }),
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error).toMatch(/open \(unpinned\) budget/)
    expect(mockCreateIntent).not.toHaveBeenCalled()
  })

  it('3009-mode maps caveat/bundler failure to a clean 502; database untouched', async () => {
    mockPrepareFunding.mockRejectedValueOnce(new Error('estimation reverted: period budget exceeded'))
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT }),
    })
    expect(res.statusCode).toBe(502)
    expect(res.json().error).toMatch(/funding authorization failed/)
    expect(mockCreateIntent).not.toHaveBeenCalled()
  })

  // ── #1360: the stale-delegate hardening (the #1358 review's open-budget
  // misroute). The SDK's 3009-shape writers now ALWAYS declare
  // settlementScheme: 'eip3009', so a payTo made stale by a delegate rotation
  // fails the shape cross-check loudly instead of silently selecting erc7710.
  it('#1360: a STALE delegate payTo with the explicit eip3009 declaration fails LOUD — no funding, no intent, no erc7710 fallback', async () => {
    const staleDelegate = '0x' + '99'.repeat(20) // rotated away; not the agent delegate
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({
        payTo: staleDelegate,
        merchantPayTo: MERCHANT,
        settlementScheme: 'eip3009',
      }),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/payTo = the agent delegate EOA/)
    expect(mockPrepareFunding).not.toHaveBeenCalled()
    expect(mockSelect).not.toHaveBeenCalled() // the erc7710 selector never consulted
    expect(mockCreateIntent).not.toHaveBeenCalled()
  })

  it('#1360 CHARACTERIZATION: WITHOUT the explicit scheme, a stale payTo routes to the erc7710 selector — why the SDK now always declares', async () => {
    // This pins the pre-#1360 behavior the review derived from SQL: an
    // omitted scheme means the shape alone decides, and a stale delegate
    // address is indistinguishable from a merchant. The open-budget SQL
    // (`recipient_address IS NULL` matches any toAddress) would then build a
    // REAL settlement child to the stale address. Old SDKs still hit this
    // path; if this test starts failing because the backend grew its own
    // stale-address guard, that is an improvement — update it, don't delete.
    const staleDelegate = '0x' + '99'.repeat(20)
    mockSelect.mockResolvedValue(null) // no delegation authorizes → 403, but the SELECTOR ran
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ payTo: staleDelegate, merchantPayTo: MERCHANT }),
    })
    expect(res.statusCode).toBe(403)
    expect(mockSelect).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), staleDelegate.toLowerCase(),
    )
    expect(mockPrepareFunding).not.toHaveBeenCalled()
  })

  it('an explicit settlementScheme must agree with the payTo shape', async () => {
    const wrong3009 = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ settlementScheme: 'eip3009' }), // payTo = merchant
    })
    expect(wrong3009.statusCode).toBe(400)
    expect(wrong3009.json().error).toMatch(/payTo = the agent delegate EOA/)

    const wrong7710 = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT, settlementScheme: 'erc7710' }),
    })
    expect(wrong7710.statusCode).toBe(400)
    expect(wrong7710.json().error).toMatch(/payTo = the merchant/)

    const invalid = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ settlementScheme: 'sudo' }),
    })
    expect(invalid.statusCode).toBe(400)
  })

  it('settle 400s a VALID signature from the WRONG key — and the intent survives (#1053 f3)', async () => {
    // The review's exact scenario: any hex used to pass the shape check, the
    // intent flipped to submitted, and the ledger recorded a payment that can
    // never settle. Now the signer is recovered against the delegate key
    // BEFORE anything becomes unrecoverable.
    const wrongSigner = privateKeyToAccount(('0x' + '22'.repeat(32)) as `0x${string}`)
    const childFixture = JSON.parse(JSON.stringify(buildBudgetDelegation({
      agentId: 'agent-1', chainId: 84532, treasuryAddress: '0x' + 'aa'.repeat(20) as `0x${string}`,
      delegateAccountAddress: DELEGATE_ACCT as `0x${string}`, tokenAddress: USDC as `0x${string}`,
      budgetAtomic: 100_000n, periodSeconds: 86_400, startDate: NOW - 60, expiresAt: NOW + 300, version: 1,
    })))
    const preparedState = JSON.stringify({
      child: childFixture, budget: signedBudget,
      delegateAccountAddress: DELEGATE_ACCT, network: 'eip155:84532',
    })
    const updates: string[] = []
    mockQuery.mockImplementation((sql: string) => {
      if (/SELECT id, status, execution_rail/.test(String(sql))) {
        return Promise.resolve({ rows: [{
          id: INTENT_ID, status: 'pending_signature', execution_rail: 'delegation',
          prepared_user_op: JSON.parse(preparedState), chain_id: 84532,
          x402_resource_url: 'https://merchant.example/resource',
        }] })
      }
      if (/UPDATE payment_intents/.test(String(sql))) updates.push(String(sql))
      return Promise.resolve({ rows: [] })
    })
    const payload = delegationSigningPayload(childFixture as never, 84532)
    const wrongSig = await wrongSigner.signTypedData({
      domain: payload.domain, types: payload.types,
      primaryType: payload.primaryType, message: payload.message as never,
    })

    const res = await app.inject({
      method: 'POST', url: `/x402/${INTENT_ID}/settle`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: wrongSig },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/delegate key/)
    // Nothing flipped: the intent is still signable with the RIGHT key.
    expect(updates).toEqual([])

    // Garbage hex ('0x0'-class) is also a 400, not a burned intent:
    const garbage = await app.inject({
      method: 'POST', url: `/x402/${INTENT_ID}/settle`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: '0x00' },
    })
    expect(garbage.statusCode).toBe(400)
    expect(updates).toEqual([])
  })

  /** Drive a settle to completion with a valid prepared erc7710 state. */
  async function settleOk(passportRows: Record<string, unknown>[] = []) {
    const childFixture = JSON.parse(JSON.stringify(buildBudgetDelegation({
        agentId: 'agent-1', chainId: 84532, treasuryAddress: '0x' + 'aa'.repeat(20) as `0x${string}`,
        delegateAccountAddress: DELEGATE_ACCT as `0x${string}`, tokenAddress: USDC as `0x${string}`,
        budgetAtomic: 100_000n, periodSeconds: 86_400, startDate: NOW - 60, expiresAt: NOW + 300, version: 1,
      })))
    const preparedState = JSON.stringify({
      child: childFixture,
      budget: signedBudget,
      delegateAccountAddress: DELEGATE_ACCT,
      network: 'eip155:84532',
    })
    mockQuery.mockImplementation((sql: string) => {
      if (/SELECT id, status, execution_rail/.test(String(sql))) {
        return Promise.resolve({ rows: [{
          id: INTENT_ID, status: 'pending_signature', execution_rail: 'delegation',
          prepared_user_op: JSON.parse(preparedState), chain_id: 84532,
          x402_resource_url: 'https://merchant.example/resource',
          to_address: '0x' + 'cc'.repeat(20), amount_raw: '1000', token_address: USDC,
        }] })
      }
      if (/FROM agent_passports/.test(String(sql))) return Promise.resolve({ rows: passportRows })
      return Promise.resolve({ rows: [] })
    })
    return app.inject({
      method: 'POST', url: `/x402/${INTENT_ID}/settle`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: await signChild(childFixture) },
    })
  }

  // ── CHARACTERIZATION (money.md §2) of the wire format #976 must not widen.
  //
  // Honesty about its provenance: this test and the #976 feature land in the
  // same commit, so nothing in history shows it was authored first, and the
  // comment used to assert exactly that. It cannot be verified, so it is not
  // claimed. What holds regardless of authoring order is the property below,
  // which is the reason the test exists.
  //
  // The X-PAYMENT header is consumed by a MERCHANT FACILITATOR we do not
  // control. An unexpected key inside `payload` is a rejection risk, and a
  // rejection here is a failed payment — so the passport reference must ride
  // Haven's OWN response body, never the header. This pins that boundary: if a
  // later change widens the wire payload, it fails here rather than at a
  // merchant.
  it('CHARACTERIZATION: the X-PAYMENT payload carries exactly the erc7710 keys', async () => {
    const res = await settleOk()
    expect(res.statusCode).toBe(200)
    const decoded = JSON.parse(Buffer.from(res.json().payment_header, 'base64').toString('utf8'))
    // v2 since #1064: the accepted-requirements echo rides alongside the
    // scheme payload — @x402/core v2 merchants match it field-for-field.
    // #2361: this fixture row has NO machine_metadata, so it now also pins
    // the pre-#1355 fallback — no stored challenge means no resource or
    // extensions echo, never an empty one.
    expect(Object.keys(decoded).sort()).toEqual(['accepted', 'network', 'payload', 'scheme', 'x402Version'])
    expect(Object.keys(decoded.payload).sort()).toEqual([
      'delegationManager', 'delegator', 'permissionContext',
    ])
    expect(Object.keys(decoded.accepted).sort()).toEqual([
      'amount', 'asset', 'extra', 'maxTimeoutSeconds', 'network', 'payTo', 'scheme',
    ])
    expect(decoded.accepted.extra).toEqual({ assetTransferMethod: 'erc7710' })
  })

  it('settle assembles the X-PAYMENT header and flips to submitted; Haven submits nothing', async () => {
    const childFixture = JSON.parse(JSON.stringify(buildBudgetDelegation({
      agentId: 'agent-1', chainId: 84532, treasuryAddress: '0x' + 'aa'.repeat(20) as `0x${string}`,
      delegateAccountAddress: DELEGATE_ACCT as `0x${string}`, tokenAddress: USDC as `0x${string}`,
      budgetAtomic: 100_000n, periodSeconds: 86_400, startDate: NOW - 60, expiresAt: NOW + 300, version: 1,
    })))
    const preparedState = JSON.stringify({
      child: childFixture,
      budget: signedBudget,
      delegateAccountAddress: DELEGATE_ACCT,
      network: 'eip155:84532',
    })
    mockQuery.mockImplementation((sql: string) => {
      if (/SELECT id, status, execution_rail/.test(String(sql))) {
        return Promise.resolve({ rows: [{
          id: INTENT_ID, status: 'pending_signature', execution_rail: 'delegation',
          prepared_user_op: JSON.parse(preparedState), chain_id: 84532,
          x402_resource_url: 'https://merchant.example/resource',
          to_address: '0x' + 'cc'.repeat(20), amount_raw: '1000', token_address: USDC,
        }] })
      }
      return Promise.resolve({ rows: [] })
    })

    const res = await app.inject({
      method: 'POST', url: `/x402/${INTENT_ID}/settle`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: await signChild(childFixture) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('submitted')
    // The header decodes to an exact-scheme erc7710 payload:
    const decoded = JSON.parse(Buffer.from(body.payment_header, 'base64').toString('utf8'))
    expect(decoded).toMatchObject({ x402Version: 2, scheme: 'exact', network: 'eip155:84532' })
    // Old stored state (no maxTimeoutSeconds) echoes the 300 default the
    // child expiry was built with — replay-resume of pre-#1064 intents.
    expect(decoded.accepted.maxTimeoutSeconds).toBe(300)
    expect(decoded.payload.delegator.toLowerCase()).toBe(DELEGATE_ACCT.toLowerCase())
    // The intent flipped to submitted:
    expect(mockQuery.mock.calls.some((c) => /status = 'submitted'/.test(String(c[0])))).toBe(true)
  })

  // #1058: stored facilitators ride the accepted echo — the v2 matcher
  // requires the merchant's advertised extra as a subset of it.
  it('settle echoes stored facilitatorAddresses in the accepted extra', async () => {
    const childFixture = JSON.parse(JSON.stringify(buildBudgetDelegation({
      agentId: 'agent-1', chainId: 84532, treasuryAddress: '0x' + 'aa'.repeat(20) as `0x${string}`,
      delegateAccountAddress: DELEGATE_ACCT as `0x${string}`, tokenAddress: USDC as `0x${string}`,
      budgetAtomic: 100_000n, periodSeconds: 86_400, startDate: NOW - 60, expiresAt: NOW + 300, version: 1,
    })))
    const facilitators = ['0x' + 'Fa'.repeat(20)]
    const preparedState = {
      child: childFixture,
      budget: signedBudget,
      delegateAccountAddress: DELEGATE_ACCT,
      network: 'eip155:84532',
      maxTimeoutSeconds: 120,
      facilitatorAddresses: facilitators,
    }
    mockQuery.mockImplementation((sql: string) => {
      if (/SELECT id, status, execution_rail/.test(String(sql))) {
        return Promise.resolve({ rows: [{
          id: INTENT_ID, status: 'pending_signature', execution_rail: 'delegation',
          prepared_user_op: preparedState, chain_id: 84532,
          x402_resource_url: 'https://merchant.example/resource',
          to_address: '0x' + 'cc'.repeat(20), amount_raw: '1000', token_address: USDC,
        }] })
      }
      return Promise.resolve({ rows: [] })
    })

    const res = await app.inject({
      method: 'POST', url: `/x402/${INTENT_ID}/settle`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: await signChild(childFixture) },
    })
    expect(res.statusCode).toBe(200)
    const decoded = JSON.parse(Buffer.from(res.json().payment_header, 'base64').toString('utf8'))
    expect(decoded.accepted.maxTimeoutSeconds).toBe(120)
    expect(decoded.accepted.extra).toEqual({
      assetTransferMethod: 'erc7710',
      facilitatorAddresses: facilitators,
    })
  })

  // #2361: the stored #1355 challenge's resource/extensions are echoed into
  // the settle envelope VERBATIM — the live bisection on #2360 proved a
  // strict facilitator rejects the echo-less envelope outright, and the
  // stored copy is the merchant's own bytes rather than a reconstruction.
  it.each([false, true])('settle echoes matching stored requirements or refuses mismatched ones (mismatch=%s)', async mismatch => {
    const childFixture = JSON.parse(JSON.stringify(buildBudgetDelegation({
      agentId: 'agent-1', chainId: 84532, treasuryAddress: '0x' + 'aa'.repeat(20) as `0x${string}`,
      delegateAccountAddress: DELEGATE_ACCT as `0x${string}`, tokenAddress: USDC as `0x${string}`,
      budgetAtomic: 100_000n, periodSeconds: 86_400, startDate: NOW - 60, expiresAt: NOW + 300, version: 1,
    })))
    const resource = {
      url: 'https://merchant.example/resource',
      mimeType: 'application/json',
      serviceName: 'kept-verbatim',
    }
    const extensions = { bazaar: { info: { input: { method: 'GET' } } } }
    mockQuery.mockImplementation((sql: string) => {
      if (/SELECT id, status, execution_rail/.test(String(sql))) {
        return Promise.resolve({ rows: [{
          id: INTENT_ID, status: 'pending_signature', execution_rail: 'delegation',
          prepared_user_op: {
            child: childFixture, budget: signedBudget,
            delegateAccountAddress: DELEGATE_ACCT, network: 'eip155:84532',
          },
          chain_id: 84532,
          x402_resource_url: 'https://merchant.example/resource',
          to_address: '0x' + 'cc'.repeat(20), amount_raw: '1000', token_address: USDC,
          // The #1355 verbatim blob, as a JSONB-parsed object.
          machine_metadata: {
            network: 'eip155:84532', settlement_scheme: 'erc7710',
            payment_required: { x402Version: 2, resource, accepts: [{
              scheme: 'exact', network: 'eip155:84532', amount: mismatch ? '999' : '1000',
              payTo: MERCHANT, asset: USDC, maxTimeoutSeconds: 300,
              extra: { assetTransferMethod: 'erc7710', name: 'USD Coin', version: '2', merchant: { tiers: ['a'] } },
            }], extensions },
          },
        }] })
      }
      return Promise.resolve({ rows: [] })
    })

    const res = await app.inject({
      method: 'POST', url: `/x402/${INTENT_ID}/settle`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: await signChild(childFixture) },
    })
    if (mismatch) {
      // Deterministic, so 409 + re-authorize rather than a retryable 502.
      expect(res.statusCode).toBe(409)
      expect(res.json().error).toMatch(/re-authorize/)
      expect(mockQuery.mock.calls.some(c => /status = 'submitted'/.test(String(c[0])))).toBe(false)
      return
    }
    expect(res.statusCode).toBe(200)
    const decoded = JSON.parse(Buffer.from(res.json().payment_header, 'base64').toString('utf8'))
    expect(Object.keys(decoded).sort()).toEqual(
      ['accepted', 'extensions', 'network', 'payload', 'resource', 'scheme', 'x402Version'],
    )
    expect(decoded.resource).toEqual(resource)
    expect(decoded.extensions).toEqual(extensions)
    expect(decoded.accepted.extra).toEqual({ assetTransferMethod: 'erc7710', name: 'USD Coin', version: '2', merchant: { tiers: ['a'] } })
  })

  // The metadata-less (pre-#1355) fallback is pinned by the CHARACTERIZATION
  // test above; this one covers the other driver shape.
  it('settle tolerates machine_metadata handed back as a raw JSON string', async () => {
    const childFixture = JSON.parse(JSON.stringify(buildBudgetDelegation({
      agentId: 'agent-1', chainId: 84532, treasuryAddress: '0x' + 'aa'.repeat(20) as `0x${string}`,
      delegateAccountAddress: DELEGATE_ACCT as `0x${string}`, tokenAddress: USDC as `0x${string}`,
      budgetAtomic: 100_000n, periodSeconds: 86_400, startDate: NOW - 60, expiresAt: NOW + 300, version: 1,
    })))
    const extensions = { bazaar: { schema: 'v1' } }
    const stringMetadata = JSON.stringify({
      settlement_scheme: 'erc7710',
      payment_required: { x402Version: 2, resource: { url: 'https://merchant.example/resource' }, accepts: [], extensions },
    })
    mockQuery.mockImplementation((sql: string) => {
      if (/SELECT id, status, execution_rail/.test(String(sql))) {
        return Promise.resolve({ rows: [{
          id: INTENT_ID, status: 'pending_signature', execution_rail: 'delegation',
          prepared_user_op: {
            child: childFixture, budget: signedBudget,
            delegateAccountAddress: DELEGATE_ACCT, network: 'eip155:84532',
          },
          chain_id: 84532,
          x402_resource_url: 'https://merchant.example/resource',
          to_address: '0x' + 'cc'.repeat(20), amount_raw: '1000', token_address: USDC,
          machine_metadata: stringMetadata,
        }] })
      }
      return Promise.resolve({ rows: [] })
    })

    const res = await app.inject({
      method: 'POST', url: `/x402/${INTENT_ID}/settle`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: await signChild(childFixture) },
    })
    expect(res.statusCode).toBe(200)
    const decoded = JSON.parse(Buffer.from(res.json().payment_header, 'base64').toString('utf8'))
    expect(decoded.extensions).toEqual(extensions)
    expect(decoded.resource).toEqual({ url: 'https://merchant.example/resource' })
  })

  // ── #976: present inline, verify authoritatively ─────────────────────────
  describe('passport reference on settle (#976)', () => {
    const UID = '0x' + 'ab'.repeat(32)

    it('carries the reference when the agent has an ANCHORED passport', async () => {
      const res = await settleOk([
        { agent_id: 'agent-1', chain_id: 84532, status: 'anchored', attestation_uid: UID },
      ])
      expect(res.statusCode).toBe(200)
      // The UID and the chain id are the substance — the pair a merchant can
      // resolve against a verifier it already pins, or against EAS directly.
      // `verify_url` is a convenience that this deployment may or may not be
      // able to emit honestly (it needs a configured base URL AND a live
      // verifier), so its two branches are pinned where the decision is made,
      // in `lib/passport/__tests__/x402-delivery.test.ts`. Asserting it here
      // would only re-test that env.
      expect(res.json().passport).toMatchObject({ attestation_uid: UID, chain_id: 84532 })
    })

    // Each fixture below must fail for exactly ONE reason. The first version
    // paired 'not anchored' with a null UID, so the STATUS check had no
    // independent coverage — mutating it away left all 28 tests green. The
    // isolated cases are `status !== anchored WITH a UID` and
    // `status === anchored WITHOUT one`.
    //
    // Statuses are the real enum from migration 048 — 'pending' | 'anchored' |
    // 'failed'. An earlier draft used 'requested'/'revoked', which cannot exist
    // (revocation is tracked in `revocation_status`, a separate column), so
    // those cases were asserting over states the database forbids.
    //
    // Two honest limits on this block, both found by review:
    //
    //  - `anchored with no UID` is ITSELF a state migration 048 forbids
    //    (`CHECK (status <> 'anchored' OR attestation_uid IS NOT NULL)`) — the
    //    same standard the paragraph above applies to 'requested'. It stays
    //    because TypeScript needs the guard (`attestation_uid: string | null`)
    //    and because a constraint can be dropped by a later migration, but it
    //    is a TYPE guard with a regression test, not a reachable branch.
    //  - `no passport row` does NOT pin the `!row` clause here. Delete it and
    //    `row.status` throws on undefined, the total catch converts that to the
    //    same null, and this test still passes. That clause is pinned in
    //    `lib/passport/__tests__/x402-delivery.test.ts`, where the error path
    //    has an observable (a logged warning) the absence path does not.
    it.each([
      ['no passport row', []],
      ['ISOLATED status: a UID present but still `pending`', [{ agent_id: 'agent-1', chain_id: 84532, status: 'pending', attestation_uid: '0x' + 'cd'.repeat(32) }]],
      ['ISOLATED status: a UID present but `failed`', [{ agent_id: 'agent-1', chain_id: 84532, status: 'failed', attestation_uid: '0x' + 'cd'.repeat(32) }]],
      ['ISOLATED uid: anchored with no UID (DB-impossible; guards the TYPE)', [{ agent_id: 'agent-1', chain_id: 84532, status: 'anchored', attestation_uid: null }]],
    ])('degrades to null for %s, and the payment still succeeds', async (_name, rows) => {
      // "Absence is graceful" is the acceptance criterion, and it is also the
      // failure mode: a non-anchored passport is deliberately indistinguishable
      // from none, because a reference a merchant cannot verify produces a
      // failed lookup that looks like a REVOKED agent.
      const res = await settleOk(rows as Record<string, unknown>[])
      expect(res.statusCode).toBe(200)
      expect(res.json().passport).toBeNull()
      expect(res.json().payment_header).toBeTruthy()
    })

    it('never lets a passport lookup failure break the payment', async () => {
      // The payment is authorised and signed by the time we decorate it.
      // A passport is not worth a 500 on a settled payment.
      const childFixture = JSON.parse(JSON.stringify(buildBudgetDelegation({
        agentId: 'agent-1', chainId: 84532, treasuryAddress: '0x' + 'aa'.repeat(20) as `0x${string}`,
        delegateAccountAddress: DELEGATE_ACCT as `0x${string}`, tokenAddress: USDC as `0x${string}`,
        budgetAtomic: 100_000n, periodSeconds: 86_400, startDate: NOW - 60, expiresAt: NOW + 300, version: 1,
      })))
      const preparedState = JSON.stringify({
        child: childFixture,
        budget: signedBudget,
        delegateAccountAddress: DELEGATE_ACCT,
        network: 'eip155:84532',
      })
      mockQuery.mockImplementation((sql: string) => {
        if (/SELECT id, status, execution_rail/.test(String(sql))) {
          return Promise.resolve({ rows: [{
            id: INTENT_ID, status: 'pending_signature', execution_rail: 'delegation',
            prepared_user_op: JSON.parse(preparedState), chain_id: 84532,
            x402_resource_url: 'https://merchant.example/resource',
          }] })
        }
        if (/FROM agent_passports/.test(String(sql))) return Promise.reject(new Error('db down'))
        return Promise.resolve({ rows: [] })
      })
      const res = await app.inject({
        method: 'POST', url: `/x402/${INTENT_ID}/settle`,
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: { signature: await signChild(childFixture) },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().passport).toBeNull()
      expect(res.json().payment_header).toBeTruthy()
    })

    it('looks the passport up for the AUTHENTICATED agent, not any other', async () => {
      // Review proved this had NO coverage: mutating `findByAgent(agentId)` to a
      // different id left all 29 tests green, because the mock matches on SQL
      // TEXT and discards bind values. That is not an ordinary coverage hole —
      // casp-risk-guardrails.md asserts the reference is "returned to the agent
      // that owns it", and this assertion is that claim's only support.
      await settleOk([
        { agent_id: 'agent-1', chain_id: 84532, status: 'anchored', attestation_uid: UID },
      ])
      const call = mockQuery.mock.calls.find((c) => /FROM agent_passports/.test(String(c[0])))
      expect(call, 'no agent_passports query was issued').toBeTruthy()
      // agentAuthMiddleware pins the authenticated agent to 'agent-1'.
      expect(call?.[1]).toEqual(['agent-1'])
    })

    it('keeps the reference OUT of the merchant-facing header', async () => {
      // The boundary the characterization test above exists to protect: a
      // facilitator we do not control parses that payload.
      const res = await settleOk([
        { agent_id: 'agent-1', chain_id: 84532, status: 'anchored', attestation_uid: UID },
      ])
      const raw = Buffer.from(res.json().payment_header, 'base64').toString('utf8')
      expect(raw).not.toContain(UID)
      expect(raw).not.toContain('passport')
    })
  })

  it('settle REFUSES a 3009-mode funding intent — /payments/:id/sign is its path (#946)', async () => {
    // A 3009 funding intent stores a prepared UserOp, not {child, budget}.
    mockQuery.mockResolvedValue({ rows: [{
      id: INTENT_ID, status: 'pending_signature', execution_rail: 'delegation',
      prepared_user_op: { sender: DELEGATE_ACCT, nonce: '1' }, chain_id: 84532,
      x402_resource_url: 'https://merchant.example/resource',
    }] })
    const res = await app.inject({
      method: 'POST', url: `/x402/${INTENT_ID}/settle`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: '0x' + 'ef'.repeat(65) },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/EIP-3009 \(funding leg\)/)
    // Nothing flipped to submitted:
    expect(mockQuery.mock.calls.some((c) => /status = 'submitted'/.test(String(c[0])))).toBe(false)
  })

  // ── #961 hardening: replay resumes, one-shot refused, hourly cap enforced ──
  const PENDING_3009_ROW = {
    id: INTENT_ID,
    status: 'pending_signature',
    expires_at: new Date(Date.now() + 300_000).toISOString(),
    sign_hash: `0x${'56'.repeat(32)}`,
    prepared_user_op: { sender: DELEGATE_ACCT, nonce: '1', callData: '0x' },
    to_address: DELEGATE_EOA.toLowerCase(),
    x402_merchant_address: MERCHANT.toLowerCase(),
    x402_resource_url: 'https://merchant.example/resource',
    amount_raw: '100000',
    amount_human: '0.1',
    token_address: USDC.toLowerCase(),
    token_symbol: 'USDC',
    chain_id: 84532,
    account_address: '0x' + 'aa'.repeat(20),
    machine_metadata: { network: 'eip155:84532', settlement_scheme: 'eip3009' },
  }

  function withHourlyCapQueries(rows: Record<string, unknown>[] = []) {
    mockQuery.mockImplementation((sql: string) => {
      if (/max_x402_per_hour/.test(String(sql))) return Promise.resolve({ rows: [{ max_x402_per_hour: 100 }] })
      if (/COUNT\(\*\)/.test(String(sql))) return Promise.resolve({ rows: [{ cnt: '0' }] })
      if (/x402_idempotency_key = \$2/.test(String(sql))) return Promise.resolve({ rows })
      return Promise.resolve({ rows: [] })
    })
  }

  it('a pending idempotent retry RESUMES the intent — sign_data rebuilt, no new estimation (#961)', async () => {
    withHourlyCapQueries([PENDING_3009_ROW])
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT, idempotencyKey: 'k-1' }),
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.idempotent_replay).toBe(true)
    expect(body.payment_id).toBe(INTENT_ID)
    expect(body.sign_data.signature_scheme).toBe('eip712_userop')
    expect(body.sign_data.hash).toBe(`0x${'56'.repeat(32)}`)
    expect(body.sign_data.typed_data.primaryType).toBe('PackedUserOperation')
    // The whole point: NO fresh sponsored estimation ran.
    expect(mockPrepareFunding).not.toHaveBeenCalled()
    expect(mockCreateIntent).not.toHaveBeenCalled()
    // #2914 (naming epic #2906 phase 5, the contraction): `components.safe`
    // is gone on the REPLAY response too — `payer_account` is the only name.
    const components = body.sign_data.components
    expect(components.safe).toBeUndefined()
    expect(components.payer_account).toBeDefined()
    expect(components.payer_account).not.toBe(components.account)
  })

  it('a confirmed idempotent retry replays the receipt (#961)', async () => {
    withHourlyCapQueries([{ ...PENDING_3009_ROW, status: 'confirmed', tx_hash: `0x${'ab'.repeat(32)}` }])
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT, idempotencyKey: 'k-1' }),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ success: true, payment_id: INTENT_ID, tx_hash: `0x${'ab'.repeat(32)}` })
    expect(mockPrepareFunding).not.toHaveBeenCalled()
  })

  it('an erc7710 pending retry rebuilds the CHILD signing payload (#961)', async () => {
    const child = JSON.parse(JSON.stringify(buildBudgetDelegation({
      agentId: 'agent-1', chainId: 84532, treasuryAddress: '0x' + 'aa'.repeat(20) as `0x${string}`,
      delegateAccountAddress: DELEGATE_ACCT as `0x${string}`, tokenAddress: USDC as `0x${string}`,
      budgetAtomic: 100_000n, periodSeconds: 86_400, startDate: NOW - 60, expiresAt: NOW + 300, version: 1,
    })))
    withHourlyCapQueries([{
      ...PENDING_3009_ROW,
      to_address: MERCHANT.toLowerCase(),
      prepared_user_op: { child, budget: signedBudget, delegateAccountAddress: DELEGATE_ACCT, network: 'eip155:84532' },
      machine_metadata: null, // erc7710 creates store no metadata (parity)
    }])
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ idempotencyKey: 'k-1' }), // payTo = merchant
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.idempotent_replay).toBe(true)
    expect(body.sign_data.signature_scheme).toBe('eip712_delegation')
    expect(body.sign_data.typed_data.domain.name).toBe('DelegationManager')
    expect(mockSelect).not.toHaveBeenCalled()
    expect(mockCreateIntent).not.toHaveBeenCalled()
  })

  // #1058: replaying a key after the merchant rotated its facilitators would
  // hand back a child pinned to the OLD redeemer — dead at the merchant's
  // matcher. 409 so the client re-keys.
  it('a facilitator rotation on the same key 409s instead of replaying a stale child', async () => {
    const child = JSON.parse(JSON.stringify(buildBudgetDelegation({
      agentId: 'agent-1', chainId: 84532, treasuryAddress: '0x' + 'aa'.repeat(20) as `0x${string}`,
      delegateAccountAddress: DELEGATE_ACCT as `0x${string}`, tokenAddress: USDC as `0x${string}`,
      budgetAtomic: 100_000n, periodSeconds: 86_400, startDate: NOW - 60, expiresAt: NOW + 300, version: 1,
    })))
    withHourlyCapQueries([{
      ...PENDING_3009_ROW,
      to_address: MERCHANT.toLowerCase(),
      prepared_user_op: {
        child, budget: signedBudget, delegateAccountAddress: DELEGATE_ACCT,
        network: 'eip155:84532', facilitatorAddresses: ['0x' + '77'.repeat(20)],
      },
      machine_metadata: null,
    }])
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({
        idempotencyKey: 'k-1',
        facilitatorAddresses: ['0x' + '88'.repeat(20)], // rotated
      }),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/facilitator_addresses/)
    // Same facilitators still replay fine:
    withHourlyCapQueries([{
      ...PENDING_3009_ROW,
      to_address: MERCHANT.toLowerCase(),
      prepared_user_op: {
        child, budget: signedBudget, delegateAccountAddress: DELEGATE_ACCT,
        network: 'eip155:84532', facilitatorAddresses: ['0x' + '77'.repeat(20)],
      },
      machine_metadata: null,
    }])
    const same = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ idempotencyKey: 'k-1', facilitatorAddresses: ['0x' + '77'.repeat(20)] }),
    })
    expect(same.statusCode).toBe(201)
    expect(same.json().idempotent_replay).toBe(true)
  })

  it('a concurrent-claim conflict RESUMES the winner instead of a bare 409 (#961)', async () => {
    withHourlyCapQueries([]) // pre-check: nothing yet
    mockPrepareFunding.mockResolvedValueOnce(PREPARED)
    mockCreateIntent.mockImplementationOnce(async () => {
      // The race: by the time our insert conflicts, the winner's row exists.
      withHourlyCapQueries([PENDING_3009_ROW])
      return null
    })
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT, idempotencyKey: 'k-1' }),
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().idempotent_replay).toBe(true)
    expect(res.json().payment_id).toBe(INTENT_ID)
  })

  it('a conflict with NO recoverable winner still 409s (#961 fallback)', async () => {
    withHourlyCapQueries([])
    mockPrepareFunding.mockResolvedValueOnce(PREPARED)
    mockCreateIntent.mockResolvedValueOnce(null)
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT, idempotencyKey: 'k-1' }),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/Idempotent replay/)
  })

  it('a stale pending row is LAZILY EXPIRED so the key frees for a fresh create (#961 M2)', async () => {
    const updates: string[] = []
    mockQuery.mockImplementation((sql: string) => {
      updates.push(String(sql))
      if (/max_x402_per_hour/.test(String(sql))) return Promise.resolve({ rows: [{ max_x402_per_hour: 100 }] })
      if (/COUNT\(\*\)/.test(String(sql))) return Promise.resolve({ rows: [{ cnt: '0' }] })
      if (/x402_idempotency_key = \$2/.test(String(sql))) {
        return Promise.resolve({ rows: [{ ...PENDING_3009_ROW, expires_at: new Date(Date.now() - 1000).toISOString() }] })
      }
      return Promise.resolve({ rows: [] })
    })
    mockPrepareFunding.mockResolvedValueOnce(PREPARED)
    mockCreateIntent.mockResolvedValueOnce({ id: 'fresh-intent', status: 'pending_signature', expires_at: 'x' })
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT, idempotencyKey: 'k-1' }),
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().payment_id).toBe('fresh-intent')
    // The stale row was flipped so its key no longer occupies the index:
    expect(updates.some((u) => /SET status = 'expired'/.test(u))).toBe(true)
    expect(mockPrepareFunding).toHaveBeenCalledTimes(1)
  })

  it('#3045 a key whose rows are ALL expired is free again: authorize mints a fresh intent', async () => {
    // The endpoint of the #3045 walk: after the duplicated key's rows have
    // each been lazily expired in turn, the lookup returns the newest EXPIRED
    // row (the lone-stale #961 semantics are unchanged), delegationReplay
    // nulls on the non-pending status WITHOUT writing anything, and the fresh
    // insert succeeds — pre-fix this same lookup result was the permanent 409.
    const updates: string[] = []
    mockQuery.mockImplementation((sql: string) => {
      updates.push(String(sql))
      if (/max_x402_per_hour/.test(String(sql))) return Promise.resolve({ rows: [{ max_x402_per_hour: 100 }] })
      if (/COUNT\(\*\)/.test(String(sql))) return Promise.resolve({ rows: [{ cnt: '0' }] })
      if (/x402_idempotency_key = \$2/.test(String(sql))) {
        return Promise.resolve({ rows: [{ ...PENDING_3009_ROW, status: 'expired' }] })
      }
      return Promise.resolve({ rows: [] })
    })
    // Non-positional on purpose (#1227 ratchet): each mock answers exactly one
    // call in this test and `beforeEach` resets both, so mockResolvedValue/
    // mockImplementation wiring pins the same responses without lengthening
    // the positional chain the ratchet exists to shrink.
    mockPrepareFunding.mockResolvedValue(PREPARED)
    mockCreateIntent.mockImplementation(async () => ({
      id: 'fresh-mint',
      status: 'pending_signature',
      expires_at: 'x',
    }))
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT, idempotencyKey: 'k-dead' }),
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().payment_id).toBe('fresh-mint')
    // No lazy-expire write ran — the row was already expired; there is
    // nothing to free (an expire write here would be a wasted guarded UPDATE
    // that can never match).
    expect(updates.some((u) => /SET status = 'expired'/.test(u))).toBe(false)
    expect(mockPrepareFunding).toHaveBeenCalledTimes(1)
  })

  it('a scheme flip on the same key 409s via the funding_to mismatch (#961)', async () => {
    // The stored intent is 3009 (funding to the EOA); the retry asks erc7710
    // (payTo = merchant) with the SAME key — must never leak the original
    // sign_data under different parameters.
    withHourlyCapQueries([PENDING_3009_ROW])
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ idempotencyKey: 'k-1' }), // payTo = MERCHANT ≠ stored funding_to
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/different x402 funding_to/)
    expect(res.json().payment_id).toBe(INTENT_ID)
  })

  it('a mismatched idempotencyKey 409s with the owning payment id (#961)', async () => {
    withHourlyCapQueries([{ ...PENDING_3009_ROW, amount_raw: '999999' }])
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT, idempotencyKey: 'k-1' }),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().payment_id).toBe(INTENT_ID)
    expect(res.json().error).toMatch(/different x402 amount/)
  })

  it('one-shot signature is refused loudly on the delegation rail (#961)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT, signature: '0x' + 'ab'.repeat(65) }),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/One-shot/)
    expect(mockPrepareFunding).not.toHaveBeenCalled()
  })

  it('an idempotent replay returns BEFORE the hourly cap read — no 429 on a replay (#3045)', async () => {
    // #3045 keeps the #961 invariant while it widens which row the lookup can
    // reach: a replay creates nothing and runs no estimation, so it must
    // never be rate-limited. withHourlyCapQueries answers the cap reads with
    // an UNCAPPED agent, so a 429 here could only mean the cap comparison ran
    // on a replayed request — pin the ORDERING directly instead: when the
    // lookup finds a live row and replays it, the cap's COUNT query must
    // never be reached.
    const capQueries: string[] = []
    mockQuery.mockImplementation((sql: string) => {
      if (/max_x402_per_hour/.test(String(sql))) return Promise.resolve({ rows: [{ max_x402_per_hour: 100 }] })
      if (/COUNT\(\*\)/.test(String(sql))) {
        capQueries.push(String(sql))
        return Promise.resolve({ rows: [{ cnt: '100' }] }) // AT the cap — any cap read that reaches the comparator 429s
      }
      if (/x402_idempotency_key = \$2/.test(String(sql))) {
        return Promise.resolve({ rows: [{ ...PENDING_3009_ROW, expires_at: new Date(Date.now() + 300_000).toISOString() }] })
      }
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT, idempotencyKey: 'k-1' }),
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().idempotent_replay).toBe(true)
    // The replay answered from the lookup alone: the hourly-cap COUNT read
    // (agentHourlyX402CapExceeded) never ran on it.
    expect(capQueries).toHaveLength(0)
    expect(mockPrepareFunding).not.toHaveBeenCalled()
    expect(mockCreateIntent).not.toHaveBeenCalled()
  })

  it('the per-agent hourly cap 429s BEFORE any sponsored estimation (#961)', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/max_x402_per_hour/.test(String(sql))) return Promise.resolve({ rows: [{ max_x402_per_hour: 2 }] })
      if (/COUNT\(\*\)/.test(String(sql))) return Promise.resolve({ rows: [{ cnt: '2' }] })
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody({ payTo: DELEGATE_EOA, merchantPayTo: MERCHANT }),
    })
    expect(res.statusCode).toBe(429)
    expect(res.json().error).toMatch(/max 2 x402 payments per hour/)
    expect(mockPrepareFunding).not.toHaveBeenCalled()
    // Also enforced on the erc7710 path:
    const res7710 = await app.inject({
      method: 'POST', url: '/x402/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: authorizeBody(),
    })
    expect(res7710.statusCode).toBe(429)
  })

  it('settle 409s a non-delegation intent and 400s a bad signature', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: INTENT_ID, status: 'pending_signature', execution_rail: 'session_key', prepared_user_op: {}, chain_id: 84532, x402_resource_url: null }] })
    const wrongRail = await app.inject({
      method: 'POST', url: `/x402/${INTENT_ID}/settle`,
      headers: { authorization: 'Bearer sk_agent_test' }, payload: { signature: '0x' + 'ef'.repeat(65) },
    })
    expect(wrongRail.statusCode).toBe(409)
    const badSig = await app.inject({
      method: 'POST', url: `/x402/${INTENT_ID}/settle`,
      headers: { authorization: 'Bearer sk_agent_test' }, payload: { signature: 'nope' },
    })
    expect(badSig.statusCode).toBe(400)
  })
})

// ── GET /x402/:id/sign-context — the byte-free signing handoff (#1263) ────────
describe('x402 sign-context by payment_id (#1263)', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    process.env.X402_BINDING_PRIVATE_KEY =
      '0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d'
    app = Fastify({ logger: false })
    // #3031: production wiring — `routes/x402.ts` is in `enforcedModules`,
    // so the request schema refuses off-spec shapes before the handler.
    installRequestValidation(app, { mode: 'enforce', enforcedModules: ['routes/x402.ts'] })
    await app.register(x402Routes, { prefix: '/x402' })
  })
  afterAll(async () => app.close())
  beforeEach(() => {
    vi.clearAllMocks()
    mockCompute.mockResolvedValue(DELEGATE_ACCT)
  })

  const PENDING_ROW = {
    id: INTENT_ID,
    status: 'pending_signature',
    expires_at: new Date(Date.now() + 300_000).toISOString(),
    sign_hash: `0x${'56'.repeat(32)}`,
    prepared_user_op: { sender: DELEGATE_ACCT, nonce: '1', callData: '0x' + 'ab'.repeat(64) },
    to_address: ('0x' + 'ee'.repeat(20)).toLowerCase(),
    x402_merchant_address: MERCHANT.toLowerCase(),
    x402_resource_url: 'https://merchant.example/resource',
    amount_raw: '100000',
    amount_human: '0.1',
    token_address: USDC.toLowerCase(),
    token_symbol: 'USDC',
    chain_id: 84532,
    account_address: '0x' + 'aa'.repeat(20),
    machine_metadata: { network: 'eip155:84532', settlement_scheme: 'eip3009' },
  }

  function serveIntentRow(rows: Record<string, unknown>[]) {
    mockQuery.mockImplementation((sql: string) => {
      if (/WHERE id = \$1 AND agent_id = \$2/.test(String(sql))) return Promise.resolve({ rows })
      return Promise.resolve({ rows: [] })
    })
  }

  it('serves the EXACT rebuilt sign_data + a commitment over its own digest', async () => {
    serveIntentRow([PENDING_ROW])
    const res = await app.inject({
      method: 'GET', url: `/x402/${INTENT_ID}/sign-context`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.payment_id).toBe(INTENT_ID)
    expect(body.sign_data.signature_scheme).toBe('eip712_userop')
    expect(body.sign_data.hash).toBe(`0x${'56'.repeat(32)}`)
    expect(body.sign_data.typed_data.primaryType).toBe('PackedUserOperation')
    // The load-bearing property: the Haven-signed context commits to the
    // digest of exactly the typed data THIS response serves — the signer's
    // re-derivation (#1138) must land on the same value.
    const { hashTypedData } = await import('viem')
    const derived = hashTypedData(body.sign_data.typed_data)
    const committed = JSON.parse(body.x402_expected_auth.message.split('\n')[1]).typedDataHash
    expect(derived.toLowerCase()).toBe(committed.toLowerCase())
    // The ready-made expected context (#1263): snake_case, atomic amount,
    // committing to the same digest — the signer passes it through verbatim.
    expect(body.x402_expected.payment_id).toBe(INTENT_ID)
    expect(body.x402_expected.amount).toBe('100000') // atomic, never amount_human
    expect(body.x402_expected.typed_data_hash.toLowerCase()).toBe(derived.toLowerCase())
    expect(body.x402_expected.auth.version).toBe(2)
    // A read, not a replay:
    expect('idempotent_replay' in body).toBe(false)
    // Read-only: nothing was written.
    expect(mockQuery.mock.calls.some((c) => /INSERT|UPDATE/i.test(String(c[0])))).toBe(false)
  })

  it('404s an unknown or foreign payment id (same answer on purpose)', async () => {
    serveIntentRow([])
    const res = await app.inject({
      method: 'GET', url: `/x402/${INTENT_ID}/sign-context`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('re-serves the stored payment_required when persisted, and omits the key on pre-#1355 rows', async () => {
    const paymentRequired = {
      x402Version: 2,
      resource: { url: 'https://merchant.example/resource' },
      accepts: [{ scheme: 'exact', payTo: MERCHANT }],
    }
    serveIntentRow([{
      ...PENDING_ROW,
      machine_metadata: { ...PENDING_ROW.machine_metadata, payment_required: paymentRequired },
    }])
    let res = await app.inject({
      method: 'GET', url: `/x402/${INTENT_ID}/sign-context`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().payment_required).toEqual(paymentRequired)

    // Stringified JSONB (some drivers) parses the same way.
    serveIntentRow([{
      ...PENDING_ROW,
      machine_metadata: JSON.stringify({ ...PENDING_ROW.machine_metadata, payment_required: paymentRequired }),
    }])
    res = await app.inject({
      method: 'GET', url: `/x402/${INTENT_ID}/sign-context`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })
    expect(res.json().payment_required).toEqual(paymentRequired)

    // Pre-#1355 row: the key is ABSENT (not null) so the signer's "carried no
    // payment_required" fallback triggers cleanly.
    serveIntentRow([PENDING_ROW])
    res = await app.inject({
      method: 'GET', url: `/x402/${INTENT_ID}/sign-context`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })
    expect(res.statusCode).toBe(200)
    expect('payment_required' in res.json()).toBe(false)
  })

  it('409s an already-executed intent with its tx hash', async () => {
    serveIntentRow([{ ...PENDING_ROW, status: 'confirmed', tx_hash: '0x' + '99'.repeat(32) }])
    const res = await app.inject({
      method: 'GET', url: `/x402/${INTENT_ID}/sign-context`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('already_executed')
  })

  it('410s and lazy-expires a stale pending row (the #961 discipline)', async () => {
    serveIntentRow([{ ...PENDING_ROW, expires_at: new Date(Date.now() - 1000).toISOString() }])
    const res = await app.inject({
      method: 'GET', url: `/x402/${INTENT_ID}/sign-context`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })
    expect(res.statusCode).toBe(410)
    expect(res.json().error_code).toBe('expired')
    expect(mockQuery.mock.calls.some((c) => /UPDATE payment_intents/i.test(String(c[0])))).toBe(true)
  })

  // #3271: a direct intent now has its own byte-free handoff at
  // `GET /payments/:id/sign-context` (`routes/__tests__/
  // payments-direct-sign-context.test.ts`). This route's refusal for a
  // direct payment_id keeps its error_code and its typed_data_b64 instruction
  // (old signers key on the code, and their agents follow the instruction);
  // it only gains a pointer to the direct route for current signers.
  it('409s a DIRECT (non-x402) payment intent with the fallback named', async () => {
    serveIntentRow([{ ...PENDING_ROW, x402_resource_url: null, payment_resource_url: null }])
    const res = await app.inject({
      method: 'GET', url: `/x402/${INTENT_ID}/sign-context`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('sign_context_unavailable')
    expect(res.json().error).toMatch(/typed_data_b64/)
  })

  it('409s a legacy-rail x402 intent (no stored signing payload)', async () => {
    serveIntentRow([{ ...PENDING_ROW, prepared_user_op: null }])
    const res = await app.inject({
      method: 'GET', url: `/x402/${INTENT_ID}/sign-context`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('sign_context_unavailable')
  })
})

// ── #2290: the funded-but-undelivered escape from `already_executed` ──────────
//
// #2145 taught the status endpoint to answer `retry_original_x402_request` for
// an eip3009 intent whose funding confirmed but whose merchant leg was never
// delivered, and every route that could rebuild the merchant header refused it
// — the diagnosis shipped without the cure. These pin BOTH halves: the one
// state that now opens, and every neighbouring confirmed state that must stay
// shut. Fail-closed is the property under change, so each refusal is its own
// test rather than a shared negative.
describe('x402 sign-context funded-but-unsettled resume (#2290)', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    process.env.X402_BINDING_PRIVATE_KEY =
      '0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d'
    app = Fastify({ logger: false })
    // #3031: production wiring — `routes/x402.ts` is in `enforcedModules`,
    // so the request schema refuses off-spec shapes before the handler.
    installRequestValidation(app, { mode: 'enforce', enforcedModules: ['routes/x402.ts'] })
    await app.register(x402Routes, { prefix: '/x402' })
  })
  afterAll(async () => app.close())
  beforeEach(() => {
    vi.clearAllMocks()
    mockCompute.mockResolvedValue(DELEGATE_ACCT)
  })

  // The merchant's own EIP-712 domain. A funded retry must sign against THIS,
  // not a network default guessed by the x402 library — a wrong domain yields
  // a signature the facilitator rejects (#2288).
  const MERCHANT_EXTRA = { name: 'USD Coin', version: '2' }
  const STORED_PAYMENT_REQUIRED = {
    x402Version: 2,
    resource: { url: 'https://merchant.example/resource' },
    accepts: [{ scheme: 'exact', payTo: MERCHANT, extra: MERCHANT_EXTRA }],
  }

  /**
   * A funded eip3009 intent: the quote window is LONG past (it bounded the
   * funding leg, which confirmed), and `tx_hash` is set — the exact shape that
   * used to answer 409 `already_executed`.
   */
  const FUNDED_ROW = {
    id: INTENT_ID,
    status: 'confirmed',
    tx_hash: '0x' + '99'.repeat(32),
    expires_at: new Date(Date.now() - 6 * 3600_000).toISOString(),
    sign_hash: `0x${'56'.repeat(32)}`,
    prepared_user_op: { sender: DELEGATE_ACCT, nonce: '1', callData: '0x' + 'ab'.repeat(64) },
    to_address: ('0x' + 'ee'.repeat(20)).toLowerCase(),
    x402_merchant_address: MERCHANT.toLowerCase(),
    x402_resource_url: 'https://merchant.example/resource',
    amount_raw: '100000',
    amount_human: '0.1',
    token_address: USDC.toLowerCase(),
    token_symbol: 'USDC',
    chain_id: 84532,
    account_address: '0x' + 'aa'.repeat(20),
    machine_metadata: {
      network: 'eip155:84532',
      settlement_scheme: 'eip3009',
      payment_required: STORED_PAYMENT_REQUIRED,
    },
  }

  /**
   * The DERIVED row `findIntentStatusRow` returns. `funded_but_unsettled` and
   * `merchant_leg_reported` are joins over reconciliation events and evidence,
   * not columns — which is why the gate reads this row and not the raw intent.
   * The join's own correctness is pinned on real Postgres in
   * `modules/payments/__tests__/x402-funded-unsettled-status.test.ts`.
   */
  function statusRow(over: Record<string, unknown> = {}) {
    return {
      id: INTENT_ID,
      status: 'confirmed',
      chain_id: 84532,
      token_symbol: 'USDC',
      token_address: USDC.toLowerCase(),
      amount_human: '0.1',
      amount_raw: '100000',
      tx_hash: FUNDED_ROW.tx_hash,
      expires_at: FUNDED_ROW.expires_at,
      delegate_address: DELEGATE_SIGNER.address,
      source: 'x402',
      payment_rail: 'x402',
      payment_resource_url: null,
      x402_resource_url: 'https://merchant.example/resource',
      merchant_address: null,
      x402_merchant_address: MERCHANT.toLowerCase(),
      machine_metadata: FUNDED_ROW.machine_metadata,
      // Funded well past the merchant-report grace window.
      confirmed_at: new Date(Date.now() - 6 * 3600_000).toISOString(),
      funded_but_unsettled: false,
      merchant_leg_reported: false,
      ...over,
    }
  }

  /** Answer the raw-intent read and the derived-status read independently. */
  function serve(intent: Record<string, unknown>, derived: Record<string, unknown> | null) {
    mockQuery.mockImplementation((sql: string) => {
      const text = String(sql)
      if (/WHERE pi\.id = \$1 AND pi\.agent_id = \$2/.test(text)) {
        return Promise.resolve({ rows: derived ? [derived] : [] })
      }
      if (/WHERE id = \$1 AND agent_id = \$2/.test(text)) return Promise.resolve({ rows: [intent] })
      return Promise.resolve({ rows: [] })
    })
  }

  it('serves a rebuilt signing context for a funded intent whose merchant leg was never reported', async () => {
    serve(FUNDED_ROW, statusRow())
    const res = await app.inject({
      method: 'GET', url: `/x402/${INTENT_ID}/sign-context`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.payment_id).toBe(INTENT_ID)
    // Same payload hash and the same digest commitment as any other rebuild —
    // this widens who may FETCH a context, never what the signer will sign.
    expect(body.sign_data.hash).toBe(`0x${'56'.repeat(32)}`)
    const { hashTypedData } = await import('viem')
    const derived = hashTypedData(body.sign_data.typed_data)
    expect(body.x402_expected.typed_data_hash.toLowerCase()).toBe(derived.toLowerCase())
    expect(body.x402_expected.amount).toBe('100000')
    // Read-only: no second funding submit, and no row written.
    expect(mockQuery.mock.calls.some((c) => /INSERT|UPDATE/i.test(String(c[0])))).toBe(false)
  })

  it('mints a FRESH window instead of re-serving the spent quote window', async () => {
    // The stored expires_at is 6h past. Re-serving it would hand the signer a
    // context its own assertX402PaymentWindowOpen refuses, so the rebuild
    // would be dead on arrival for exactly the payments this path rescues.
    serve(FUNDED_ROW, statusRow())
    const res = await app.inject({
      method: 'GET', url: `/x402/${INTENT_ID}/sign-context`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Date.parse(body.x402_expected.expires_at)).toBeGreaterThan(Date.now())
    expect(body.x402_expected.expires_at).not.toBe(FUNDED_ROW.expires_at)
    // The fresh value is what Haven SIGNED, not just what it echoed — a
    // binding whose expiry disagrees with its signature verifies as tampered.
    const signed = JSON.parse(body.x402_expected_auth.message.split('\n')[1])
    expect(signed.expiresAt).toBe(body.x402_expected.expires_at)
    // And nothing was written: the intent row keeps its spent quote window.
    expect(mockQuery.mock.calls.some((c) => /UPDATE payment_intents/i.test(String(c[0])))).toBe(false)
  })

  it("carries the merchant's own EIP-712 domain through the rebuild", async () => {
    serve(FUNDED_ROW, statusRow())
    const res = await app.inject({
      method: 'GET', url: `/x402/${INTENT_ID}/sign-context`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })
    expect(res.json().payment_required).toEqual(STORED_PAYMENT_REQUIRED)
    expect(res.json().payment_required.accepts[0].extra).toEqual(MERCHANT_EXTRA)
  })

  it('stops naming the spent funding submit in its instructions', async () => {
    serve(FUNDED_ROW, statusRow())
    const res = await app.inject({
      method: 'GET', url: `/x402/${INTENT_ID}/sign-context`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })
    const { instructions } = res.json().sign_data
    expect(instructions).not.toContain(`/payments/${INTENT_ID}/sign`)
    expect(instructions).toMatch(/already confirmed/i)
  })

  // ── Every neighbouring confirmed state stays REFUSED ──────────────────────

  it('still 409s a confirmed erc7710 intent — confirmed there IS settlement', async () => {
    const metadata = { network: 'eip155:84532', settlement_scheme: 'erc7710' }
    serve(
      { ...FUNDED_ROW, machine_metadata: metadata },
      statusRow({ machine_metadata: metadata }),
    )
    const res = await app.inject({
      method: 'GET', url: `/x402/${INTENT_ID}/sign-context`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('already_executed')
  })

  it('still 409s once the merchant leg HAS been reported', async () => {
    serve(FUNDED_ROW, statusRow({ merchant_leg_reported: true }))
    const res = await app.inject({
      method: 'GET', url: `/x402/${INTENT_ID}/sign-context`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('already_executed')
  })

  it('still 409s when the merchant REJECTED the retry (remedy is sweep, not resign)', async () => {
    serve(FUNDED_ROW, statusRow({ funded_but_unsettled: true }))
    const res = await app.inject({
      method: 'GET', url: `/x402/${INTENT_ID}/sign-context`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('already_executed')
  })

  it('still 409s inside the merchant-report grace window', async () => {
    // The agent may simply not have retried yet; the status endpoint says
    // nothing to do here, so neither may this route.
    serve(FUNDED_ROW, statusRow({ confirmed_at: new Date().toISOString() }))
    const res = await app.inject({
      method: 'GET', url: `/x402/${INTENT_ID}/sign-context`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('already_executed')
  })

  it('still 409s a confirmed intent with no settlement_scheme metadata (fails closed)', async () => {
    const metadata = { network: 'eip155:84532' }
    serve(
      { ...FUNDED_ROW, machine_metadata: metadata },
      statusRow({ machine_metadata: metadata }),
    )
    const res = await app.inject({
      method: 'GET', url: `/x402/${INTENT_ID}/sign-context`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('already_executed')
  })

  it('still 409s when the derived status row is unreadable (fails closed)', async () => {
    serve(FUNDED_ROW, null)
    const res = await app.inject({
      method: 'GET', url: `/x402/${INTENT_ID}/sign-context`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('already_executed')
  })

  it('a funded intent with no stored signing payload answers not_signable, not already_executed', async () => {
    // The one path the `!fundedMerchantRetry` guard protects: the predicate
    // holds, so the already-executed refusal is skipped, but the rebuild
    // returns null because there is no prepared op to rebuild from. The
    // fall-through then answers on STATUS. Pinned because it is otherwise an
    // edit no test would catch (reviewer finding), not because this wording is
    // the best possible one — `sign_context_unavailable` would describe it
    // more precisely, and restructuring the fall-through to say so is not
    // worth the risk on a path a confirmed eip3009 intent cannot reach: such
    // an intent always carries the prepared op its funding leg was built from.
    serve({ ...FUNDED_ROW, prepared_user_op: null }, statusRow())
    const res = await app.inject({
      method: 'GET', url: `/x402/${INTENT_ID}/sign-context`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('not_signable')
  })

  it('a PENDING intent past its quote window still 410s — the funding leg is still bounded', async () => {
    // Criterion 3 relaxes the stale-window gate for FUNDED money only. An
    // unfunded quote that ran out must still expire, or the window would stop
    // bounding the leg it exists to bound.
    serve(
      { ...FUNDED_ROW, status: 'pending_signature', tx_hash: null },
      statusRow({ status: 'pending_signature', tx_hash: null, confirmed_at: null }),
    )
    const res = await app.inject({
      method: 'GET', url: `/x402/${INTENT_ID}/sign-context`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })
    expect(res.statusCode).toBe(410)
    expect(res.json().error_code).toBe('expired')
  })
})

// ── GET /x402/:id/merchant-call-context — the settle-leg handoff (#1307) ──────
describe('x402 merchant-call-context by payment_id (#1307)', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = Fastify({ logger: false })
    // #3031: production wiring — `routes/x402.ts` is in `enforcedModules`,
    // so the request schema refuses off-spec shapes before the handler.
    installRequestValidation(app, { mode: 'enforce', enforcedModules: ['routes/x402.ts'] })
    await app.register(x402Routes, { prefix: '/x402' })
  })
  afterAll(async () => app.close())
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const CALL_CONTEXT_ROW = {
    id: INTENT_ID,
    status: 'pending_signature',
    expires_at: new Date(Date.now() + 300_000).toISOString(),
    x402_resource_url: 'https://merchant.example/resource',
    machine_metadata: {
      network: 'eip155:84532',
      settlement_scheme: 'eip3009',
      mcp_call_context: {
        merchantUrl: 'https://merchant.example/mcp',
        toolName: 'buy_cloud_storage',
        arguments: { tier: '50gb' },
        mcpTransport: { handshakeRequired: true, source: 'path' },
      },
    },
  }

  function serveIntentRow(rows: Record<string, unknown>[]) {
    mockQuery.mockImplementation((sql: string) => {
      if (/WHERE id = \$1 AND agent_id = \$2/.test(String(sql))) return Promise.resolve({ rows })
      return Promise.resolve({ rows: [] })
    })
  }

  it('serves the stored merchant call context', async () => {
    serveIntentRow([CALL_CONTEXT_ROW])
    const res = await app.inject({
      method: 'GET', url: `/x402/${INTENT_ID}/merchant-call-context`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.payment_id).toBe(INTENT_ID)
    expect(body.merchant_url).toBe('https://merchant.example/mcp')
    expect(body.tool_name).toBe('buy_cloud_storage')
    expect(body.arguments).toEqual({ tier: '50gb' })
    // #2343 REVERSES this assertion. It previously read
    // `toEqual({ handshakeRequired: true, source: 'path' })` — pinning the
    // defect as correct, which is why it shipped: the endpoint emitted a
    // snake_case KEY with camelCase INNARDS, and the one test that looked at
    // the value agreed with it. This endpoint's contract is snake_case, the
    // same shape the hosted `mcpTransportArg` / `parseMcpTransport` boundary
    // accepts. Asserted both ways on purpose — the wrong key being ABSENT is
    // half the property, and `toEqual` alone would pass on a merged object.
    expect(body.mcp_transport).toEqual({ handshake_required: true, source: 'path' })
    expect(typeof body.mcp_transport.handshake_required).toBe('boolean')
    expect('handshakeRequired' in body.mcp_transport).toBe(false)
    // #2343 (review): the OpenAPI schema for this endpoint ALWAYS declared the
    // correct snake_case nested shape with additionalProperties:false, and the
    // generated @haven_ai/core type always matched it. This one line would have
    // failed CI the moment the bug shipped — the stray `handshakeRequired` key
    // is rejected outright — instead of it surviving to a live qa-dev failure.
    // The assertions above pin the specific values; this pins the CONTRACT, and
    // it is the one that generalises to the next field added here.
    expectMatchesSpec('GET', '/x402/{id}/merchant-call-context', body)
    // Read-only: nothing was written.
    expect(mockQuery.mock.calls.some((c) => /INSERT|UPDATE/i.test(String(c[0])))).toBe(false)
  })

  it('omits mcp_transport entirely when none was stored (#2343)', async () => {
    // The other half of the ternary this fix edits. A context without a
    // transport must omit the key, not emit an empty or half-built object —
    // absent and malformed are different answers to the hosted boundary.
    serveIntentRow([{
      ...CALL_CONTEXT_ROW,
      machine_metadata: {
        network: 'eip155:84532',
        mcp_call_context: {
          merchantUrl: 'https://merchant.example/mcp',
          toolName: 'buy_cloud_storage',
        },
      },
    }])
    const res = await app.inject({
      method: 'GET', url: `/x402/${INTENT_ID}/merchant-call-context`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })
    expect(res.statusCode).toBe(200)
    expect('mcp_transport' in res.json()).toBe(false)
    expectMatchesSpec('GET', '/x402/{id}/merchant-call-context', res.json())
  })

  it('404s an unknown or foreign payment id (same answer on purpose)', async () => {
    serveIntentRow([])
    const res = await app.inject({
      method: 'GET', url: `/x402/${INTENT_ID}/merchant-call-context`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('409s with the fallback named when no merchant call context was stored', async () => {
    serveIntentRow([{ ...CALL_CONTEXT_ROW, machine_metadata: { network: 'eip155:84532' } }])
    const res = await app.inject({
      method: 'GET', url: `/x402/${INTENT_ID}/merchant-call-context`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('merchant_call_context_unavailable')
    expect(res.json().error).toMatch(/merchant_url, tool_name/)
  })

  it('409s an incomplete stored context (missing toolName)', async () => {
    serveIntentRow([{
      ...CALL_CONTEXT_ROW,
      machine_metadata: {
        network: 'eip155:84532',
        mcp_call_context: { merchantUrl: 'https://merchant.example/mcp' },
      },
    }])
    const res = await app.inject({
      method: 'GET', url: `/x402/${INTENT_ID}/merchant-call-context`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error_code).toBe('merchant_call_context_unavailable')
  })

  it('409s a DIRECT (non-x402) payment intent', async () => {
    serveIntentRow([{ ...CALL_CONTEXT_ROW, x402_resource_url: null }])
    const res = await app.inject({
      method: 'GET', url: `/x402/${INTENT_ID}/merchant-call-context`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })
    expect(res.statusCode).toBe(409)
  })

  it('410s and lazy-expires a stale PENDING row (the #961/#1263 discipline)', async () => {
    serveIntentRow([{ ...CALL_CONTEXT_ROW, expires_at: new Date(Date.now() - 1000).toISOString() }])
    const res = await app.inject({
      method: 'GET', url: `/x402/${INTENT_ID}/merchant-call-context`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })
    expect(res.statusCode).toBe(410)
    expect(res.json().error_code).toBe('expired')
    expect(mockQuery.mock.calls.some((c) => /UPDATE payment_intents/i.test(String(c[0])))).toBe(true)
  })

  it('410s an already-EXPIRED row without a redundant UPDATE', async () => {
    serveIntentRow([{ ...CALL_CONTEXT_ROW, status: 'expired' }])
    const res = await app.inject({
      method: 'GET', url: `/x402/${INTENT_ID}/merchant-call-context`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })
    expect(res.statusCode).toBe(410)
    expect(mockQuery.mock.calls.some((c) => /UPDATE payment_intents/i.test(String(c[0])))).toBe(false)
  })

  // #1307: idempotent re-settle. A CONFIRMED (funded) intent past its
  // original funding-window expires_at must stay servable — a merchant
  // delivery retry (e.g. after MERCHANT_UNRESPONSIVE_AFTER_FUNDING) must not
  // be forced into a fresh haven_pay_mcp_tool quote, which would mint a
  // SECOND funding intent for what is already a funded payment. Two GETs in
  // a row are byte-identical AND read-only.
  it('stays servable and read-only for a CONFIRMED intent past its original expiry (no premature lazy-expire)', async () => {
    const confirmedPastExpiry = {
      ...CALL_CONTEXT_ROW,
      status: 'confirmed',
      expires_at: new Date(Date.now() - 1000).toISOString(),
    }
    serveIntentRow([confirmedPastExpiry])

    const first = await app.inject({
      method: 'GET', url: `/x402/${INTENT_ID}/merchant-call-context`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })
    const second = await app.inject({
      method: 'GET', url: `/x402/${INTENT_ID}/merchant-call-context`,
      headers: { authorization: 'Bearer sk_agent_test' },
    })

    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)
    expect(second.json()).toEqual(first.json())
    expect(mockQuery.mock.calls.some((c) => /UPDATE payment_intents/i.test(String(c[0])))).toBe(false)
  })

  // ── #2945: the payment_refusals ledger — characterization ─────────────────
  //
  // The ledger is a RECORD of what the guardrails refused; it must never
  // change what the caller receives. These tests pin, for every refusal on
  // this surface, that the response is byte-identical with the ledger
  // succeeding AND failing (the real module swallows write failures — the
  // failing case proves the refusal does not wait on or branch on the
  // ledger's outcome), and that the WRITE ASK carries the right reason,
  // source and detail allowlist. The write itself is proven against real
  // Postgres in infra/repositories/__tests__/payment-refusals.test.ts.
  describe('payment_refusals ledger characterization (#2945)', () => {
    // Same value as the main describe's DELEGATE_EOA: payTo = the delegate
    // EOA selects the EIP-3009 funding leg.
    const FUNDING_EOA = DELEGATE_SIGNER.address

    // The enclosing describe's beforeEach clears ALL mocks; restore the
    // default db routing the authorize handler needs (hourly cap, usage).
    beforeEach(() => {
      mockQuery.mockImplementation((sql: string) => {
        if (/max_x402_per_hour/.test(String(sql))) return Promise.resolve({ rows: [{ max_x402_per_hour: 100 }] })
        if (/COUNT\(\*\)/.test(String(sql))) return Promise.resolve({ rows: [{ cnt: '0' }] })
        return Promise.resolve({ rows: [] })
      })
    })
    /** The full over-budget erc7710 refusal, as JSON — the byte-identity anchor. */
    async function overBudgetErc7710Response(): Promise<string> {
      mockSelect.mockResolvedValue({
        delegation_hash: `0x${'12'.repeat(32)}`,
        delegation_json: JSON.stringify(signedBudget),
        recipient_address: null,
      })
      mockReadRemaining.mockResolvedValue({ remainingAtomic: '50000', fromChain: true })
      const res = await app.inject({
        method: 'POST', url: '/x402/authorize',
        headers: { authorization: 'Bearer «redacted:sk_…»' },
        payload: authorizeBody({ amount: '100000' }),
      })
      expect(res.statusCode).toBe(403)
      return JSON.stringify(res.json())
    }

    it('the erc7710 over-budget refusal body is byte-identical with the ledger succeeding and failing', async () => {
      mockRecordRefusal.mockImplementation(() => {})
      const withLedger = await overBudgetErc7710Response()

      // The failing case, modeled FAITHFULLY: the real
      // recordRefusalFireAndForget returns synchronously and swallows its own
      // write failure — it can never throw into the handler. So the broken
      // ledger is a call that returns normally while its write fails
      // asynchronously. A synchronous throw here would model an impossible
      // state (and this test would then pin a 500 the real system cannot
      // produce). The dedicated proof that the swallowed failure changes
      // nothing lives in modules/payments/__tests__/refusal-ledger.test.ts.
      mockRecordRefusal.mockReset()
      mockRecordRefusal.mockImplementation(() => {
        Promise.reject(new Error('payment_refusals write exploded')).catch(() => {})
      })
      const withBrokenLedger = await overBudgetErc7710Response()

      expect(withBrokenLedger).toBe(withLedger)
    })

    it('the erc7710 over-budget refusal records reason/source and the detail allowlist', async () => {
      mockRecordRefusal.mockImplementation(() => {})
      await overBudgetErc7710Response()

      expect(mockRecordRefusal).toHaveBeenCalledTimes(1)
      const ask = mockRecordRefusal.mock.calls[0][0] as Record<string, unknown>
      expect(ask).toMatchObject({
        userId: 'user-1',
        agentId: 'agent-1',
        chainId: 84532,
        tokenSymbol: 'USDC',
        amountAtomic: '100000',
        reason: 'delegation_budget_exceeded',
        source: 'x402_authorize',
      })
      // detail is the ALLOWLIST — no whole-body copy can slip through the
      // writer's pick (proven at the DB level by migration 086's CHECK).
      expect(ask.detail).toEqual({
        error_code: 'delegation_budget_exceeded',
        phase: 'insufficient_funds',
        next_action: 'fund_account_or_raise_allowance',
        remaining_atomic: '50000',
      })
    })

    it('the EIP-3009 funding-leg over-budget refusal: identical body with/without the ledger, right write ask', async () => {
      mockSelect.mockResolvedValue({
        delegation_hash: `0x${'12'.repeat(32)}`,
        delegation_json: JSON.stringify(signedBudget),
        recipient_address: null,
      })
      mockReadRemaining.mockResolvedValue({ remainingAtomic: '50000', fromChain: true })
      const body = authorizeBody({ payTo: FUNDING_EOA, merchantPayTo: MERCHANT, amount: '100000' })

      mockRecordRefusal.mockImplementation(() => {})
      const withLedger = await app.inject({
        method: 'POST', url: '/x402/authorize',
        headers: { authorization: 'Bearer «redacted:sk_…»' },
        payload: body,
      })
      expect(withLedger.statusCode).toBe(403)
      const ask = mockRecordRefusal.mock.calls[0][0] as Record<string, unknown>
      expect(ask.reason).toBe('delegation_budget_exceeded')
      expect(ask.source).toBe('x402_authorize')
      // On the funding leg the merchant is the SEPARATE field (payTo is the
      // funding target) — the ledger must name the real merchant.
      expect(ask.merchantTo).toBe(MERCHANT.toLowerCase())

      mockRecordRefusal.mockReset()
      mockRecordRefusal.mockImplementation(() => {
        Promise.reject(new Error('payment_refusals write exploded')).catch(() => {})
      })
      const withBrokenLedger = await app.inject({
        method: 'POST', url: '/x402/authorize',
        headers: { authorization: 'Bearer «redacted:sk_…»' },
        payload: body,
      })
      expect(withBrokenLedger.statusCode).toBe(403)
      expect(JSON.stringify(withBrokenLedger.json())).toBe(JSON.stringify(withLedger.json()))
    })

    it('the no-delegation-for-target 403 (recipient pin) is recorded and the body is unchanged by a broken ledger', async () => {
      // No delegation for (agent, token, merchant) — how a recipient pin
      // refuses on this rail, named for what it is.
      mockSelect.mockResolvedValue(null)
      mockReadRemaining.mockResolvedValue({ remainingAtomic: '5000000', fromChain: true })
      const inject403 = async () => {
        const res = await app.inject({
          method: 'POST', url: '/x402/authorize',
          headers: { authorization: 'Bearer «redacted:sk_…»' },
          payload: authorizeBody(),
        })
        expect(res.statusCode).toBe(403)
        return JSON.stringify(res.json())
      }

      mockRecordRefusal.mockImplementation(() => {})
      const withLedger = await inject403()
      const ask = mockRecordRefusal.mock.calls[0][0] as Record<string, unknown>
      expect(ask).toMatchObject({
        reason: 'no_delegation_for_target',
        source: 'x402_authorize',
        merchantTo: MERCHANT.toLowerCase(),
      })
      expect(ask.detail).toEqual({ error_code: 'no_delegation_for_target' })

      mockRecordRefusal.mockReset()
      mockRecordRefusal.mockImplementation(() => {
        Promise.reject(new Error('payment_refusals write exploded')).catch(() => {})
      })
      const withBrokenLedger = await inject403()
      expect(withBrokenLedger).toBe(withLedger)
    })

    it('POSITIVE CONTROL: a successful authorize writes NO refusal', async () => {
      mockSelect.mockResolvedValue({
        delegation_hash: `0x${'12'.repeat(32)}`,
        delegation_json: JSON.stringify(signedBudget),
        recipient_address: null,
      })
      mockReadRemaining.mockResolvedValue({ remainingAtomic: '5000000', fromChain: true })
      mockCreateIntent.mockResolvedValue({ id: INTENT_ID, status: 'pending_signature', expires_at: 'x' })
      const res = await app.inject({
        method: 'POST', url: '/x402/authorize',
        headers: { authorization: 'Bearer ' + ['sk', 'agent', 'test', 'key', '0001'].join('_') },
        payload: authorizeBody(),
      })
      expect(res.statusCode).toBe(201)
      expect(mockRecordRefusal).not.toHaveBeenCalled()
    })

    // ── #3052 (epic #3056 slice 1): the two EIP-3009 funding-leg refusals
    // that had no writer while their siblings for the identical condition
    // did. Same characterization contract as everything above: the response is
    // byte-identical with the ledger succeeding AND failing, and the write ask
    // carries the named reason, the x402 source, and the REAL merchant (never
    // the funding EOA — `payTo` on this leg is the agent's own delegate).
    // The row landing is proven against real Postgres in
    // modules/x402/__tests__/delegation-authorize-refusal-ledger.test.ts.

    /** Persistent rejection at the prepare seam: both injections of one test
     *  must answer the same 502 (a Once-rejection would let the second fall
     *  through to the base implementation and answer a different status). */
    function fundingPrepareReverts(message: string) {
      mockSelect.mockResolvedValue({
        delegation_hash: `0x${'12'.repeat(32)}`,
        delegation_json: JSON.stringify(signedBudget),
        recipient_address: null,
      })
      mockReadRemaining.mockResolvedValue({ remainingAtomic: '5000000', fromChain: true })
      mockPrepareFunding.mockRejectedValue(new Error(message))
    }

    it('the funding-leg prepare revert (expired caveat) is booked as delegation_expired; the 502 is byte-identical with a broken ledger (#3052)', async () => {
      // The classifier's four-way contract at this call site: the timestamp
      // enforcer's revert text names a refusal, so the catch books it. The
      // 502 response — a raw redacted vendor dump — is untouched either way.
      fundingPrepareReverts(
        "before execution's timestamp is before this caveat's beforeThreshold",
      )
      const body = authorizeBody({ payTo: FUNDING_EOA, merchantPayTo: MERCHANT })

      mockRecordRefusal.mockImplementation(() => {})
      const withLedger = await app.inject({
        method: 'POST', url: '/x402/authorize',
        headers: { authorization: 'Bearer ' + ['sk', 'agent', 'test', 'key', '0001'].join('_') },
        payload: body,
      })
      expect(withLedger.statusCode).toBe(502)
      expect(withLedger.json().error).toMatch(/funding authorization failed/)
      expect(mockRecordRefusal).toHaveBeenCalledTimes(1)
      const ask = mockRecordRefusal.mock.calls[0][0] as Record<string, unknown>
      expect(ask).toMatchObject({
        userId: 'user-1',
        agentId: 'agent-1',
        chainId: 84532,
        tokenSymbol: 'USDC',
        amountAtomic: '100000',
        accountAddress: '0x' + 'aa'.repeat(20),
        // The issue calls this out by name: on this leg `payTo` is the
        // agent's own funding EOA; the ledger must name the real merchant.
        merchantTo: MERCHANT.toLowerCase(),
        resourceUrl: 'https://merchant.example/resource',
        reason: 'delegation_expired',
        source: 'x402_authorize',
      })
      expect(ask.detail).toEqual({ error_code: 'delegation_expired' })
      expect(mockCreateIntent).not.toHaveBeenCalled()

      mockRecordRefusal.mockReset()
      mockRecordRefusal.mockImplementation(() => {
        Promise.reject(new Error('payment_refusals write exploded')).catch(() => {})
      })
      const withBrokenLedger = await app.inject({
        method: 'POST', url: '/x402/authorize',
        headers: { authorization: 'Bearer ' + ['sk', 'agent', 'test', 'key', '0001'].join('_') },
        payload: body,
      })
      expect(withBrokenLedger.statusCode).toBe(502)
      expect(JSON.stringify(withBrokenLedger.json())).toBe(JSON.stringify(withLedger.json()))
    })

    it('an unclassifiable prepare failure (an outage, not a revert) still 502s and writes NOTHING (#3052)', async () => {
      // The null half of the classifier's contract AT THIS CALL SITE (the
      // classifier's unit contract is pinned in refusal-ledger.test.ts): the
      // guardrails refused nothing, the infrastructure broke, and recording it
      // would pollute the refusal ledger with outages. Same 502 shape, zero
      // ledger asks.
      fundingPrepareReverts('fetch failed: bundler unreachable (ETIMEDOUT)')
      mockRecordRefusal.mockImplementation(() => {})
      const res = await app.inject({
        method: 'POST', url: '/x402/authorize',
        headers: { authorization: 'Bearer ' + ['sk', 'agent', 'test', 'key', '0001'].join('_') },
        payload: authorizeBody({ payTo: FUNDING_EOA, merchantPayTo: MERCHANT }),
      })
      expect(res.statusCode).toBe(502)
      expect(res.json().error).toMatch(/funding authorization failed/)
      expect(mockRecordRefusal).not.toHaveBeenCalled()
      expect(mockCreateIntent).not.toHaveBeenCalled()
    })

    it('the no-fundable-delegation 403 on the 3009 leg is booked as no_delegation_for_target; the body is unchanged by a broken ledger (#3052)', async () => {
      // `prepareDelegationPayment` resolving null: no open (unpinned) budget
      // can fund the EOA. The condition the erc7710 branch above and the
      // POST /payments sibling both booked from the start; this leg answered
      // it with nothing in the audit trail. Same reason, same source, the
      // merchant — never the funding EOA.
      mockSelect.mockResolvedValue({
        delegation_hash: `0x${'12'.repeat(32)}`,
        delegation_json: JSON.stringify(signedBudget),
        recipient_address: null,
      })
      mockReadRemaining.mockResolvedValue({ remainingAtomic: '5000000', fromChain: true })
      mockPrepareFunding.mockResolvedValue(null)
      const body = authorizeBody({ payTo: FUNDING_EOA, merchantPayTo: MERCHANT })
      const inject403 = async () => {
        const res = await app.inject({
          method: 'POST', url: '/x402/authorize',
          headers: { authorization: 'Bearer ' + ['sk', 'agent', 'test', 'key', '0001'].join('_') },
          payload: body,
        })
        expect(res.statusCode).toBe(403)
        expect(res.json().error).toMatch(/no delegation able to fund EIP-3009 settlement/)
        return JSON.stringify(res.json())
      }

      mockRecordRefusal.mockImplementation(() => {})
      const withLedger = await inject403()
      expect(mockRecordRefusal).toHaveBeenCalledTimes(1)
      const ask = mockRecordRefusal.mock.calls[0][0] as Record<string, unknown>
      expect(ask).toMatchObject({
        userId: 'user-1',
        agentId: 'agent-1',
        chainId: 84532,
        tokenSymbol: 'USDC',
        amountAtomic: '100000',
        accountAddress: '0x' + 'aa'.repeat(20),
        merchantTo: MERCHANT.toLowerCase(),
        resourceUrl: 'https://merchant.example/resource',
        reason: 'no_delegation_for_target',
        source: 'x402_authorize',
      })
      expect(ask.detail).toEqual({ error_code: 'no_delegation_for_target' })
      expect(mockCreateIntent).not.toHaveBeenCalled()

      mockRecordRefusal.mockReset()
      mockRecordRefusal.mockImplementation(() => {
        Promise.reject(new Error('payment_refusals write exploded')).catch(() => {})
      })
      const withBrokenLedger = await inject403()
      expect(withBrokenLedger).toBe(withLedger)
    })
  })
})
