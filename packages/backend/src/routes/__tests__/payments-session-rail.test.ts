/**
 * Execution-rail contract tests (#745 origin, retirement #834, one-gate #993).
 *
 * - LEGACY intents (execution_rail null) behave exactly as before the session
 *   rail existed: raw-ECDSA verification + executeAllowanceTransfer.
 * - SESSION accounts/intents are RETIRED: 410 with ZERO writes on every
 *   surface — no intent row, no audit side effect, no status flip.
 *
 * Signature recovery and UserOp (de)serialization run REAL code, with a real
 * EIP-191 signature, so a scheme regression fails these tests.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { Wallet, getBytes } from 'ethers'

const { mockQuery, allowanceMocks, fiatMocks, delegationMocks } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  allowanceMocks: {
    getTokenAllowance: vi.fn(),
    getProvider: vi.fn(),
    getRelayerWallet: vi.fn(),
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

vi.mock('../../db.js', () => ({
  default: { query: (...args: unknown[]) => mockQuery(...args) },
}))
vi.mock('../../rails/allowance-module.js', () => allowanceMocks)
vi.mock('../../infra/fiat-values.js', () => fiatMocks)
// Only the network seams of the delegation rail are mocked.
vi.mock('../../rails/delegation-authorization.js', () => delegationMocks)

const paymentRoutes = (await import('../payments.js')).default
const { serializeUserOp, allowanceModuleRailRetired, sessionRailRetired } = await import(
  '../../rails/execution-rail.js'
)

// The session (delegate) key — a throwaway test key, never a real one.
const sessionWallet = new Wallet('0x' + '22'.repeat(32))

const AGENT = {
  id: '11111111-1111-1111-1111-111111111111',
  user_id: '22222222-2222-2222-2222-222222222222',
  name: 'Payment Agent',
  delegate_address: sessionWallet.address,
  safe_address: '0x135a9215604711AC70d970e12Caa812c53537EF4',
  chain_id: 84532,
  status: 'active',
}

const PAYMENT_ID = '33333333-3333-3333-3333-333333333333'
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const RECIPIENT = '0x15179876c595922999C2d5DC7c23Cc7711fE799a'
const USER_OP_HASH = `0x${'cd'.repeat(32)}`
const PERMISSION_ID = `0x${'ab'.repeat(32)}`
const TX_HASH = `0x${'ef'.repeat(32)}`
const DELEGATION_HASH = `0x${'12'.repeat(32)}`

const PREPARED_USER_OP = {
  sender: AGENT.safe_address,
  nonce: 123456789012345678901234567890n,
  callData: '0xdeadbeef',
  maxFeePerGas: 1_000_000n,
  verificationGasLimit: 900_000n,
}

function authRow() {
  return { rows: [AGENT] }
}

function intentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    agent_id: AGENT.id,
    user_id: AGENT.user_id,
    safe_address: AGENT.safe_address,
    chain_id: AGENT.chain_id,
    token_symbol: 'USDC',
    token_address: USDC,
    to_address: RECIPIENT.toLowerCase(),
    amount_raw: '10000',
    amount_human: '0.01',
    delegate_address: AGENT.delegate_address,
    allowance_nonce: 7,
    sign_hash: USER_OP_HASH,
    signature: null,
    tx_hash: null,
    status: 'pending_signature',
    error_message: null,
    created_at: '2026-07-02T10:00:00.000Z',
    signed_at: null,
    submitted_at: null,
    confirmed_at: null,
    expires_at: '2099-01-01T00:00:00.000Z',
    execution_rail: null,
    session_permission_id: null,
    session_user_op: null,
    ...overrides,
  }
}

function delegationIntentRow(overrides: Record<string, unknown> = {}) {
  return intentRow({
    execution_rail: 'delegation',
    delegation_hash: DELEGATION_HASH,
    prepared_user_op: JSON.parse(serializeUserOp(PREPARED_USER_OP)),
    ...overrides,
  })
}

function sessionIntentRow(overrides: Record<string, unknown> = {}) {
  return intentRow({
    execution_rail: 'session_key',
    session_permission_id: PERMISSION_ID,
    // pg parses JSONB on read — simulate by parsing WITHOUT the bigint reviver.
    session_user_op: JSON.parse(serializeUserOp(PREPARED_USER_OP)),
    ...overrides,
  })
}

// ── Content-dispatch DB stub (#1226) ─────────────────────────────────────────
//
// Routes match on SQL FRAGMENTS, first hit wins, anything unmatched returns
// zero rows. This replaces the positional mock-chains that re-shuffled
// whenever a handler gained a query (#775) — what the database DOES with
// these statements is proven in the repository suites on the real harness
// (payment-intents.test.ts, epic #1219); these tests own only the handler:
// status codes, refusals, response shapes, and which writes were requested.

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

const AUTH: DbRoute = [/api_key_hash = \$1/, () => authRow()]

/** loadExecutionRailState (POST /payments' rail resolution). */
const railState = (row: Record<string, unknown> | null): DbRoute => [
  /FROM agents a/,
  () => ({ rows: row ? [row] : [] }),
]

