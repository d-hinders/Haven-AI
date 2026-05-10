import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import x402Routes from '../x402.js'

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
const MERCHANT = '0x15179876c595922999C2d5DC7c23Cc7711fE799a'
const SIGN_HASH = `0x${'11'.repeat(32)}`

function authRow() {
  return { rows: [AGENT] }
}

describe('x402 routes', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(x402Routes, { prefix: '/x402' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockQuery.mockReset()
    for (const mock of Object.values(allowanceMocks)) mock.mockReset()
  })

  it('creates a funding intent to the delegate and records merchant metadata', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 7 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 1_000_000n })
    allowanceMocks.generateTransferHash.mockResolvedValueOnce(SIGN_HASH)

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowance_amount: '10' }] })
      .mockResolvedValueOnce({ rows: [{ max_x402_per_hour: 100 }] })
      .mockResolvedValueOnce({ rows: [{ cnt: '0' }] })
      .mockResolvedValueOnce({
        rows: [{
          id: '33333333-3333-3333-3333-333333333333',
          expires_at: '2026-05-10T20:00:00.000Z',
        }],
      })

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
        idempotencyKey: 'x402:test',
      },
    })

    expect(response.statusCode).toBe(201)
    expect(response.json()).toMatchObject({
      payment_id: '33333333-3333-3333-3333-333333333333',
      status: 'pending_signature',
      chain_id: 8453,
      to: AGENT.delegate_address.toLowerCase(),
      merchant_to: MERCHANT.toLowerCase(),
      sign_data: {
        hash: SIGN_HASH,
        components: {
          safe: AGENT.safe_address,
          token: USDC,
          to: AGENT.delegate_address.toLowerCase(),
          amount: '20000',
          nonce: 7,
        },
      },
    })

    expect(allowanceMocks.generateTransferHash).toHaveBeenCalledWith(
      8453,
      AGENT.safe_address,
      USDC,
      AGENT.delegate_address,
      20000n,
      '0x0000000000000000000000000000000000000000',
      0n,
      7,
    )

    const insertCall = mockQuery.mock.calls[5]
    expect(insertCall[0]).toContain('x402_merchant_address')
    expect(insertCall[0]).toContain('x402_idempotency_key')
    expect(insertCall[1]).toContain(MERCHANT.toLowerCase())
    expect(insertCall[1]).toContain('x402:test')
  })

  it('rejects payment requirements whose network does not match the agent chain', async () => {
    mockQuery.mockResolvedValueOnce(authRow())

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        amount: '20000',
        asset: USDC,
        network: 'eip155:100',
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('x402 network eip155:100 does not match agent chain 8453')
    expect(allowanceMocks.generateTransferHash).not.toHaveBeenCalled()
  })

  it('returns an existing pending signature intent for duplicate idempotency keys', async () => {
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({
        rows: [{
          id: '33333333-3333-3333-3333-333333333333',
          status: 'pending_signature',
          expires_at: '2026-05-10T20:00:00.000Z',
          chain_id: 8453,
          safe_address: AGENT.safe_address,
          token_symbol: 'USDC',
          token_address: USDC,
          amount_human: '0.02',
          amount_raw: '20000',
          to_address: AGENT.delegate_address.toLowerCase(),
          x402_merchant_address: MERCHANT.toLowerCase(),
          x402_resource_url: 'https://mcp.soundside.ai/mcp',
          sign_hash: SIGN_HASH,
          allowance_nonce: 7,
        }],
      })

    const response = await app.inject({
      method: 'POST',
      url: '/x402',
      headers: { authorization: 'Bearer sk_agent_test' },
      payload: {
        url: 'https://mcp.soundside.ai/mcp',
        payTo: AGENT.delegate_address,
        merchantPayTo: MERCHANT,
        amount: '20000',
        asset: USDC,
        network: 'base',
        idempotencyKey: 'x402:test',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      payment_id: '33333333-3333-3333-3333-333333333333',
      status: 'pending_signature',
      to: AGENT.delegate_address.toLowerCase(),
      merchant_to: MERCHANT.toLowerCase(),
      sign_data: { hash: SIGN_HASH },
    })
    expect(allowanceMocks.generateTransferHash).not.toHaveBeenCalled()
  })
})
