import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { expectMatchesSpec } from '../../openapi/response-shape.js'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'

const mockQuery = vi.fn()

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}))

import agentActivityRoutes from '../agent-activity.js'

// #2055 (epic #1440, #2021 readability waiver): `approval_requests` is
// dropped and the activity/feed routes no longer query it at all — the
// `isUserApprovalCount` SQL-shape matcher this file used to pin the
// user-scoped approval COUNT is gone along with the query it matched;
// `pending_approvals` is now hardcoded 0 in both routes (asserted below).

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

  it('exposes execution_rail + pinned session_permission_id on payments (#799 rollover observability)', async () => {
    const PID = `0x${'ab'.repeat(32)}`
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM agents')) return { rows: [{ id: 'agent-1' }] }
      if (sql.includes('FROM payment_intents pi')) {
        return { rows: [paymentRow({ execution_rail: 'session_key', session_permission_id: PID })] }
      }
      if (sql.includes('FROM agent_tool_invocations')) return { rows: [] }
      throw new Error(`Unexpected query: ${sql}`)
    })

    const response = await app.inject({
      method: 'GET',
      url: '/agent-activity/agent-1/activity',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    const payment = response.json().activity[0]
    expect(payment).toMatchObject({
      type: 'payment',
      execution_rail: 'session_key',
      session_permission_id: PID,
    })
    // The SELECT actually fetches the columns (schema-smoke guards the shape):
    const paymentSql = String(
      mockQuery.mock.calls.find(([sql]) => String(sql).includes('FROM payment_intents pi'))?.[0],
    )
    expect(paymentSql).toContain('pi.execution_rail')
    expect(paymentSql).toContain('pi.session_permission_id')
  })

  // #2055: was "uses stored payment and approval Safe identity for a single
  // agent activity feed" — the approval branch is gone with the table, so
  // this pins the payment branch alone and that no approval query runs.
  it('uses stored payment Safe identity for a single agent activity feed', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM agents')) {
        return { rows: [{ id: 'agent-1' }] }
      }
      if (sql.includes('FROM payment_intents pi')) {
        return { rows: [paymentRow()] }
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
    expect(body.activity).toHaveLength(1)
    expectMatchesSpec('GET', '/agent-activity/{id}/activity', body)
    expect(body.activity[0]).toMatchObject({
      type: 'payment',
      safe_id: 'safe-base',
      safe_address: SAFE_ADDRESS,
      safe_name: 'Base wallet',
      chain_id: 8453,
    })

    const paymentSql = String(
      mockQuery.mock.calls.find(([sql]) => String(sql).includes('FROM payment_intents pi'))?.[0],
    )
    expect(paymentSql).toContain('LOWER(us.safe_address) = LOWER(pi.safe_address)')
    expect(paymentSql).toContain('us.chain_id = pi.chain_id')
    expect(paymentSql).not.toContain('us.id = a.safe_id')
    // No approval-sourced entry, and no query against the dropped table.
    expect(mockQuery.mock.calls.some(([sql]) => /approval_requests/i.test(String(sql)))).toBe(false)
  })

  // #2055: was "uses stored payment and approval Safe identity for the
  // all-agent activity feed" — same reduction, plus `pending_approvals` is
  // now hardcoded 0 rather than read from a COUNT query.
  it('uses stored payment Safe identity for the all-agent activity feed, pending_approvals hardcoded 0', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id, name FROM agents')) {
        return { rows: [{ id: 'agent-1', name: 'Research agent' }] }
      }
      if (sql.includes('FROM payment_intents pi')) {
        return { rows: [paymentRow()] }
      }
      if (sql.includes('FROM agent_tool_invocations')) {
        return { rows: [] }
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
    expect(body.activity).toHaveLength(1)
    // The FEED route had no schema assertion at all (#1446 review).
    expectMatchesSpec('GET', '/agent-activity/feed', body)
    expect(body.activity[0]).toMatchObject({
      type: 'payment',
      agent_id: 'agent-1',
      agent_name: 'Research agent',
      safe_id: 'safe-base',
      safe_address: SAFE_ADDRESS,
      chain_id: 8453,
    })
    expect(mockQuery.mock.calls.some(([sql]) => /approval_requests/i.test(String(sql)))).toBe(false)
  })
})
