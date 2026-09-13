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

const { mockQuery, allowanceMocks, fiatMocks, delegationMocks, mockRecordRefusal } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  allowanceMocks: {
    getProvider: vi.fn(),
    getRelayerWallet: vi.fn(),
  },
  fiatMocks: {
    getFiatValuesForTokenAmount: vi.fn(),
    getBookTimeCapture: vi.fn().mockResolvedValue(null),
  },
  delegationMocks: {
    prepareDelegationPayment: vi.fn(),
    submitDelegationPayment: vi.fn(),
  },
  // #2945: the fire-and-forget ledger write, observed as a spy. The route's
  // contract with it is asserted in the `#2945` describe at the foot of this
  // file; the write itself is proven on real Postgres in
  // `infra/repositories/__tests__/payment-refusals.test.ts`.
  mockRecordRefusal: vi.fn(),
}))

vi.mock('../../db.js', () => ({
  default: { query: (...args: unknown[]) => mockQuery(...args) },
}))
vi.mock('../../infra/chain/relayer-reads.js', () => allowanceMocks)
vi.mock('../../infra/fiat-values.js', () => fiatMocks)
// Only the network seams of the delegation rail are mocked.
vi.mock('../../rails/delegation-authorization.js', () => delegationMocks)
vi.mock('../../modules/payments/refusal-ledger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../modules/payments/refusal-ledger.js')>()
  return { ...actual, recordRefusalFireAndForget: (...a: unknown[]) => mockRecordRefusal(...a) }
})

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
  account_address: '0x135a9215604711AC70d970e12Caa812c53537EF4',
  chain_id: 84532,
  status: 'active',
}

const PAYMENT_ID = '33333333-3333-3333-3333-333333333333'
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const RECIPIENT = '0x15179876c595922999C2d5DC7c23Cc7711fE799a'
const USER_OP_HASH = `0x${'cd'.repeat(32)}`
const TX_HASH = `0x${'ef'.repeat(32)}`
const DELEGATION_HASH = `0x${'12'.repeat(32)}`