/** hasTokenAllowanceConfigured (non-delegation rails' token-config gate). */
const allowanceConfigured = (configured: boolean): DbRoute => [
  /LOWER\(token_address\) = LOWER\(\$2\)/,
  () => ({ rows: configured ? [{ allowance_amount: '1000' }] : [] }),
]

/** findIntentForAgent (POST /:id/sign's intent load). */
const intentById = (row: Record<string, unknown> | null): DbRoute => [
  /FROM payment_intents\s+WHERE id/,
  () => ({ rows: row ? [row] : [] }),
]

/** claimIntentForSubmission — the CAS the double-spend guard rests on. */
const claim = (ok: boolean): DbRoute => [
  /SET signature[\s\S]*status = 'submitted'/,
  () => ({ rows: ok ? [{ id: PAYMENT_ID }] : [] }),
]

/** confirmSubmittedIntent. */
const confirm = (ok = true): DbRoute => [
  /SET status = 'confirmed'/,
  () => ({ rows: ok ? [{ id: PAYMENT_ID }] : [] }),
]

/** findIntentEvidenceSource — the post-confirm evidence-recorder lookup. */
const evidenceLookup: DbRoute = [/AS kind,/, () => ({ rows: [] })]

/** INSERT INTO payment_intents (legacy or delegation-rail create). */
const insertIntent = (row: Record<string, unknown>): DbRoute => [
  /INSERT INTO payment_intents/,
  () => ({ rows: [row] }),
]

