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
const X402_BINDING_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f094538797afad9453b9c9d87f1977948421179d'

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
    process.env.X402_BINDING_PRIVATE_KEY = X402_BINDING_PRIVATE_KEY
    mockQuery.mockReset()
    for (const mock of Object.values(allowanceMocks)) mock.mockReset()
  })

  it('registers /x402/authorize as the explicit authorize endpoint', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/x402/authorize',
      payload: {},
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: 'Missing or invalid API key' })
  })

  it('creates a funding intent to the delegate and records merchant metadata', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 7 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 1_000_000n })
    allowanceMocks.generateTransferHash.mockResolvedValueOnce(SIGN_HASH)

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })
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
      x402_expected_auth: {
        version: 1,
        message: expect.stringContaining('Haven x402 expected context v1'),
        signature: expect.stringMatching(/^0x[0-9a-f]{130}$/i),
        signer: expect.stringMatching(/^0x[0-9a-f]{40}$/i),
      },
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

    const insertCall = mockQuery.mock.calls[6]
    expect(insertCall[0]).toContain('x402_merchant_address')
    expect(insertCall[0]).toContain('x402_idempotency_key')
    expect(insertCall[0]).toContain('payment_rail')
    expect(insertCall[0]).toContain('merchant_address')
    expect(insertCall[0]).toContain('machine_idempotency_key')
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
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 7 })

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

  it('refreshes stale sign data when a duplicate pending intent has an old allowance nonce', async () => {
    const refreshedHash = `0x${'22'.repeat(32)}`
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 8 })
    allowanceMocks.generateTransferHash.mockResolvedValueOnce(refreshedHash)

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
      .mockResolvedValueOnce({ rows: [] })

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
    expect(response.json().sign_data).toMatchObject({
      hash: refreshedHash,
      components: { nonce: 8 },
    })
    expect(allowanceMocks.generateTransferHash).toHaveBeenCalledWith(
      8453,
      AGENT.safe_address,
      USDC,
      AGENT.delegate_address.toLowerCase(),
      20000n,
      '0x0000000000000000000000000000000000000000',
      0n,
      8,
    )
    expect(mockQuery.mock.calls[2][0]).toContain('UPDATE payment_intents')
  })

  it('queues over-allowance x402 payments once with rail metadata', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 7 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 10_000n })

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowance_amount: '10' }] })
      .mockResolvedValueOnce({ rows: [{ max_x402_per_hour: 100 }] })
      .mockResolvedValueOnce({ rows: [{ cnt: '0' }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'approval-123',
          status: 'pending',
          token_symbol: 'USDC',
          amount_human: '0.02',
          expires_at: '2026-05-10T20:00:00.000Z',
          machine_challenge_id: null,
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
        category: 'data',
        idempotencyKey: 'x402:approval',
      },
    })

    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({
      payment_id: 'approval-123',
      status: 'pending_approval',
      phase: 'user_approval_required',
      next_action: 'wait_for_user_approval',
      remaining: '0.01',
      requested: '0.02',
      token: 'USDC',
      rail: 'x402',
      resource_url: 'https://mcp.soundside.ai/mcp',
      merchant_address: MERCHANT.toLowerCase(),
      chain_id: 8453,
      amount_atomic: '20000',
      asset: USDC,
      network: 'base',
      idempotency_key: 'x402:approval',
      challenge_id: null,
      x402: {
        amount_atomic: '20000',
        asset: USDC,
        network: 'base',
        resource_url: 'https://mcp.soundside.ai/mcp',
        merchant_address: MERCHANT.toLowerCase(),
        idempotency_key: 'x402:approval',
      },
    })

    const insertCall = mockQuery.mock.calls[6]
    expect(insertCall[0]).toContain('payment_rail')
    expect(insertCall[0]).toContain('payment_resource_url')
    expect(insertCall[0]).toContain('merchant_address')
    expect(insertCall[0]).toContain('machine_idempotency_key')
    expect(insertCall[0]).toContain('ON CONFLICT (agent_id, machine_idempotency_key)')
    expect(insertCall[1]).toContain('https://mcp.soundside.ai/mcp')
    expect(insertCall[1]).toContain(MERCHANT.toLowerCase())
    expect(insertCall[1]).toContain('x402:approval')
    expect(insertCall[1]).toContain(JSON.stringify({
      protocol: 'x402',
      network: 'base',
      category: 'data',
      description: null,
    }))
  })

  it('returns an existing pending approval for duplicate over-allowance idempotency keys', async () => {
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'approval-123',
          status: 'pending',
          token_symbol: 'USDC',
          amount_human: '0.02',
          expires_at: '2026-05-10T20:00:00.000Z',
          machine_challenge_id: null,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'approval-123',
          chain_id: 8453,
          token_symbol: 'USDC',
          token_address: USDC,
          amount_human: '0.02',
          amount_raw: '20000',
          status: 'pending',
          tx_hash: null,
          expires_at: '2026-05-10T20:00:00.000Z',
          source: 'x402',
          payment_rail: 'x402',
          payment_resource_url: 'https://mcp.soundside.ai/mcp',
          x402_resource_url: 'https://mcp.soundside.ai/mcp',
          merchant_address: MERCHANT.toLowerCase(),
          machine_idempotency_key: 'x402:approval',
          machine_metadata: JSON.stringify({
            protocol: 'x402',
            network: 'base',
            category: null,
            description: null,
          }),
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
        idempotencyKey: 'x402:approval',
      },
    })

    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({
      payment_id: 'approval-123',
      kind: 'approval_request',
      status: 'pending',
      phase: 'user_approval_required',
      next_action: 'wait_for_user_approval',
      amount: '0.02',
      token: 'USDC',
      rail: 'x402',
      resource_url: 'https://mcp.soundside.ai/mcp',
      merchant_address: MERCHANT.toLowerCase(),
      amount_atomic: '20000',
      asset: USDC,
      network: 'base',
      idempotency_key: 'x402:approval',
      x402: {
        amount_atomic: '20000',
        asset: USDC,
        network: 'base',
        resource_url: 'https://mcp.soundside.ai/mcp',
        merchant_address: MERCHANT.toLowerCase(),
        idempotency_key: 'x402:approval',
      },
    })
    expect(allowanceMocks.getTokenAllowance).not.toHaveBeenCalled()
  })

  it('returns executed approvals as ready for the original x402 retry', async () => {
    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'approval-123',
          status: 'executed',
          token_symbol: 'USDC',
          amount_human: '0.02',
          expires_at: '2026-05-10T20:00:00.000Z',
          machine_challenge_id: null,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'approval-123',
          chain_id: 8453,
          token_symbol: 'USDC',
          token_address: USDC,
          amount_human: '0.02',
          amount_raw: '20000',
          status: 'executed',
          tx_hash: `0x${'ab'.repeat(32)}`,
          expires_at: '2026-05-10T20:00:00.000Z',
          source: 'x402',
          payment_rail: 'x402',
          payment_resource_url: 'https://mcp.soundside.ai/mcp',
          x402_resource_url: 'https://mcp.soundside.ai/mcp',
          merchant_address: MERCHANT.toLowerCase(),
          machine_idempotency_key: 'x402:approval',
          machine_metadata: JSON.stringify({
            protocol: 'x402',
            network: 'base',
            category: null,
            description: null,
          }),
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
        idempotencyKey: 'x402:approval',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      payment_id: 'approval-123',
      kind: 'approval_request',
      status: 'executed',
      phase: 'funding_sent',
      next_action: 'retry_original_x402_request',
      rail: 'x402',
      resource_url: 'https://mcp.soundside.ai/mcp',
      merchant_address: MERCHANT.toLowerCase(),
      amount_atomic: '20000',
      asset: USDC,
      network: 'base',
      idempotency_key: 'x402:approval',
    })
    expect(allowanceMocks.getTokenAllowance).not.toHaveBeenCalled()
  })

  it('returns the existing approval when an over-allowance insert hits an idempotency conflict', async () => {
    allowanceMocks.getTokenAllowance.mockResolvedValueOnce({ nonce: 7 })
    allowanceMocks.computeEffectiveAllowance.mockReturnValueOnce({ remaining: 10_000n })

    mockQuery
      .mockResolvedValueOnce(authRow())
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ allowance_amount: '10' }] })
      .mockResolvedValueOnce({ rows: [{ max_x402_per_hour: 100 }] })
      .mockResolvedValueOnce({ rows: [{ cnt: '0' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'approval-123',
          status: 'pending',
          token_symbol: 'USDC',
          amount_human: '0.02',
          expires_at: '2026-05-10T20:00:00.000Z',
          machine_challenge_id: null,
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
        idempotencyKey: 'x402:approval',
      },
    })

    expect(response.statusCode).toBe(202)
    expect(response.json()).toMatchObject({
      payment_id: 'approval-123',
      status: 'pending_approval',
      remaining: '0.01',
      rail: 'x402',
      resource_url: 'https://mcp.soundside.ai/mcp',
      merchant_address: MERCHANT.toLowerCase(),
      amount_atomic: '20000',
      asset: USDC,
      network: 'base',
      idempotency_key: 'x402:approval',
    })
    expect(mockQuery.mock.calls[7][0]).toContain('FROM approval_requests')
  })
})
