import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import paymentRoutes from '../payments.js'
import { allowanceModuleRailRetired } from '../../rails/execution-rail.js'

/**
 * On-chain-is-the-final-gate contract test (design:
 * docs/research/non-custody-verification.md; guardrail: casp-risk-guardrails.md
 * Red Line #4, "Off-Chain-Only Spend Control" + "Use On-Chain Enforcement As
 * The Final Gate").
 *
 * **Rebased onto the live delegation rail (#1986, epic #1440 slice 3), with a
 * named boundary this suite does NOT close — read this before trusting the
 * green.**
 *
 * The original suite proved the spend envelope on the legacy AllowanceModule
 * rail was the ON-CHAIN remaining (`computeEffectiveAllowance`), not Haven's
 * database — Haven's own arithmetic decided whether to queue an approval or
 * mint a signable intent, but the NUMBER that arithmetic used came from a
 * chain read. On the delegation rail there is no equivalent Haven-side
 * arithmetic at all: `routes/payments.ts`'s delegation branch never calls
 * `computeEffectiveAllowance`, `getTokenAllowance`, or `decideCoverage` — it
 * calls `prepareDelegationPayment`, which asks the bundler to estimate gas for
 * the redemption, and that estimation runs the DelegationManager's caveat
 * enforcers (budget, recipient, expiry) ON-CHAIN, in Solidity. An
 * out-of-policy payment reverts DURING THAT ESTIMATION, `prepareDelegationPayment`
 * throws, and Haven forwards the refusal — it does not, and structurally
 * cannot, second-guess it with its own remaining-balance math.
 *
 * The cases below prove the part of that claim this backend test CAN reach:
 *   - the delegation branch performs NO off-chain coverage arithmetic, ever
 *     (`computeEffectiveAllowance`/`getTokenAllowance`/`decideCoverage` are
 *     asserted not-called in every delegation-rail case, refusal or success);
 *   - a rejection from the on-chain simulation (`prepareDelegationPayment`
 *     throwing, standing in for a caveat-enforcer revert) is forwarded
 *     verbatim as a refusal, with NOTHING written and no local override;
 *   - only an on-chain ACCEPTANCE (`prepareDelegationPayment` resolving)
 *     produces a signable intent — the mandatory positive control.
 *
 * **What this suite does NOT prove, and cannot from this seam: that the
 * DelegationManager's caveat enforcers themselves correctly revert an
 * over-budget/wrong-recipient/expired redemption.** That is on-chain Solidity
 * behaviour, exercised by the bundler during real gas estimation — outside a
 * backend unit test's reach by construction, since `prepareDelegationPayment`
 * is mocked here as the network seam. Proving the enforcer itself needs an
 * on-chain/integration proof (a forked-chain or testnet call against the
 * deployed DelegationManager+enforcers) — this is a BLOCKING FINDING reported
 * to the captain, for #1991 (the CASP rewrite) to pick up; do not treat this
 * file's green as closing that gap.
 *
 * The legacy-rail cases are kept as an ADDITIONAL, STRICTLY STRONGER
 * assertion (#1986): the retired rail now refuses BEFORE any on-chain
 * allowance read runs at all, regardless of the requested amount — collapsed
 * into one parametrized case rather than the original three, since all three
 * inputs now produce the identical early refusal.
 */

const { mockQuery, allowanceMocks, fiatMocks, delegationMocks } = vi.hoisted(() => ({
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
  delegationMocks: {
    prepareDelegationPayment: vi.fn(),
    submitDelegationPayment: vi.fn(),
  },
}))

// #1196 wired the allowance-nonce coordinator into this path, so it now reads
// the shared watermark alongside its chain reads. Stub the watermark
// repository instead of adding it to the content-dispatch table: it is
// fail-open and orthogonal to what these tests assert.
vi.mock('../../infra/repositories/allowance-nonce-watermarks.js', () => ({
  findAllowanceNonceWatermark: async () => null,
  raiseAllowanceNonceWatermark: async () => {},
}))
vi.mock('../../db.js', () => ({ default: { query: (...args: unknown[]) => mockQuery(...args) } }))
vi.mock('../../rails/allowance-module.js', () => allowanceMocks)
vi.mock('../../infra/fiat-values.js', () => fiatMocks)
vi.mock('../../rails/delegation-authorization.js', () => delegationMocks)

const AGENT = {
  id: '11111111-1111-1111-1111-111111111111',
  user_id: '22222222-2222-2222-2222-222222222222',
  name: 'Payment Agent',
  delegate_address: '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1',
  safe_address: '0x135a9215604711AC70d970e12Caa812c53537EF4',
  chain_id: 84532,
  status: 'active',
}
const RECIPIENT = '0x15179876c595922999C2d5DC7c23Cc7711fE799a'
const USER_OP_HASH = `0x${'cd'.repeat(32)}`
const DELEGATION_HASH = `0x${'12'.repeat(32)}`
const PAY = { token: 'USDC', amount: '1', to: RECIPIENT }

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

const AUTH: DbRoute = [/api_key_hash = \$1/, () => ({ rows: [AGENT] })]
/** `FIND_EXECUTION_RAIL_FOR_AGENT_SQL` — the account's CURRENT rail. */
const railRoute = (rail: string | null): DbRoute => [
  /LEFT JOIN user_safes/,
  () => ({ rows: [{ execution_rail: rail }] }),
]
const insertIntent = (row: Record<string, unknown>): DbRoute => [
  /INSERT INTO payment_intents/,
  () => ({ rows: [row] }),
]

function intentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'intent-1',
    status: 'pending_signature',
    expires_at: '2099-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/** Every off-chain "how much is left" computation this suite must never see run on the delegation rail. */
function expectNoOffChainCoverageArithmetic() {
  expect(allowanceMocks.computeEffectiveAllowance).not.toHaveBeenCalled()
  expect(allowanceMocks.getTokenAllowance).not.toHaveBeenCalled()
  expect(allowanceMocks.generateTransferHash).not.toHaveBeenCalled()
}

describe('non-custody: the on-chain policy is the final gate (Red Line #4)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(paymentRoutes, { prefix: '/payments' })
  })
  afterAll(async () => { await app.close() })
  beforeEach(() => {
    mockQuery.mockReset()
    for (const m of Object.values(allowanceMocks)) m.mockReset()
    for (const m of Object.values(fiatMocks)) m.mockReset()
    for (const m of Object.values(delegationMocks)) m.mockReset()
    allowanceMocks.getTokenAllowance.mockResolvedValue({
      token: '0x0000000000000000000000000000000000000000',
      amount: 0n, spent: 0n, resetTimeMin: 0, lastResetMin: 0, nonce: 7,
    })
    allowanceMocks.getLatestBlockTimeSec.mockResolvedValue(1_900_000_000)
  })

  // ── #1986 retirement: kept as one additional, strictly stronger case ─────

  it.each([
    ['a request exceeding what the legacy on-chain remaining ever was', '1'],
    ['a request well within what the legacy on-chain remaining ever was', '0.000001'],
  ])(
    '#1986 RETIREMENT: %s is refused before ANY on-chain allowance read — amount is irrelevant on the retired rail',
    async (_label, amount) => {
      primeDb(AUTH, railRoute(null)) // no Safe row / no rail marking → retired_allowance

      const res = await app.inject({
        method: 'POST',
        url: '/payments',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: { ...PAY, amount },
      })

      expect(res.statusCode).toBe(410)
      expect(res.json().error).toBe(allowanceModuleRailRetired('account').body.error)
      expectNoOffChainCoverageArithmetic()
      expect(allowanceMocks.executeAllowanceTransfer).not.toHaveBeenCalled()
    },
  )

  // ── DELEGATION RAIL: the on-chain simulation is the only gate ────────────

  it('DELEGATION RAIL: a caveat-enforcer rejection is forwarded verbatim — nothing written, no off-chain override', async () => {
    // Stand-in for the DelegationManager's caveat enforcers reverting during
    // gas estimation (budget/recipient/expiry) — see the file header for what
    // this can and cannot prove about the Solidity itself.
    delegationMocks.prepareDelegationPayment.mockRejectedValueOnce(
      new Error('ERC20PeriodTransferEnforcer:transfer-amount-exceeded'),
    )
    primeDb(AUTH, railRoute('delegation'))

    const res = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: PAY,
    })

    expect(res.statusCode).toBe(502)
    expect(res.json().error).toMatch(/on-chain policy/)
    expect(res.json().details).toContain('transfer-amount-exceeded')
    expectNoOffChainCoverageArithmetic()
    expect(mockQuery.mock.calls.some((c) => /INSERT INTO payment_intents/.test(String(c[0])))).toBe(false)
  })

  it('DELEGATION RAIL: no active delegation authorizes this recipient — refused, still no off-chain arithmetic', async () => {
    delegationMocks.prepareDelegationPayment.mockResolvedValueOnce(null)
    primeDb(AUTH, railRoute('delegation'))

    const res = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: PAY,
    })

    expect(res.statusCode).toBe(403)
    expectNoOffChainCoverageArithmetic()
    expect(mockQuery.mock.calls.some((c) => /INSERT INTO payment_intents/.test(String(c[0])))).toBe(false)
  })

  it('DELEGATION RAIL — positive control: the on-chain simulation accepts the payment and Haven relays a signable intent, still without computing its own remaining', async () => {
    delegationMocks.prepareDelegationPayment.mockResolvedValueOnce({
      delegationHash: DELEGATION_HASH,
      prepared: {
        userOperation: { sender: AGENT.safe_address, nonce: 1n, callData: '0xabcd' },
        userOpHash: USER_OP_HASH,
        signingTypedData: { domain: { name: 'HybridDeleGator' }, types: {}, primaryType: 'PackedUserOperation', message: {} },
        delegateAccountAddress: '0x' + 'ee'.repeat(20),
      },
    })
    primeDb(
      AUTH,
      railRoute('delegation'),
      insertIntent(intentRow({ execution_rail: 'delegation' })),
    )

    const res = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: PAY,
    })

    expect(res.statusCode, `delegation rail must still pay, got ${res.body}`).toBe(201)
    expect(res.json().sign_data).toBeTruthy()
    // The chain's simulation was consulted — nothing else was:
    expect(delegationMocks.prepareDelegationPayment).toHaveBeenCalledOnce()
    expectNoOffChainCoverageArithmetic()
    expect(allowanceMocks.executeAllowanceTransfer).not.toHaveBeenCalled()
  })
})