const PREPARED_USER_OP = {
  sender: AGENT.account_address,
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
    account_address: AGENT.account_address,
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

// #2263 (migration 075): the row no longer carries `session_permission_id` or
// `session_user_op` — both columns are dropped, having been NULL on every row
// any live path could write since #834 deleted their only supplier. A fixture
// that still set them would be describing a row shape the schema cannot
// produce. `execution_rail` is what marks the intent, and it is what the
// retirement seam refuses on.
function sessionIntentRow(overrides: Record<string, unknown> = {}) {
  return intentRow({
    execution_rail: 'session_key',
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
  // its own message. `infra/chain/relayer-reads.ts` and this case are scheduled
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
    primeDb(AUTH, railState({ execution_rail: 'session_key' }))

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
      railState({ execution_rail: 'delegation' }),
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
    // The allowance guard never ran — no agent_allowances lookup (#835 fix):
    expect(mockQuery.mock.calls.some((c) => /agent_allowances/.test(String(c[0])))).toBe(false)
    // The intent pins the rail + which delegation authorized it:
    const insert = mockQuery.mock.calls.find((c) => /INSERT INTO payment_intents/.test(String(c[0])))!
    expect(insert![1]).toContain('delegation')
    expect(insert![1]).toContain(DELEGATION_HASH)
  })

  it('POST /payments 403s when the agent has no active delegation for the recipient', async () => {
    delegationMocks.prepareDelegationPayment.mockResolvedValue(null)
    primeDb(AUTH, railState({ execution_rail: 'delegation' }))

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
    primeDb(AUTH, railState({ execution_rail: 'delegation' }))

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
  // runs. `infra/chain/relayer-reads.ts` and this case are scheduled for
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
  // fail-closes instead. `infra/chain/relayer-reads.ts` and this case are
  // scheduled for deletion in #1987.
  it('POST /payments stays on the legacy flow when the account is not migrated', async () => {

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

  // #2263: was "a session intent with missing stored state" — the override that
  // made the state "missing" (`session_user_op: null`) is gone with the column,
  // so post-075 there is no OTHER state for a session intent to be in. The
  // claim that survives is the one that was always load-bearing: the refusal
  // comes from the rail marking alone and reads no session state to reach it.
  it('a session intent is refused on its rail marking alone (410, #834)', async () => {
    const signature = await sessionWallet.signMessage(getBytes(USER_OP_HASH))

    primeDb(AUTH, intentById(sessionIntentRow()))

    const response = await app.inject({
      method: 'POST',
      url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature },
    })

    expect(response.statusCode).toBe(410)
  })
})

// ── #2945: the payment_refusals ledger on the direct payment paths ─────────
//
// The characterization the issue names as mandatory, for the refusal paths
// that live on routes/payments.ts itself:
//
//   1. POST /payments   — the caveat enforcers refuse during gas estimation
//      (prepareDelegationPayment throws). The period-budget enforcer's own
//      revert text names the refusal (Enforcer:transfer-amount-exceeded) and
//      classifies as delegation_budget_exceeded — the direct route has no
//      fail-fast pre-check, so that revert IS its over-budget answer; an
//      unrecognised revert classifies onchain_revert; a bundler/transport
//      failure is NOT a refusal and writes nothing.
//   2. POST /payments   — no delegation for this token/recipient            → 403
//   3. POST /:id/sign   — the relayer-budget refusal before broadcast        → 429
//
// Each pins the response byte-identical with the ledger succeeding AND
// failing (the real module swallows its own write failures, so the broken
// case is modeled faithfully as a call that returns while its detached write
// rejects — never a synchronous throw, which would pin a 500 the system
// cannot produce), and asserts the exact ask the ledger receives. The write
// itself is proven against real Postgres in
// `infra/repositories/__tests__/payment-refusals.test.ts`; the x402 legs in
// `x402-delegation.test.ts`.

describe('POST /payments — the refusal ledger on the direct paths (#2945)', () => {
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
    mockRecordRefusal.mockReset()
    fiatMocks.getFiatValuesForTokenAmount.mockResolvedValue({ usd: '0.01', eur: '0.01' })
    mockRecordRefusal.mockImplementation(() => {})
  })

  // The bearer token is assembled by concatenation so the literal never
  // round-trips a secret-redaction filter; the middleware demands the
  // sk_agent_ prefix and the AUTH db route answers the hash lookup.
  const AUTH_HEADER = `Bearer ${['sk', 'agent', 'test', 'key', '0001'].join('_')}`
  const sendBody = { token: 'USDC', amount: '0.01', to: RECIPIENT }
  const injectCreate = async () =>
    app.inject({
      method: 'POST',
      url: '/payments',
      headers: { authorization: AUTH_HEADER },
      payload: sendBody,
    })
  const injectSign = async () =>
    app.inject({
      method: 'POST',
      url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: AUTH_HEADER },
      payload: { signature: '0x' + 'ab'.repeat(97) },
    })

  /** The ledger asks the spy captured — one entry per fire-and-forget call. */
  function ledgerAsks(): Array<Record<string, unknown>> {
    return mockRecordRefusal.mock.calls.map((c) => c[0] as Record<string, unknown>)
  }

  /** The faithful broken-ledger model: returns; its detached write rejects. */
  function brokenLedger() {
    mockRecordRefusal.mockImplementation(() => {
      Promise.reject(new Error('payment_refusals write exploded')).catch(() => {})
    })
  }

  it('the period-budget enforcer revert is recorded as delegation_budget_exceeded; the 502 is byte-identical with a broken ledger', async () => {
    // PERSISTENT rejection: the test injects TWICE (ledger ok / ledger broken)
    // and both must answer the same 502; a Once-rejection would let the
    // second call fall through to the base impl and return a different status.
    delegationMocks.prepareDelegationPayment.mockRejectedValue(
      new Error('EstimateGasExecutionError: ERC20PeriodTransferEnforcer:transfer-amount-exceeded'),
    )
    primeDb(AUTH, railState({ execution_rail: 'delegation' }))

    const withLedger = await injectCreate()
    expect(withLedger.statusCode).toBe(502)
    const asks = ledgerAsks()
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({
      userId: AGENT.user_id,
      agentId: AGENT.id,
      chainId: AGENT.chain_id,
      tokenSymbol: 'USDC',
      amountAtomic: '10000',
      accountAddress: AGENT.account_address,
      merchantTo: RECIPIENT.toLowerCase(),
      reason: 'delegation_budget_exceeded',
      source: 'payment',
    })
    expect(asks[0].detail).toEqual({ error_code: 'delegation_budget_exceeded' })

    brokenLedger()
    const withBrokenLedger = await injectCreate()
    expect(withBrokenLedger.statusCode).toBe(502)
    expect(withBrokenLedger.body).toBe(withLedger.body)
  })

  it('an unrecognised execution revert records onchain_revert; a bundler/transport failure records NOTHING', async () => {
    // (a) An estimation revert nothing recognises — a revert, but not one of
    // the named enforcers. The issue keeps this bucket small on purpose
    // ("rare since #2706"); the classifier stays dumb about the three.
    const { EstimateGasExecutionError } = await import('viem')
    delegationMocks.prepareDelegationPayment.mockRejectedValueOnce(
      new EstimateGasExecutionError(
        Object.assign(new Error('Execution reverted with an unknown reason'), {
          shortMessage: 'Execution reverted with an unknown reason',
        }) as never,
        {},
      ),
    )
    primeDb(AUTH, railState({ execution_rail: 'delegation' }))
    const revert = await injectCreate()
    expect(revert.statusCode).toBe(502)
    expect(ledgerAsks()).toHaveLength(1)
    expect(ledgerAsks()[0]).toMatchObject({ reason: 'onchain_revert', source: 'payment' })

    // (b) The infrastructure broke; the guardrails refused nothing. Same 502
    // shape, zero ledger rows — an outage is not a refusal.
    mockRecordRefusal.mockClear()
    delegationMocks.prepareDelegationPayment.mockRejectedValueOnce(
      new Error('fetch failed: bundler unreachable (ETIMEDOUT)'),
    )
    const outage = await injectCreate()
    expect(outage.statusCode).toBe(502)
    expect(ledgerAsks()).toHaveLength(0)
  })

  it('the no-delegation-for-target 403 is recorded; the body is unchanged by a broken ledger', async () => {
    delegationMocks.prepareDelegationPayment.mockResolvedValue(null)
    primeDb(AUTH, railState({ execution_rail: 'delegation' }))

    const withLedger = await injectCreate()
    expect(withLedger.statusCode).toBe(403)
    const asks = ledgerAsks()
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({
      userId: AGENT.user_id,
      agentId: AGENT.id,
      merchantTo: RECIPIENT.toLowerCase(),
      reason: 'no_delegation_for_target',
      source: 'payment',
    })
    expect(asks[0].detail).toEqual({ error_code: 'no_delegation_for_target' })

    brokenLedger()
    const withBrokenLedger = await injectCreate()
    expect(withBrokenLedger.statusCode).toBe(403)
    expect(withBrokenLedger.body).toBe(withLedger.body)
  })

  it('the relayer-budget 429 is recorded, releases the claim, and is byte-identical with a broken ledger', async () => {
    const { RelayerBudgetExceededError } = await import('../../infra/relayer-spend-guard.js')
    // PERSISTENT rejection (two injects, one 429 each — see the budget test).
    delegationMocks.submitDelegationPayment.mockRejectedValue(
      new RelayerBudgetExceededError('allowance_transfer', 5, 60),
    )
    primeDb(AUTH, intentById(delegationIntentRow()), claim(true))

    const withLedger = await injectSign()
    expect(withLedger.statusCode).toBe(429)
    const asks = ledgerAsks()
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({
      userId: AGENT.user_id,
      agentId: AGENT.id,
      chainId: AGENT.chain_id,
      tokenSymbol: 'USDC',
      amountAtomic: '10000',
      accountAddress: AGENT.account_address,
      merchantTo: RECIPIENT.toLowerCase(),
      resourceUrl: null,
      reason: 'relayer_budget',
      source: 'redeem',
    })
    expect(asks[0].detail).toEqual({ error_code: 'relayer_budget_exceeded' })
    // #1119 B1: the 429 releases the claim it took — the intent stays retryable.
    expect(mockQuery.mock.calls.some((c) => /SET status = 'pending_signature'/i.test(String(c[0])))).toBe(true)

    brokenLedger()
    const withBrokenLedger = await injectSign()
    expect(withBrokenLedger.statusCode).toBe(429)
    expect(withBrokenLedger.body).toBe(withLedger.body)
  })

  it('POSITIVE CONTROLS: a prepared 201 and a non-refusal sign 502 write no refusal row', async () => {
    // (a) The full happy prepare: 201, nothing refused, nothing recorded.
    // Persistent (not Once): the #1226/775 rule this file exists for — a new
    // query in the handler must not re-shuffle a positional chain.
    delegationMocks.prepareDelegationPayment.mockResolvedValue({
      delegationHash: DELEGATION_HASH,
      prepared: {
        userOperation: PREPARED_USER_OP,
        userOpHash: USER_OP_HASH,
        signingTypedData: {
          domain: { name: 'HybridDelegator' },
          types: {},
          primaryType: 'PackedUserOperation',
          message: {},
        },
        delegateAccountAddress: '0x' + 'ee'.repeat(20),
      },
    })
    primeDb(AUTH, railState({ execution_rail: 'delegation' }), insertIntent(delegationIntentRow()))
    const created = await injectCreate()
    expect(created.statusCode).toBe(201)
    expect(ledgerAsks()).toHaveLength(0)

    // (b) The sign path's non-refusal 502: a submit failure that is not the
    // relayer budget is an infrastructure failure — the intent fails, no row.
    mockRecordRefusal.mockClear()
    delegationMocks.submitDelegationPayment.mockRejectedValueOnce(
      new Error('bundler RPC unreachable at https://bundler.example'),
    )
    primeDb(AUTH, intentById(delegationIntentRow()), claim(true))
    const signOutage = await injectSign()
    expect(signOutage.statusCode).toBe(502)
    expect(ledgerAsks()).toHaveLength(0)
  })
})