describe('POST /payments/:id/sign — execution-rail split (#745)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(paymentRoutes, { prefix: '/payments' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockQuery.mockReset()
    for (const mock of Object.values(allowanceMocks)) mock.mockReset()
    for (const mock of Object.values(fiatMocks)) mock.mockReset()
    for (const mock of Object.values(delegationMocks)) mock.mockReset()
  })

  // #1986 (epic #1440 slice 3): `intentRow()` is the legacy shape this case's
  // name describes — `execution_rail: null` — and that shape is now itself
  // retired, on the SAME seam as the session-rail tombstone below but with
  // its own message. `rails/allowance-module.ts` and this case are scheduled
  // for deletion in #1987.
  it('CHARACTERIZATION: legacy intents never touch the session rail', async () => {
    fiatMocks.getFiatValuesForTokenAmount.mockResolvedValue({ usd: '0.01', eur: '0.01' })

    primeDb(AUTH, intentById(intentRow()), claim(true), confirm(), evidenceLookup)

    const response = await app.inject({
      method: 'POST',
      url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: `0x${'ab'.repeat(65)}` },
    })

    expect(response.statusCode).toBe(410)
    expect(response.json().error).toBe(allowanceModuleRailRetired('intent').body.error)
    // Still never touches the session rail — and the two tombstones produce
    // DISTINCT bodies, so a caller can tell which retirement it hit:
    expect(response.json().error).not.toBe(sessionRailRetired('intent').body.error)
    // Nothing verified, claimed, or executed:
    expect(mockQuery.mock.calls.some((c) => /SET signature/.test(String(c[0])))).toBe(false)
  })

  it('POST /:id/sign REFUSES a session intent — the rail is retired (#834)', async () => {
    const signature = await sessionWallet.signMessage(getBytes(USER_OP_HASH))
    primeDb(AUTH, intentById(sessionIntentRow()))

    const response = await app.inject({
      method: 'POST',
      url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature },
    })

    expect(response.statusCode).toBe(410)
    expect(response.json().error).toMatch(/session rail is retired/)
    // Nothing verified, claimed, or executed:
    expect(mockQuery.mock.calls.some((c) => /SET signature/.test(String(c[0])))).toBe(false)
    // #993 hardening of the same contract: ZERO writes of any kind — the 410
    // must not leave an intent row, audit row, or status flip behind.
    expect(mockQuery.mock.calls.some((c) => /INSERT|UPDATE|DELETE/i.test(String(c[0])))).toBe(false)
  })

  it('POST /payments REFUSES a session-rail account — the rail is retired (#834)', async () => {
    // The retired-session gate fires BEFORE the token-config guard runs, so
    // only the rail-state read is ever consumed here.
    primeDb(AUTH, railState({ execution_rail: 'session_key', session_permission_id: PERMISSION_ID }))

    const response = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { token: 'USDC', amount: '0.01', to: RECIPIENT },
    })

    expect(response.statusCode).toBe(410)
    expect(response.json().error).toMatch(/delegation rail/)
    // Fail-closed: no session machinery invoked, nothing written:
    expect(mockQuery.mock.calls.some((c) => /INSERT INTO payment_intents/.test(String(c[0])))).toBe(false)
    // #993: ZERO writes of any kind on the 410 path.
    expect(mockQuery.mock.calls.some((c) => /INSERT|UPDATE|DELETE/i.test(String(c[0])))).toBe(false)
  })

  it('POST /payments on the delegation rail: prepares, pins the delegation, ships typed data — WITHOUT an allowance row (#829, #835)', async () => {
    delegationMocks.prepareDelegationPayment.mockResolvedValue({
      delegationHash: DELEGATION_HASH,
      prepared: {
        userOperation: PREPARED_USER_OP,
        userOpHash: USER_OP_HASH,
        signingTypedData: { domain: { name: 'HybridDeleGator' }, types: {}, primaryType: 'PackedUserOperation', message: {} },
        delegateAccountAddress: '0x' + 'ee'.repeat(20),
      },
    })
    // A delegation-rail agent has NO agent_allowances row — its authority is the
    // signed delegation. The route must NOT run the token-config guard here:
    // it 403'd a fully-configured delegation agent live until the guard was
    // scoped to non-delegation rails (#835). So the chain is auth → rail state
    // → INSERT, with no allowance lookup queued in between.
    primeDb(
      AUTH,
      railState({ execution_rail: 'delegation', session_permission_id: null }),
      insertIntent(delegationIntentRow()),
    )

    const response = await app.inject({
      method: 'POST', url: '/payments',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { token: 'USDC', amount: '0.01', to: RECIPIENT },
    })

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.sign_data.signature_scheme).toBe('eip712_userop')
    // The account validates typed data, not the bare hash — ship it:
    expect(body.sign_data.typed_data.domain.name).toBe('HybridDeleGator')
    // Neither other rail is touched:
    expect(allowanceMocks.getTokenAllowance).not.toHaveBeenCalled()
    // The allowance guard never ran — no agent_allowances lookup (#835 fix):
    expect(mockQuery.mock.calls.some((c) => /agent_allowances/.test(String(c[0])))).toBe(false)
    // The intent pins the rail + which delegation authorized it:
    const insert = mockQuery.mock.calls.find((c) => /INSERT INTO payment_intents/.test(String(c[0])))!
    expect(insert![1]).toContain('delegation')
    expect(insert![1]).toContain(DELEGATION_HASH)
  })

  it('POST /payments 403s when the agent has no active delegation for the recipient', async () => {
    delegationMocks.prepareDelegationPayment.mockResolvedValue(null)
    primeDb(AUTH, railState({ execution_rail: 'delegation', session_permission_id: null }))

    const response = await app.inject({
      method: 'POST', url: '/payments',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { token: 'USDC', amount: '0.01', to: RECIPIENT },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json().error).toMatch(/no active budget delegation/)
    // Nothing written:
    expect(mockQuery.mock.calls.some((c) => /INSERT INTO payment_intents/.test(String(c[0])))).toBe(false)
  })

  it('POST /payments: caveat rejection fails BEFORE any write, credential redacted (#829)', async () => {
    delegationMocks.prepareDelegationPayment.mockRejectedValueOnce(
      new Error('ERC20PeriodTransferEnforcer:transfer-amount-exceeded at https://api.pimlico.io/v2?apikey=pim_SECRET'),
    )
    primeDb(AUTH, railState({ execution_rail: 'delegation', session_permission_id: null }))

    const response = await app.inject({
      method: 'POST', url: '/payments',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { token: 'USDC', amount: '0.01', to: RECIPIENT },
    })
    expect(response.statusCode).toBe(502)
    expect(response.body).toContain('transfer-amount-exceeded')
    expect(response.body).not.toContain('pim_SECRET')
    expect(response.body).toContain('apikey=REDACTED')
    expect(mockQuery.mock.calls.some((c) => /INSERT INTO payment_intents/.test(String(c[0])))).toBe(false)
  })

  it('POST /:id/sign on a delegation intent: replays the prepared op, never touches other rails (#829)', async () => {
    delegationMocks.submitDelegationPayment.mockResolvedValue({ txHash: TX_HASH })
    fiatMocks.getFiatValuesForTokenAmount.mockResolvedValue({ usd: '0.01', eur: '0.01' })
    primeDb(AUTH, intentById(delegationIntentRow()), claim(true), confirm(), evidenceLookup)

    const response = await app.inject({
      method: 'POST', url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: '0x' + 'ab'.repeat(97) }, // EIP-712 sig shape
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ status: 'confirmed', tx_hash: TX_HASH })
    expect(delegationMocks.submitDelegationPayment).toHaveBeenCalledOnce()
    // The legacy recover was NOT used — the chain validates this scheme:
  })

  it('POST /:id/sign fails closed when a delegation intent lost its prepared op', async () => {
    primeDb(AUTH, intentById(delegationIntentRow({ prepared_user_op: null })), claim(true), confirm())

    const response = await app.inject({
      method: 'POST', url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: '0x' + 'ab'.repeat(97) },
    })
    expect(response.statusCode).toBe(502)
    expect(delegationMocks.submitDelegationPayment).not.toHaveBeenCalled()
  })

  // #1986 (epic #1440 slice 3): `railState(null)` is the "no Safe row / no
  // rail marking" shape this case's name calls "NON-delegation" — that shape
  // now resolves to `retired_allowance`, and the account gate refuses BEFORE
  // the token-config guard (`allowanceConfigured`) this case named ever
  // runs. `rails/allowance-module.ts` and this case are scheduled for
  // deletion in #1987.
  it('POST /payments still 403s a NON-delegation agent with no allowance row (guard preserved, #835)', async () => {
    // The #835 fix scopes the token-config guard OUT of the delegation rail —
    // it must remain in force everywhere else. A legacy agent (no rail state)
    // with no agent_allowances row is still rejected before anything executes.
    primeDb(AUTH, railState(null), allowanceConfigured(false))

    const response = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { token: 'USDC', amount: '0.01', to: RECIPIENT },
    })

    expect(response.statusCode).toBe(410)
    expect(response.json().error).toBe(allowanceModuleRailRetired('account').body.error)
    // The token-config guard never ran — the account gate refused first:
    expect(mockQuery.mock.calls.some((c) => /LOWER\(token_address\) = LOWER\(\$2\)/.test(String(c[0])))).toBe(false)
    // Nothing was written:
    expect(mockQuery.mock.calls.some((c) => /INSERT INTO payment_intents/.test(String(c[0])))).toBe(false)
  })

  // #1986: this case's name IS the retired rail — "the account is not
  // migrated" (no rail state) used to mean "fall through to legacy", and now
  // fail-closes instead. `rails/allowance-module.ts` and this case are
  // scheduled for deletion in #1987.
  it('POST /payments stays on the legacy flow when the account is not migrated', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValue({ nonce: 7 })

    // No rail state → retired (fail-closed).
    primeDb(AUTH, railState(null), allowanceConfigured(true), insertIntent(intentRow()))

    const response = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { token: 'USDC', amount: '0.01', to: RECIPIENT },
    })

    expect(response.statusCode).toBe(410)
    expect(response.json().error).toBe(allowanceModuleRailRetired('account').body.error)
    expect(mockQuery.mock.calls.some((c) => /INSERT INTO payment_intents/.test(String(c[0])))).toBe(false)
  })

  it('a session intent with missing stored state is refused the same way (410, #834)', async () => {
    const signature = await sessionWallet.signMessage(getBytes(USER_OP_HASH))

    primeDb(AUTH, intentById(sessionIntentRow({ session_user_op: null })))

    const response = await app.inject({
      method: 'POST',
      url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature },
    })

    expect(response.statusCode).toBe(410)
  })
})
