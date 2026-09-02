import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import paymentRoutes from '../payments.js'
import { allowanceModuleRailRetired, serializeUserOp } from '../../rails/execution-rail.js'

/**
 * Authn ≠ authz contract test (design: docs/research/non-custody-verification.md;
 * guardrail: casp-risk-guardrails.md Red Line #3, "API auth is identity,
 * signature is authority").
 *
 * Proves the single most important custody promise: an **authenticated** agent
 * request (valid API key) can NEVER move funds on its own. Only a signature that
 * is actually authorised by the on-chain delegate releases a transfer.
 *
 * **Rebased onto the live delegation rail (#1986, epic #1440 slice 3).** The
 * legacy AllowanceModule rail recovered a signer LOCALLY (`recoverSigner`) and
 * compared it against `delegate_address` in this codebase — that comparison is
 * what the original version of this file asserted directly. The delegation
 * rail (#829) does not: the agent signs the account's own EIP-712 typed data,
 * and the delegate SMART ACCOUNT validates that signature itself, on-chain,
 * inside `validateUserOp` during bundler submission (`submitDelegationPayment`
 * → `rails/delegation-rail.ts#submitRedemption`, the mocked network seam
 * below). Locally, `routes/payments.ts` only shape-checks the signature
 * (`/^0x[0-9a-fA-F]{100,}$/`) before forwarding it — by design, per the
 * comment at `routes/payments.ts` lines ~809-816: a local EIP-712
 * reconstruction would be a second, weaker source of truth that could
 * false-reject a valid signature.
 *
 * That means this suite's delegation-rail cases prove the honest equivalent:
 *   - a shape-invalid signature is refused LOCALLY, before any chain call
 *     (case 3) — this exercises real production code, the regex;
 *   - a signature the account rejects on-chain (i.e. one that does not recover
 *     to the delegate — the exact condition the original suite asserted
 *     directly) is refused because `submitDelegationPayment` (standing in for
 *     the bundler/EntryPoint/account) throws, and Haven fails closed with
 *     NOTHING confirmed and no local override (case 4);
 *   - only a signature the account accepts on-chain releases the transfer
 *     (case 5, the mandatory positive control).
 * What this suite does NOT prove — and cannot, from this seam — is that the
 * delegate smart account's `validateUserOp` itself correctly rejects a
 * non-delegate signature; that is on-chain Solidity, exercised by the
 * account/bundler, not by this backend. See the file-level REPORT to the
 * captain for this boundary.
 *
 * The legacy-rail case (case 2) is kept as an ADDITIONAL, STRICTLY STRONGER
 * assertion: #1986 retired that rail, so it now refuses unconditionally —
 * even a signature that WOULD have recovered to the delegate never reaches
 * `executeAllowanceTransfer`. It is not a replacement for the delegation-rail
 * proof above; a suite that only ever says "refused" proves nothing (a suite
 * that can only ever say no would pass just as happily with the payment code
 * deleted) — case 5 is what makes every refusal in this file meaningful.
 */

const { mockQuery, fiatMocks, delegationMocks } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  fiatMocks: {
    getFiatValuesForTokenAmount: vi.fn(),
    getBookTimeSekValue: vi.fn().mockResolvedValue(null),
  },
  delegationMocks: {
    prepareDelegationPayment: vi.fn(),
    submitDelegationPayment: vi.fn(),
  },
}))

vi.mock('../../db.js', () => ({ default: { query: (...args: unknown[]) => mockQuery(...args) } }))
vi.mock('../../infra/fiat-values.js', () => fiatMocks)
// Only the network seam of the delegation rail (bundler/EntryPoint/account) is
// mocked — everything else (the shape check, the claim/confirm writes) is
// real production code from routes/payments.ts.
vi.mock('../../rails/delegation-authorization.js', () => delegationMocks)

const AGENT = {
  id: '11111111-1111-1111-1111-111111111111',
  user_id: '22222222-2222-2222-2222-222222222222',
  name: 'Payment Agent',
  delegate_address: '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1',
  safe_address: '0x135a9215604711AC70d970e12Caa812c53537EF4',
  chain_id: 100,
  status: 'active',
}
const PAYMENT_ID = '33333333-3333-3333-3333-333333333333'
const SIGNATURE = `0x${'ab'.repeat(65)}` // legacy-shape (raw ECDSA, 65 bytes) — 130 hex chars
const SHAPE_INVALID_SIGNATURE = `0x${'ab'.repeat(10)}` // 20 hex chars — under the delegation-rail's 100-char floor
const USEROP_SIGNATURE = `0x${'ab'.repeat(97)}` // >=100 hex chars, passes the delegation-rail shape check
const TX_HASH = `0x${'cd'.repeat(32)}`
const DELEGATION_HASH = `0x${'12'.repeat(32)}`
const PREPARED_USER_OP = {
  sender: AGENT.safe_address,
  nonce: 123456789012345678901234567890n,
  callData: '0xdeadbeef',
}

// ── Content-dispatch DB stub (#1226) — matched by SQL fragment, never by
// call position, so adding a case never re-shuffles an unrelated one. ────────
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

function legacyIntentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    agent_id: AGENT.id,
    user_id: AGENT.user_id,
    safe_address: AGENT.safe_address,
    chain_id: AGENT.chain_id,
    token_symbol: 'xDAI',
    token_address: '0x0000000000000000000000000000000000000000',
    to_address: '0x15179876c595922999C2d5DC7c23Cc7711fE799a',
    amount_raw: '1000000000000000000',
    amount_human: '1',
    delegate_address: AGENT.delegate_address,
    allowance_nonce: 7,
    sign_hash: `0x${'11'.repeat(32)}`,
    signature: null,
    status: 'pending_signature',
    expires_at: '2099-01-01T00:00:00.000Z',
    execution_rail: null, // the retired population (#1986): unset → legacy
    ...overrides,
  }
}

