import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import machinePaymentRoutes from '../machine-payments.js'

const { mockQuery, allowanceMocks } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  allowanceMocks: {
    getTokenAllowance: vi.fn(),
    computeEffectiveAllowance: vi.fn(),
    generateTransferHash: vi.fn(),
    recoverSigner: vi.fn(),
    executeAllowanceTransfer: vi.fn(),
  },
}))

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}))

vi.mock('../../lib/allowance-module.js', () => allowanceMocks)

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

function authRow() {
  return { rows: [AGENT] }
}

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
  })

  it('creates an MPP demo payment intent with generic rail metadata', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 3 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 10000n })
    allowanceMocks.generateTransferHash.mockResolvedValueOnce(SIGN_HASH)

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowance_amount: '10000' }] })
      .mockResolvedValueOnce({
        rows: [{
          id: '33333333-3333-3333-3333-333333333333',
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
          sign_hash: SIGN_HASH,
          allowance_nonce: 3,
        }],
      })

    const response = await app.inject({
      method: 'POST',
      url: '/machine-payments/authorize',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: { challenge, idempotencyKey: 'mpp_demo:test' },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      payment_id: '33333333-3333-3333-3333-333333333333',
      status: 'pending_signature',
      rail: 'mpp_demo',
      challenge_id: challenge.challengeId,
      amount: '0.01',
      token: 'USDC',
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

    const insertCall = mockQuery.mock.calls[3]
    expect(insertCall[0]).toContain('payment_rail')
    expect(insertCall[0]).toContain('machine_challenge_id')
    expect(insertCall[0]).toContain('machine_idempotency_key')
    expect(insertCall[1]).toContain('mpp_demo')
    expect(insertCall[1]).toContain(challenge.challengeId)
    expect(insertCall[1]).toContain('mpp_demo:test')
  })
})
