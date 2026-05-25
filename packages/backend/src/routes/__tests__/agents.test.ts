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

  it('fetches one agent with allowances', async () => {
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
    })
    expect(mockQuery.mock.calls[0][1]).toEqual(['user-1', 'agent-1'])

    await app.close()
  })
})
