import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { agentAuthMiddleware } from './agentAuth.js'

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
}))

vi.mock('../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}))

function buildApp() {
  const app = Fastify({ logger: false })
  app.get('/payment-tool', { preHandler: agentAuthMiddleware }, async () => ({ ok: true }))
  return app
}

describe('agentAuthMiddleware', () => {
  beforeEach(() => {
    mockQuery.mockReset()
  })

  it('rejects pending approval agents for payment/API tool auth', async () => {
    const app = buildApp()
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'agent-1',
        user_id: 'user-1',
        name: 'Research Agent',
        delegate_address: '0x1111111111111111111111111111111111111111',
        safe_address: '0x2222222222222222222222222222222222222222',
        chain_id: 100,
        status: 'pending_approval',
      }],
    })

    const response = await app.inject({
      method: 'GET',
      url: '/payment-tool',
      headers: { authorization: 'Bearer sk_agent_pending' },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json().error).toBe('Invalid or revoked API key')

    await app.close()
  })

  it('allows active agents with a configured signing address and Safe', async () => {
    const app = buildApp()
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'agent-1',
        user_id: 'user-1',
        name: 'Research Agent',
        delegate_address: '0x1111111111111111111111111111111111111111',
        safe_address: '0x2222222222222222222222222222222222222222',
        chain_id: 100,
        status: 'active',
      }],
    })

    const response = await app.inject({
      method: 'GET',
      url: '/payment-tool',
      headers: { authorization: 'Bearer sk_agent_active' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true })

    await app.close()
  })
})
