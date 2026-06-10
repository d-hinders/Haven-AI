import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'

const mockQuery = vi.fn()

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}))

import agentActivityRoutes from '../agent-activity.js'

const SAFE_ADDRESS = '0x1111111111111111111111111111111111111111'
const TOKEN_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const MERCHANT_ADDRESS = '0x2222222222222222222222222222222222222222'
const TX_HASH = '0x72d03a8ff551e443c118c93c54d32260941deb613e51fcd2733cd3455e8fa1a1'

function paymentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'payment-1',
    agent_id: 'agent-1',
    safe_id: 'safe-base',
    safe_address: SAFE_ADDRESS,
    safe_name: 'Base wallet',
    chain_id: 8453,
    token_symbol: 'USDC',
    token_address: TOKEN_ADDRESS,
    amount_raw: '10000',
    amount_human: '0.01',
    to_address: MERCHANT_ADDRESS,
    status: 'confirmed',
    tx_hash: TX_HASH,
    source: 'x402',
    x402_resource_url: 'https://api.example.com/data',
    x402_merchant_address: MERCHANT_ADDRESS,
    payment_rail: 'x402',
    payment_resource_url: 'https://api.example.com/data',
    merchant_address: MERCHANT_ADDRESS,
    payment_proof_status: 'payment_confirmed',
    payment_reconciliation_event_type: null,
    created_at: '2026-05-08T11:49:00Z',
    confirmed_at: '2026-05-08T11:49:59Z',
    ...overrides,
  }
}

function approvalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'approval-1',
    agent_id: 'agent-1',
    safe_id: 'safe-base',
    safe_address: SAFE_ADDRESS,
    safe_name: 'Base wallet',
    chain_id: 8453,
    token_symbol: 'USDC',
    token_address: TOKEN_ADDRESS,
    amount_human: '0.01',
    to_address: MERCHANT_ADDRESS,
    reason: 'x402 payment approval',
    source: 'x402',
    x402_resource_url: 'https://api.example.com/data',
    payment_rail: 'x402',
    payment_resource_url: 'https://api.example.com/data',
    merchant_address: MERCHANT_ADDRESS,
    status: 'executed',
    tx_hash: TX_HASH,
    payment_proof_status: null,
    payment_reconciliation_event_type: null,
    created_at: '2026-05-08T11:48:00Z',
    ...overrides,
  }
}

describe('agent activity routes', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(agentActivityRoutes, { prefix: '/agent-activity' })
    token = app.jwt.sign({ sub: 'user-1', email: 'test@example.com' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('uses stored payment and approval Safe identity for a single agent activity feed', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM agents')) {
        return { rows: [{ id: 'agent-1' }] }
      }
      if (sql.includes('FROM payment_intents pi')) {
        return { rows: [paymentRow()] }
      }
      if (sql.includes('FROM approval_requests ar')) {
        return { rows: [approvalRow()] }
      }
      if (sql.includes('FROM agent_tool_invocations')) {
        return { rows: [] }
      }
      throw new Error(`Unexpected query: ${sql}`)
    })

    const response = await app.inject({
      method: 'GET',
      url: '/agent-activity/agent-1/activity',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.activity).toHaveLength(2)
    expect(body.activity[0]).toMatchObject({
      type: 'payment',
      safe_id: 'safe-base',
      safe_address: SAFE_ADDRESS,
      safe_name: 'Base wallet',
      chain_id: 8453,
    })
    expect(body.activity[1]).toMatchObject({
      type: 'approval',
      safe_id: 'safe-base',
      safe_address: SAFE_ADDRESS,
      safe_name: 'Base wallet',
      chain_id: 8453,
      token_address: TOKEN_ADDRESS,
    })

    const paymentSql = String(
      mockQuery.mock.calls.find(([sql]) => String(sql).includes('FROM payment_intents pi'))?.[0],
    )
    const approvalSql = String(
      mockQuery.mock.calls.find(([sql]) => String(sql).includes('FROM approval_requests ar'))?.[0],
    )
    expect(paymentSql).toContain('LOWER(us.safe_address) = LOWER(pi.safe_address)')
    expect(paymentSql).toContain('us.chain_id = pi.chain_id')
    expect(paymentSql).not.toContain('us.id = a.safe_id')
    expect(approvalSql).toContain('LOWER(us.safe_address) = LOWER(ar.safe_address)')
    expect(approvalSql).toContain('us.chain_id = ar.chain_id')
    expect(approvalSql).not.toContain('us.id = a.safe_id')
  })

  it('uses stored payment and approval Safe identity for the all-agent activity feed', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id, name FROM agents')) {
        return { rows: [{ id: 'agent-1', name: 'Research agent' }] }
      }
      if (sql.includes('FROM payment_intents pi')) {
        return { rows: [paymentRow()] }
      }
      if (sql.includes('FROM approval_requests ar')) {
        return { rows: [approvalRow()] }
      }
      if (sql.includes('FROM agent_tool_invocations')) {
        return { rows: [] }
      }
      if (sql.includes('SELECT COUNT(*) as count FROM approval_requests')) {
        return { rows: [{ count: '0' }] }
      }
      throw new Error(`Unexpected query: ${sql}`)
    })

    const response = await app.inject({
      method: 'GET',
      url: '/agent-activity/feed?limit=10',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.pending_approvals).toBe(0)
    expect(body.activity).toHaveLength(2)
    expect(body.activity[0]).toMatchObject({
      type: 'payment',
      agent_id: 'agent-1',
      agent_name: 'Research agent',
      safe_id: 'safe-base',
      safe_address: SAFE_ADDRESS,
      chain_id: 8453,
    })
    expect(body.activity[1]).toMatchObject({
      type: 'approval',
      agent_id: 'agent-1',
      agent_name: 'Research agent',
      safe_id: 'safe-base',
      safe_address: SAFE_ADDRESS,
      chain_id: 8453,
    })
  })
})
