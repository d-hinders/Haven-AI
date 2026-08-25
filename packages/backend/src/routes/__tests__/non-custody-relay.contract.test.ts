import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import paymentRoutes from '../payments.js'
import { allowanceModuleRailRetired, serializeUserOp, deserializeUserOp } from '../../rails/execution-rail.js'

/**
 * Non-discretionary relay contract test (design:
 * docs/research/non-custody-verification.md; guardrail: casp-risk-guardrails.md
 * "Treat Relaying As Non-Discretionary Infrastructure" — Haven must not alter
 * recipient, amount, or token after signature).
 *
 * **Rebased onto the live delegation rail (#1986, epic #1440 slice 3).** On
 * the delegation rail there is no separate recipient/amount/token triple to
 * compare against a stamped signature — the redemption's recipient, token and
 * amount are baked into the prepared UserOperation's `callData`, which is what
 * the agent's signature actually covers (EIP-712 over the account's own typed
 * data). The non-discretionary claim on THIS rail is therefore: Haven relays
 * the EXACT prepared UserOperation it stored on the intent at authorize time —
 * the one whose hash the agent signed — never a freshly re-derived one that
 * could smuggle in a different `callData`. `POST /:id/sign` carries only a
 * signature; it cannot supply or alter recipient/amount/token, and the
 * `prepared_user_op` column is round-tripped through `deserializeUserOp`
 * (real production code, exercised for real below) rather than rebuilt.
 *
 * The legacy-rail case is kept as an ADDITIONAL, STRICTLY STRONGER assertion
 * (#1986): the retired rail's relay never runs at all — not even with the
 * exact recipient/amount/token the (would-be) signature covers.
 */

const ZERO = '0x0000000000000000000000000000000000000000'

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

vi.mock('../../db.js', () => ({ default: { query: (...args: unknown[]) => mockQuery(...args) } }))
vi.mock('../../rails/allowance-module.js', () => allowanceMocks)
vi.mock('../../infra/fiat-values.js', () => fiatMocks)
vi.mock('../../rails/delegation-authorization.js', () => delegationMocks)

const AGENT = {
  id: '11111111-1111-1111-1111-111111111111',
  user_id: '22222222-2222-2222-2222-222222222222',
  delegate_address: '0x1a642f0E3c3aF545E7AcBD38b07251B3990914F1',
  safe_address: '0x135a9215604711AC70d970e12Caa812c53537EF4',
  chain_id: 100,
  status: 'active',
}
const PAYMENT_ID = '33333333-3333-3333-3333-333333333333'
const SIGNED_RECIPIENT = '0x15179876c595922999C2d5DC7c23Cc7711fE799a'
const SIGNED_TOKEN = '0x0000000000000000000000000000000000000000'
const SIGNED_AMOUNT = '1000000000000000000'
const SIGNATURE = `0x${'ab'.repeat(65)}`
const USEROP_SIGNATURE = `0x${'ab'.repeat(97)}`
const TX_HASH = `0x${'cd'.repeat(32)}`
const DELEGATION_HASH = `0x${'12'.repeat(32)}`

// The recipient/amount/token the agent actually signed for — baked into
// callData on the delegation rail, which the relay must forward UNCHANGED.
const PREPARED_USER_OP = {
  sender: AGENT.safe_address,
  nonce: 42n,
  // Opaque bytes standing in for the calldata that encodes SIGNED_TOKEN /
  // SIGNED_RECIPIENT / SIGNED_AMOUNT — what matters for this proof is that
  // this EXACT object (identity, not a reconstruction) reaches the relay.
  callData: '0xdeadbeef' + SIGNED_RECIPIENT.slice(2) + BigInt(SIGNED_AMOUNT).toString(16),
}

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

function legacySignedIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    agent_id: AGENT.id,
    user_id: AGENT.user_id,
    safe_address: AGENT.safe_address,
    chain_id: AGENT.chain_id,
    token_symbol: 'xDAI',
    token_address: SIGNED_TOKEN,
    to_address: SIGNED_RECIPIENT,
    amount_raw: SIGNED_AMOUNT,
    amount_human: '1',
    delegate_address: AGENT.delegate_address,
    allowance_nonce: 7,
    sign_hash: `0x${'11'.repeat(32)}`,
    status: 'pending_signature',
    expires_at: '2099-01-01T00:00:00.000Z',
    execution_rail: null, // the retired population (#1986)
    ...overrides,
  }
}

// Return type widened explicitly: the base fixture's inferred literal type
// does not carry the delegation-only columns this helper adds, so reading
// `prepared_user_op` back off it (the deep-equal below depends on that) is
// a type error without this.
function delegationSignedIntent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return legacySignedIntent({
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

describe('non-custody: the relay is non-discretionary', () => {
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
    fiatMocks.getFiatValuesForTokenAmount.mockResolvedValue({ usd: '1.00', eur: '0.92' })
  })

  it('#1986 RETIREMENT: the legacy rail relays nothing — even the exact signed recipient/amount/token never reaches executeAllowanceTransfer', async () => {
    allowanceMocks.recoverSigner.mockReturnValue(AGENT.delegate_address)
    primeDb(AUTH, intentById(legacySignedIntent()))

    const res = await app.inject({
      method: 'POST',
      url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: SIGNATURE },
    })

    expect(res.statusCode).toBe(410)
    expect(res.json().error).toBe(allowanceModuleRailRetired('intent').body.error)
    expect(allowanceMocks.executeAllowanceTransfer).not.toHaveBeenCalled()
  })

  it('DELEGATION RAIL: relays the EXACT stored prepared UserOperation and signature — no substitution, no reconstruction', async () => {
    delegationMocks.submitDelegationPayment.mockResolvedValueOnce({ txHash: TX_HASH })
    primeDb(AUTH, intentById(delegationSignedIntent()), claim(true), confirm(true))

    const res = await app.inject({
      method: 'POST',
      url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: USEROP_SIGNATURE },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'confirmed', tx_hash: TX_HASH })
    expect(delegationMocks.submitDelegationPayment).toHaveBeenCalledOnce()
    const [, forwardedUserOp, forwardedSignature] = delegationMocks.submitDelegationPayment.mock.calls[0]
    // Deep-equal against the STORED prepared op (round-tripped through the
    // real deserializeUserOp), not a freshly recomputed one:
    expect(forwardedUserOp).toEqual(deserializeUserOp(delegationSignedIntent().prepared_user_op))
    expect(String(forwardedUserOp.callData).toLowerCase()).toContain(SIGNED_RECIPIENT.slice(2).toLowerCase())
    // The signature is stamped in unchanged:
    expect(forwardedSignature).toBe(USEROP_SIGNATURE)
    // No Haven substitution via the legacy path either:
    expect(allowanceMocks.executeAllowanceTransfer).not.toHaveBeenCalled()
  })
})
