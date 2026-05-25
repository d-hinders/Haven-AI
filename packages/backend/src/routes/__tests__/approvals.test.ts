import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'

const mockQuery = vi.fn()

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}))

import approvalRoutes from '../approvals.js'

describe('approval routes', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(approvalRoutes, { prefix: '/approvals' })
    token = app.jwt.sign({ sub: 'user-1', email: 'test@example.com' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('GET / includes merchant_address, payment_rail, payment_resource_url for x402 approval rows', async () => {
    const x402Row = {
      id: 'approval-x402',
      agent_id: 'agent-1',
      user_id: 'user-1',
      safe_address: '0xSafe',
      chain_id: 100,
      token_symbol: 'USDC',
      token_address: '0xToken',
      to_address: '0xDelegate',
      amount_raw: '1000000',
      amount_human: '1.000000',
      reason: 'x402 API call',
      source: 'x402',
      x402_resource_url: 'https://api.example.com/resource',
      payment_rail: 'x402',
      payment_resource_url: 'https://api.example.com/resource',
      merchant_address: '0xMerchant',
      status: 'pending',
      tx_hash: null,
      reviewed_at: null,
      usd_value: null,
      eur_value: null,
      executed_at: null,
      created_at: '2026-05-25T00:00:00Z',
      expires_at: '2026-05-26T00:00:00Z',
    }

    // expire stale, SELECT rows, agent names, actionable count
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // expire UPDATE
      .mockResolvedValueOnce({ rows: [x402Row] }) // SELECT approvals
      .mockResolvedValueOnce({ rows: [{ id: 'agent-1', name: 'Test Agent' }] }) // agent names
      .mockResolvedValueOnce({ rows: [{ count: '1' }] }) // actionable count

    const response = await app.inject({
      method: 'GET',
      url: '/approvals',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    const approval = body.approvals[0]
    expect(approval.merchant_address).toBe('0xMerchant')
    expect(approval.payment_rail).toBe('x402')
    expect(approval.payment_resource_url).toBe('https://api.example.com/resource')
    // legacy fields must still be present
    expect(approval.to_address).toBe('0xDelegate')
    expect(approval.source).toBe('x402')
    expect(approval.x402_resource_url).toBe('https://api.example.com/resource')
  })

  it('POST /:id/approve derives source from payment_rail so it matches GET /', async () => {
    // Row where the legacy `source` column is stale but payment_rail is the
    // authoritative rail. GET / coalesces this via SQL; POST /:id/approve must
    // do the same in JS so both endpoints agree.
    const approvedRow = {
      id: 'approval-x402',
      agent_id: 'agent-1',
      user_id: 'user-1',
      safe_address: '0xSafe',
      chain_id: 100,
      token_symbol: 'USDC',
      token_address: '0xToken',
      to_address: '0xDelegate',
      amount_raw: '1000000',
      amount_human: '1.000000',
      reason: 'x402 API call',
      source: 'direct',
      x402_resource_url: null,
      payment_rail: 'x402',
      payment_resource_url: 'https://api.example.com/resource',
      merchant_address: '0xMerchant',
      status: 'approved',
      tx_hash: null,
      reviewed_at: '2026-05-25T00:00:00Z',
      usd_value: null,
      eur_value: null,
      executed_at: null,
      created_at: '2026-05-25T00:00:00Z',
      expires_at: '2026-05-26T00:00:00Z',
    }
    mockQuery.mockResolvedValueOnce({ rows: [approvedRow] })

    const response = await app.inject({
      method: 'POST',
      url: '/approvals/approval-x402/approve',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.payment.source).toBe('x402')
    expect(body.payment.payment_rail).toBe('x402')
    expect(body.payment.merchant_address).toBe('0xMerchant')
    // Resource URL should also prefer payment_resource_url over legacy x402_resource_url
    expect(body.payment.x402_resource_url).toBe('https://api.example.com/resource')
    expect(body.payment.payment_resource_url).toBe('https://api.example.com/resource')
  })

  it('marks an approved request as proposed', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'approval-1' }] })

    const response = await app.inject({
      method: 'POST',
      url: '/approvals/approval-1/proposed',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ id: 'approval-1', status: 'proposed' })
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("status = 'approved' AND expires_at > NOW()"),
      ['approval-1', 'user-1'],
    )
  })

  it('does not mark pending or expired requests as proposed', async () => {
    mockQuery.mockResolvedValue({ rows: [] })

    const response = await app.inject({
      method: 'POST',
      url: '/approvals/approval-1/proposed',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({
      error: 'Approval request not found or no longer actionable',
    })
  })

  it('rejects malformed execution transaction hashes', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/approvals/approval-1/executed',
      headers: { authorization: `Bearer ${token}` },
      payload: { tx_hash: '0xabc' },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'Valid tx_hash is required' })
    expect(mockQuery).not.toHaveBeenCalled()
  })
})
