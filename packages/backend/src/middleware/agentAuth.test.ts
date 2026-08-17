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

  // #1130 contract change: a pending agent's key is VALID — the old 401
  // 'Invalid or revoked API key' asserted two falsehoods and sent operators
  // hunting for a revocation instead of finishing the budget grant.
  it('rejects pending approval agents with a NAMED 403, not the invalid-key 401', async () => {
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

    expect(response.statusCode).toBe(403)
    expect(response.json().error).toBe('agent_pending_approval')
    expect(response.json().detail).toMatch(/budget/)

    await app.close()
  })

  it('an unknown key still 401s with the invalid-key message', async () => {
    const app = buildApp()
    mockQuery.mockResolvedValueOnce({ rows: [] })
    const response = await app.inject({
      method: 'GET',
      url: '/payment-tool',
      headers: { authorization: 'Bearer sk_agent_nope' },
    })
    expect(response.statusCode).toBe(401)
    expect(response.json().error).toBe('Invalid or revoked API key')
    await app.close()
  })

  it('an ARCHIVED agent\'s key is rejected — pinned, not an emergent property (#1401)', async () => {
    // Archive requires status='revoked' and the allow-list only admits
    // active/paused, so this holds by construction today. The test exists so
    // a future status refactor cannot silently let archived agents
    // authenticate: the row below is exactly what an archived agent looks
    // like, and it must 401.
    const app = buildApp()
    mockQuery.mockImplementation(async () => ({
      rows: [{
        id: 'agent-1', user_id: 'user-1', name: 'A',
        delegate_address: '0x1111111111111111111111111111111111111111',
        safe_address: '0x2222222222222222222222222222222222222222',
        chain_id: 100, status: 'revoked', archived_at: '2026-08-14T12:00:00.000Z',
      }],
    }))
    const response = await app.inject({
      method: 'GET',
      url: '/payment-tool',
      headers: { authorization: 'Bearer sk_agent_x' },
    })
    expect(response.statusCode).toBe(401)
    await app.close()
  })

  it('revoked and unknown future statuses still 401 — the allow-list stays positive', async () => {
    for (const status of ['revoked', 'some_future_status']) {
      const app = buildApp()
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'agent-1', user_id: 'user-1', name: 'A',
          delegate_address: '0x1111111111111111111111111111111111111111',
          safe_address: '0x2222222222222222222222222222222222222222',
          chain_id: 100, status,
        }],
      })
      const response = await app.inject({
        method: 'GET',
        url: '/payment-tool',
        headers: { authorization: 'Bearer sk_agent_x' },
      })
      expect(response.statusCode, status).toBe(401)
      expect(response.json().error).toBe('Invalid or revoked API key')
      await app.close()
    }
  })

  it('paused behaviour is untouched: 403 agent_paused', async () => {
    const app = buildApp()
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'agent-1', user_id: 'user-1', name: 'A',
        delegate_address: '0x1111111111111111111111111111111111111111',
        safe_address: '0x2222222222222222222222222222222222222222',
        chain_id: 100, status: 'paused',
      }],
    })
    const response = await app.inject({
      method: 'GET',
      url: '/payment-tool',
      headers: { authorization: 'Bearer sk_agent_paused' },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json().error).toBe('agent_paused')
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
