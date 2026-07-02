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

const { mockQuery, allowanceMocks, fiatMocks, sessionRailMocks } = vi.hoisted(() => ({
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