function delegationIntentRow(overrides: Record<string, unknown> = {}) {
  return legacyIntentRow({
    execution_rail: 'delegation',
    delegation_hash: DELEGATION_HASH,
    prepared_user_op: JSON.parse(serializeUserOp(PREPARED_USER_OP)),
    ...overrides,
  })
}

const intentById = (row: Record<string, unknown>): DbRoute => [
  /FROM payment_intents\s+WHERE id/,
  () => ({ rows: [row] }),
]
const claim = (ok = true): DbRoute => [
  /SET signature[\s\S]*status = 'submitted'/,
  () => ({ rows: ok ? [{ id: PAYMENT_ID }] : [] }),
]
const confirm = (ok = true): DbRoute => [
  /SET status = 'confirmed'/,
  () => ({ rows: ok ? [{ id: PAYMENT_ID }] : [] }),
]

describe('non-custody: authentication is not authority (Red Line #3)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(paymentRoutes, { prefix: '/payments' })
  })
  afterAll(async () => { await app.close() })
  beforeEach(() => {
    mockQuery.mockReset()
    for (const m of Object.values(fiatMocks)) m.mockReset()
    for (const m of Object.values(delegationMocks)) m.mockReset()
    fiatMocks.getFiatValuesForTokenAmount.mockResolvedValue({ usd: '1.00', eur: '0.92' })
  })

  it('refuses to spend for an authenticated request with no signature', async () => {
    // Rail-independent: the shape guard in routes/payments.ts runs before any
    // intent (and therefore any rail) is even loaded.
    primeDb(AUTH)

    const res = await app.inject({
      method: 'POST',
      url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {},
    })

    expect(res.statusCode).toBe(400)
    expect(delegationMocks.submitDelegationPayment).not.toHaveBeenCalled()
  })

  it('#1986 RETIREMENT: the legacy rail refuses unconditionally — even a signature that WOULD have recovered to the delegate never spends', async () => {
    // Strongest form of "the legacy rail cannot spend": feed it the signature
    // that used to be the POSITIVE control (recovers to the delegate) and
    // confirm it is still refused.
    //
    // #2307: "before recovery is even attempted" was asserted with a
    // `recoverSigner` spy. There is no recovery to attempt — the scheme died
    // with the rail (#1986) and the helper was deleted (#1987) — so the spy
    // watched a non-export and could never fail. The refusal itself is the
    // assertion, and the structural proof that no spend path survives lives in
    // `allowance-rail-retired.test.ts` § "the spend machinery is GONE".
    primeDb(AUTH, intentById(legacyIntentRow()))

    const res = await app.inject({
      method: 'POST',
      url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: SIGNATURE },
    })

    expect(res.statusCode).toBe(410)
    expect(res.json().error).toBe(allowanceModuleRailRetired('intent').body.error)
  })

  it('DELEGATION RAIL: refuses a shape-invalid signature locally, before any chain call', async () => {
    primeDb(AUTH, intentById(delegationIntentRow()))

    const res = await app.inject({
      method: 'POST',
      url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      // Too short to pass the `/^0x[0-9a-fA-F]{100,}$/` shape check.
      payload: { signature: SHAPE_INVALID_SIGNATURE },
    })

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('Invalid signature format')
    expect(delegationMocks.submitDelegationPayment).not.toHaveBeenCalled()
  })

  it('DELEGATION RAIL: fails closed when the account rejects the signature on-chain — nothing confirmed, no local override', async () => {
    // Stand-in for validateUserOp rejecting a signature that does not recover
    // to the delegate — the bundler/EntryPoint reverts and
    // `submitDelegationPayment` throws. Haven must not fall back to any local
    // acceptance; the claim it already made must not become a confirmation.
    delegationMocks.submitDelegationPayment.mockRejectedValueOnce(
      new Error('UserOperation reverted during simulation: AA24 signature error'),
    )
    primeDb(AUTH, intentById(delegationIntentRow()), claim(true))

    const res = await app.inject({
      method: 'POST',
      url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: USEROP_SIGNATURE },
    })

    expect(res.statusCode).toBe(502)
    expect(res.json().status).toBe('failed')
    expect(delegationMocks.submitDelegationPayment).toHaveBeenCalledOnce()
    // No confirmation write ever happened:
    expect(mockQuery.mock.calls.some((c) => /SET status = 'confirmed'/.test(String(c[0])))).toBe(false)
  })

  it('DELEGATION RAIL — positive control: only releases the transfer when the account accepts the signature on-chain', async () => {
    delegationMocks.submitDelegationPayment.mockResolvedValueOnce({ txHash: TX_HASH })
    primeDb(AUTH, intentById(delegationIntentRow()), claim(true), confirm(true))

    const res = await app.inject({
      method: 'POST',
      url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: USEROP_SIGNATURE },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'confirmed', tx_hash: TX_HASH })
    // The gate that mattered was the on-chain acceptance, not the API key —
    // which is what this assertion says. (#2307 removed a trailing
    // `executeAllowanceTransfer` spy that watched a non-export.)
    expect(delegationMocks.submitDelegationPayment).toHaveBeenCalledOnce()
  })
})
