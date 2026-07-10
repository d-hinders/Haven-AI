/**
 * #745 characterization tests for the execution-rail split in POST /:id/sign.
 *
 * - LEGACY intents (execution_rail null) must behave exactly as before the
 *   session rail existed: raw-ECDSA verification, executeAllowanceTransfer,
 *   and the session rail never touched.
 * - SESSION intents (execution_rail = 'session_key') verify EIP-191 and
 *   submit the stored UserOperation via the session rail; the AllowanceModule
 *   path is never touched.
 *
 * Only the network-touching factory (getSessionRailFor) is mocked — signature
 * recovery and UserOp (de)serialization run REAL code, with a real EIP-191
 * signature, so a scheme regression fails these tests.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { Wallet, getBytes } from 'ethers'

const { mockQuery, allowanceMocks, fiatMocks, sessionRailMocks, delegationMocks } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  allowanceMocks: {
    getTokenAllowance: vi.fn(),
    getLatestBlockTimeSec: vi.fn(),
    computeEffectiveAllowance: vi.fn(),
    generateTransferHash: vi.fn(),
    recoverSigner: vi.fn(),
    executeAllowanceTransfer: vi.fn(),
    getProvider: vi.fn(),
    getRelayerWallet: vi.fn(),
  },
  fiatMocks: {
    getFiatValuesForTokenAmount: vi.fn(),
    getBookTimeSekValue: vi.fn().mockResolvedValue(null),
  },
  sessionRailMocks: {
    getSessionRailFor: vi.fn(),
  },
  delegationMocks: {
    prepareDelegationPayment: vi.fn(),
    submitDelegationPayment: vi.fn(),
  },
}))

vi.mock('../../db.js', () => ({
  default: { query: (...args: unknown[]) => mockQuery(...args) },
}))
vi.mock('../../lib/allowance-module.js', () => allowanceMocks)
vi.mock('../../lib/fiat-values.js', () => fiatMocks)
// Replace ONLY the network factory; every pure function stays real.
vi.mock('../../lib/execution-rail.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/execution-rail.js')>()
  return { ...actual, getSessionRailFor: sessionRailMocks.getSessionRailFor }
})
// Only the network seams of the delegation rail are mocked.
vi.mock('../../lib/delegation-authorization.js', () => delegationMocks)

const paymentRoutes = (await import('../payments.js')).default
const { serializeUserOp } = await import('../../lib/execution-rail.js')

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
    sessionRailMocks.getSessionRailFor.mockReset()
    for (const mock of Object.values(delegationMocks)) mock.mockReset()
  })

  it('CHARACTERIZATION: legacy intents never touch the session rail', async () => {
    allowanceMocks.recoverSigner.mockReturnValueOnce(AGENT.delegate_address)
    allowanceMocks.executeAllowanceTransfer.mockResolvedValueOnce({ txHash: TX_HASH })
    fiatMocks.getFiatValuesForTokenAmount.mockResolvedValueOnce({ usd: '0.01', eur: '0.01' })

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [intentRow()] }) // execution_rail: null
      .mockResolvedValueOnce({ rows: [{ id: PAYMENT_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: PAYMENT_ID }] })
      .mockResolvedValueOnce({ rows: [] })

    const response = await app.inject({
      method: 'POST',
      url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: `0x${'ab'.repeat(65)}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ status: 'confirmed', tx_hash: TX_HASH })
    // The legacy rail, exactly as before the session rail existed:
    expect(allowanceMocks.recoverSigner).toHaveBeenCalledWith(
      USER_OP_HASH,
      `0x${'ab'.repeat(65)}`,
    )
    expect(allowanceMocks.executeAllowanceTransfer).toHaveBeenCalledOnce()
    expect(sessionRailMocks.getSessionRailFor).not.toHaveBeenCalled()
  })

  it('session intents verify EIP-191 and submit the stored UserOperation', async () => {
    const submitSessionTransfer = vi.fn().mockResolvedValue({
      txHash: TX_HASH,
      userOpHash: USER_OP_HASH,
      actualGasUsed: 100_000n,
      actualGasCost: 1_000_000n,
    })
    sessionRailMocks.getSessionRailFor.mockResolvedValueOnce({ submitSessionTransfer })
    fiatMocks.getFiatValuesForTokenAmount.mockResolvedValueOnce({ usd: '0.01', eur: '0.01' })

    // A REAL EIP-191 signature — what signUserOpHashForSession (#741) produces.
    const signature = await sessionWallet.signMessage(getBytes(USER_OP_HASH))

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [sessionIntentRow()] })
      .mockResolvedValueOnce({ rows: [{ id: PAYMENT_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: PAYMENT_ID }] })
      .mockResolvedValueOnce({ rows: [] })

    const response = await app.inject({
      method: 'POST',
      url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ status: 'confirmed', tx_hash: TX_HASH })
    // The AllowanceModule path is never touched:
    expect(allowanceMocks.executeAllowanceTransfer).not.toHaveBeenCalled()
    expect(allowanceMocks.recoverSigner).not.toHaveBeenCalled()
    // The EXACT prepared UserOperation is replayed, bigints revived, with the
    // permissionId pinned at authorize time:
    expect(sessionRailMocks.getSessionRailFor).toHaveBeenCalledWith(
      AGENT.safe_address,
      AGENT.chain_id,
    )
    expect(submitSessionTransfer).toHaveBeenCalledWith(
      { userOperation: PREPARED_USER_OP, userOpHash: USER_OP_HASH },
      PERMISSION_ID,
      signature,
    )
  })

  it('rejects a raw-ECDSA signature on a session intent (the #731 footgun, fail-closed)', async () => {
    // The WRONG scheme: raw ECDSA over the hash — valid for the AllowanceModule
    // rail, but recovers a different address under EIP-191.
    const rawSignature = sessionWallet.signingKey.sign(USER_OP_HASH).serialized

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [sessionIntentRow()] })

    const response = await app.inject({
      method: 'POST',
      url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: rawSignature },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: 'Signature does not match delegate address' })
    expect(sessionRailMocks.getSessionRailFor).not.toHaveBeenCalled()
    expect(allowanceMocks.executeAllowanceTransfer).not.toHaveBeenCalled()
  })

  it('POST /payments prepares a session UserOp for a migrated account', async () => {
    const prepareSessionTransfer = vi.fn().mockResolvedValue({
      userOperation: PREPARED_USER_OP,
      userOpHash: USER_OP_HASH,
    })
    sessionRailMocks.getSessionRailFor.mockResolvedValueOnce({ prepareSessionTransfer })

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({
        rows: [{ execution_rail: 'session_key', session_permission_id: PERMISSION_ID }],
      }) // rail resolved before the token-config guard (#835)
      .mockResolvedValueOnce({ rows: [{ allowance_amount: '1000' }] }) // token-config guard
      .mockResolvedValueOnce({ rows: [] }) // schedule-window lookup (#769) — no schedule
      .mockResolvedValueOnce({ rows: [sessionIntentRow()] }) // INSERT RETURNING *

    const response = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { token: 'USDC', amount: '0.01', to: RECIPIENT },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      payment_id: PAYMENT_ID,
      status: 'pending_signature',
      sign_data: { hash: USER_OP_HASH, signature_scheme: 'eip191_userop' },
    })
    // The AllowanceModule flow never runs on this rail:
    expect(allowanceMocks.getTokenAllowance).not.toHaveBeenCalled()
    expect(allowanceMocks.generateTransferHash).not.toHaveBeenCalled()
    // The intent INSERT pins the rail, the permissionId, and the prepared UserOp:
    const insert = mockQuery.mock.calls.find((c) =>
      /INSERT INTO payment_intents/.test(c[0] as string),
    )
    expect(insert).toBeDefined()
    expect(insert![0]).toContain('execution_rail')
    expect(insert![1]).toContain('session_key')
    expect(insert![1]).toContain(PERMISSION_ID)
  })

  it('never leaks the bundler API key in session error details (found live, #738)', async () => {
    const prepareSessionTransfer = vi.fn().mockRejectedValue(
      new Error(
        'Invalid parameters.\nURL: https://api.pimlico.io/v2/84532/rpc?apikey=pim_SUPERSECRET\nDetails: sponsorshipPolicy not active',
      ),
    )
    sessionRailMocks.getSessionRailFor.mockResolvedValueOnce({ prepareSessionTransfer })

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({
        rows: [{ execution_rail: 'session_key', session_permission_id: PERMISSION_ID }],
      })
      .mockResolvedValueOnce({ rows: [{ allowance_amount: '1000' }] })
      .mockResolvedValueOnce({ rows: [] }) // schedule-window lookup (#769) — no schedule

    const response = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { token: 'USDC', amount: '0.01', to: RECIPIENT },
    })

    expect(response.statusCode).toBe(502)
    expect(response.body).not.toContain('pim_SUPERSECRET')
    expect(response.body).toContain('apikey=REDACTED')
    expect(response.body).toContain('sponsorshipPolicy not active')
  })

  it('POST /payments on the delegation rail: prepares, pins the delegation, ships typed data — WITHOUT an allowance row (#829, #835)', async () => {
    delegationMocks.prepareDelegationPayment.mockResolvedValueOnce({
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
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [{ execution_rail: 'delegation', session_permission_id: null }] })
      .mockResolvedValueOnce({ rows: [delegationIntentRow()] })

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
    expect(sessionRailMocks.getSessionRailFor).not.toHaveBeenCalled()
    expect(allowanceMocks.getTokenAllowance).not.toHaveBeenCalled()
    // The allowance guard never ran — no agent_allowances lookup (#835 fix):
    expect(mockQuery.mock.calls.some((c) => /agent_allowances/.test(String(c[0])))).toBe(false)
    // The intent pins the rail + which delegation authorized it:
    const insert = mockQuery.mock.calls.find((c) => /INSERT INTO payment_intents/.test(String(c[0])))!
    expect(insert![1]).toContain('delegation')
    expect(insert![1]).toContain(DELEGATION_HASH)
  })

  it('POST /payments 403s when the agent has no active delegation for the recipient', async () => {
    delegationMocks.prepareDelegationPayment.mockResolvedValueOnce(null)
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [{ execution_rail: 'delegation', session_permission_id: null }] })

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
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [{ execution_rail: 'delegation', session_permission_id: null }] })

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
    delegationMocks.submitDelegationPayment.mockResolvedValueOnce({ txHash: TX_HASH })
    fiatMocks.getFiatValuesForTokenAmount.mockResolvedValueOnce({ usd: '0.01', eur: '0.01' })
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [delegationIntentRow()] })
      .mockResolvedValueOnce({ rows: [{ id: PAYMENT_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: PAYMENT_ID }] })
      .mockResolvedValueOnce({ rows: [] })

    const response = await app.inject({
      method: 'POST', url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: '0x' + 'ab'.repeat(97) }, // EIP-712 sig shape
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ status: 'confirmed', tx_hash: TX_HASH })
    expect(delegationMocks.submitDelegationPayment).toHaveBeenCalledOnce()
    expect(allowanceMocks.executeAllowanceTransfer).not.toHaveBeenCalled()
    expect(sessionRailMocks.getSessionRailFor).not.toHaveBeenCalled()
    // The legacy recover was NOT used — the chain validates this scheme:
    expect(allowanceMocks.recoverSigner).not.toHaveBeenCalled()
  })

  it('POST /:id/sign fails closed when a delegation intent lost its prepared op', async () => {
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [delegationIntentRow({ prepared_user_op: null })] })
      .mockResolvedValueOnce({ rows: [{ id: PAYMENT_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: PAYMENT_ID }] })

    const response = await app.inject({
      method: 'POST', url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature: '0x' + 'ab'.repeat(97) },
    })
    expect(response.statusCode).toBe(502)
    expect(delegationMocks.submitDelegationPayment).not.toHaveBeenCalled()
  })

  it('POST /payments still 403s a NON-delegation agent with no allowance row (guard preserved, #835)', async () => {
    // The #835 fix scopes the token-config guard OUT of the delegation rail —
    // it must remain in force everywhere else. A legacy agent (no rail state)
    // with no agent_allowances row is still rejected before anything executes.
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] }) // rail state: none → legacy
      .mockResolvedValueOnce({ rows: [] }) // token-config guard: no allowance row

    const response = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { token: 'USDC', amount: '0.01', to: RECIPIENT },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().error).toMatch(/not configured for USDC/)
    // Nothing was written:
    expect(mockQuery.mock.calls.some((c) => /INSERT INTO payment_intents/.test(String(c[0])))).toBe(false)
  })

  it('POST /payments stays on the legacy flow when the account is not migrated', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 7 })
    allowanceMocks.getLatestBlockTimeSec.mockResolvedValueOnce(1_900_000_000)
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 1_000_000n })
    allowanceMocks.generateTransferHash.mockResolvedValueOnce(USER_OP_HASH)

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] }) // no rail state → legacy (fail-closed)
      .mockResolvedValueOnce({ rows: [{ allowance_amount: '1000' }] })
      .mockResolvedValueOnce({ rows: [intentRow()] })

    const response = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { token: 'USDC', amount: '0.01', to: RECIPIENT },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json().sign_data.signature_scheme).toBeUndefined()
    expect(sessionRailMocks.getSessionRailFor).not.toHaveBeenCalled()
    expect(allowanceMocks.generateTransferHash).toHaveBeenCalledOnce()
  })

  it('schedule rollover (#769): prepares on the CURRENT period session and flips the record after success', async () => {
    // A real schedule built with the production builders — the route recomputes
    // it from the mocked DB rows, so the permissionIds must match bit-for-bit.
    const { buildSessionSchedule } = await import('../../lib/session-schedule.js')
    const RESET_MIN = 60
    const FROM_PERIOD = 100
    const schedule = buildSessionSchedule(
      AGENT.id,
      {
        sessionKeyAddress: AGENT.delegate_address as `0x${string}`,
        usdcAddress: USDC as `0x${string}`,
        allowedRecipient: RECIPIENT as `0x${string}`,
        budgetAtomic: 5_000_000n,
        chainId: BigInt(AGENT.chain_id),
      },
      RESET_MIN,
      FROM_PERIOD,
      3,
    )
    const recordedId = schedule.entries[0].permissionId // period 100 on record
    const expectedId = schedule.entries[1].permissionId // now is period 101
    vi.useFakeTimers({ toFake: ['Date'] }) // only Date — Fastify needs real timers
    vi.setSystemTime(new Date((FROM_PERIOD + 1) * RESET_MIN * 60 * 1000 + 90_000))

    const prepareSessionTransfer = vi.fn().mockResolvedValue({
      userOperation: PREPARED_USER_OP,
      userOpHash: USER_OP_HASH,
    })
    sessionRailMocks.getSessionRailFor.mockResolvedValueOnce({ prepareSessionTransfer })

    // Pattern-matched (#775): the schedule wiring adds queries mid-flow.
    mockQuery.mockImplementation((sql: unknown) => {
      const s = String(sql)
      if (/api_key_hash/.test(s)) return Promise.resolve(authRow())
      if (/session_schedule_from_period/.test(s)) {
        return Promise.resolve({
          rows: [{
            session_schedule_from_period: FROM_PERIOD,
            session_schedule_period_count: 3,
            session_permission_id: recordedId,
            delegate_address: AGENT.delegate_address,
            reset_period_min: RESET_MIN,
          }],
        })
      }
      if (/FROM agent_recipients/.test(s)) {
        return Promise.resolve({
          rows: [{
            recipient_address: RECIPIENT.toLowerCase(),
            token_address: USDC,
            label: null,
            budget_amount: '5000000',
            allowance_amount: '5000000',
          }],
        })
      }
      if (/us\.execution_rail/.test(s)) {
        return Promise.resolve({
          rows: [{ execution_rail: 'session_key', session_permission_id: recordedId }],
        })
      }
      if (/INSERT INTO payment_intents/.test(s)) {
        return Promise.resolve({ rows: [sessionIntentRow({ session_permission_id: expectedId })] })
      }
      if (/UPDATE agents/.test(s)) return Promise.resolve({ rows: [{ id: AGENT.id }] })
      if (/FROM agent_allowances/.test(s)) {
        return Promise.resolve({ rows: [{ allowance_amount: '5000000' }] })
      }
      return Promise.resolve(authRow())
    })

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/payments',
        headers: { authorization: 'Bearer sk_agent_test' },
        payload: { token: 'USDC', amount: '0.01', to: RECIPIENT },
      })

      expect(response.statusCode).toBe(201)
      // Prepared against the CURRENT period's scheduled session — not the record:
      expect(prepareSessionTransfer).toHaveBeenCalledWith(
        expectedId,
        expect.anything(),
        RECIPIENT.toLowerCase(),
        expect.anything(),
      )
      // The guarded flip ran AFTER the successful prepare, old id as the guard:
      const flip = mockQuery.mock.calls.find((c) => /UPDATE agents/.test(String(c[0])))
      expect(flip).toBeDefined()
      expect(flip![1]).toEqual([expectedId, AGENT.id, recordedId])
      // The intent pins the scheduled id:
      const insert = mockQuery.mock.calls.find((c) =>
        /INSERT INTO payment_intents/.test(String(c[0])),
      )
      expect(insert![1]).toContain(expectedId)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails closed when a session intent is missing its stored UserOperation', async () => {
    const signature = await sessionWallet.signMessage(getBytes(USER_OP_HASH))

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [sessionIntentRow({ session_user_op: null })] })
      .mockResolvedValueOnce({ rows: [{ id: PAYMENT_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: PAYMENT_ID }] }) // failed-status update

    const response = await app.inject({
      method: 'POST',
      url: `/payments/${PAYMENT_ID}/sign`,
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { signature },
    })

    expect(response.statusCode).toBe(502)
    expect(allowanceMocks.executeAllowanceTransfer).not.toHaveBeenCalled()
  })
})
