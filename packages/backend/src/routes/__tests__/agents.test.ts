import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import agentRoutes from '../agents.js'

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
}))

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}))

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: async (request: { user?: { sub: string } }) => {
    request.user = { sub: 'user-1' }
  },
}))

describe('agent routes', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('fetches one agent with allowances and null mcp_last_seen_at when never called', async () => {
    const app = Fastify({ logger: false })
    await app.register(agentRoutes, { prefix: '/agents' })

    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 'agent-1',
          name: 'Research Agent',
          description: null,
          delegate_address: '0x1111111111111111111111111111111111111111',
          safe_id: 'safe-1',
          safe_address: '0x2222222222222222222222222222222222222222',
          safe_name: 'Main wallet',
          safe_chain_id: 8453,
          api_key_prefix: 'sk_agent_abc',
          status: 'active',
          created_at: '2026-05-25T12:00:00.000Z',
          mcp_last_seen_at: null,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'allowance-1',
          agent_id: 'agent-1',
          token_address: '0x3333333333333333333333333333333333333333',
          token_symbol: 'USDC',
          allowance_amount: '25',
          reset_period_min: 10080,
        }],
      })

    const response = await app.inject({
      method: 'GET',
      url: '/agents/agent-1',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      id: 'agent-1',
      name: 'Research Agent',
      allowances: [{ id: 'allowance-1', token_symbol: 'USDC' }],
      mcp_last_seen_at: null,
    })
    expect(String(mockQuery.mock.calls[0][0])).toContain("a.status != 'pending_approval'")
    expect(mockQuery.mock.calls[0][1]).toEqual(['user-1', 'agent-1'])

    await app.close()
  })

  it('returns mcp_last_seen_at when agent has made tool calls', async () => {
    const app = Fastify({ logger: false })
    await app.register(agentRoutes, { prefix: '/agents' })

    const lastSeenAt = '2026-05-28T14:00:00.000Z'
    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 'agent-1',
          name: 'Research Agent',
          description: null,
          delegate_address: '0x1111111111111111111111111111111111111111',
          safe_id: 'safe-1',
          safe_address: '0x2222222222222222222222222222222222222222',
          safe_name: 'Main wallet',
          safe_chain_id: 8453,
          api_key_prefix: 'sk_agent_abc',
          status: 'active',
          created_at: '2026-05-25T12:00:00.000Z',
          mcp_last_seen_at: lastSeenAt,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })

    const response = await app.inject({
      method: 'GET',
      url: '/agents/agent-1',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().mcp_last_seen_at).toBe(lastSeenAt)
    expect(String(mockQuery.mock.calls[0][0])).toContain("a.status != 'pending_approval'")

    await app.close()
  })

  it('excludes pending Connect Agent 2 setups from the legacy agent list', async () => {
    const app = Fastify({ logger: false })
    await app.register(agentRoutes, { prefix: '/agents' })

    mockQuery.mockResolvedValueOnce({ rows: [] })

    const response = await app.inject({
      method: 'GET',
      url: '/agents',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ agents: [] })
    expect(String(mockQuery.mock.calls[0][0])).toContain("a.status != 'pending_approval'")

    await app.close()
  })

  it('blocks allowance updates while Connect Agent 2 setup is pending wallet approval', async () => {
    const app = Fastify({ logger: false })
    await app.register(agentRoutes, { prefix: '/agents' })

    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'agent-1',
        status: 'pending_approval',
      }],
    })

    const response = await app.inject({
      method: 'POST',
      url: '/agents/agent-1/allowances',
      payload: {
        token_address: '0x3333333333333333333333333333333333333333',
        token_symbol: 'USDC',
        allowance_amount: '25000000',
        reset_period_min: 1440,
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toMatch(/pending wallet approval/)
    expect(mockQuery).toHaveBeenCalledTimes(1)

    await app.close()
  })

  it('blocks allowance deletes while Connect Agent 2 setup is pending wallet approval', async () => {
    const app = Fastify({ logger: false })
    await app.register(agentRoutes, { prefix: '/agents' })

    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'agent-1',
        status: 'pending_approval',
      }],
    })

    const response = await app.inject({
      method: 'DELETE',
      url: '/agents/agent-1/allowances/0x3333333333333333333333333333333333333333',
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toMatch(/pending wallet approval/)
    expect(mockQuery).toHaveBeenCalledTimes(1)

    await app.close()
  })
})
