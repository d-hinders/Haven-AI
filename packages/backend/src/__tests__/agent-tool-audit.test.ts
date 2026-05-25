import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import {
  registerAgentToolAuditHooks,
  type QueryableLike,
} from '../middleware/agentToolAudit.js'

interface RecordedQuery {
  text: string
  values: unknown[]
}

function buildFakePool(): { pool: QueryableLike; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = []
  const pool: QueryableLike = {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      queries.push({ text, values })
      return { rows: [], rowCount: 0 }
    }),
  }
  return { pool, queries }
}

function agentContext() {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    user_id: '22222222-2222-2222-2222-222222222222',
    name: 'Test agent',
    delegate_address: '0xdead',
    safe_address: '0xsafe',
    chain_id: 100,
    status: 'active',
  }
}

async function buildAppWithFakeAuth(pool: QueryableLike) {
  const app = Fastify({ logger: false })

  // Stand-in for agentAuthMiddleware: decorate request.agent when the
  // X-Test-Agent header is present. This lets the audit hooks attribute
  // a call without booting the full auth stack.
  app.addHook('onRequest', async (request) => {
    if (request.headers['x-test-agent'] === '1') {
      request.agent = agentContext()
    }
  })

  registerAgentToolAuditHooks(app, pool)

  app.post('/payments', async (_request, reply) => {
    return reply.code(202).send({
      payment_id: '33333333-3333-3333-3333-333333333333',
      kind: 'approval_request',
      next_action: 'wait_for_user_approval',
      phase: 'user_approval_required',
    })
  })

  app.get('/agents/me', async () => ({ ok: true }))

  app.post('/payments/deny', async (_request, reply) => {
    return reply.code(403).send({ error: 'agent_paused' })
  })

  return app
}

describe('agent_tool_invocations audit hook', () => {
  it('writes a row when X-Haven-MCP-Tool header matches the allowlist', async () => {
    const { pool, queries } = buildFakePool()
    const app = await buildAppWithFakeAuth(pool)

    const res = await app.inject({
      method: 'GET',
      url: '/agents/me',
      headers: {
        'x-test-agent': '1',
        'x-haven-mcp-tool': 'haven_get_agent',
      },
    })

    expect(res.statusCode).toBe(200)

    // Audit insert happens in onResponse — give Fastify a tick.
    await new Promise((r) => setImmediate(r))

    expect(queries.length).toBe(1)
    const [query] = queries
    expect(query.text).toContain('INSERT INTO agent_tool_invocations')
    expect(query.values[0]).toBe(agentContext().id)
    expect(query.values[2]).toBe('haven_get_agent')
    expect(query.values[3]).toBeNull() // payment_id
    expect(query.values[4]).toBe('ok')
    expect(query.values[7]).toBe(200)

    await app.close()
  })

  it('captures payment_id, next_action, and pending status on 202 approval responses', async () => {
    const { pool, queries } = buildFakePool()
    const app = await buildAppWithFakeAuth(pool)

    const res = await app.inject({
      method: 'POST',
      url: '/payments',
      headers: {
        'x-test-agent': '1',
        'x-haven-mcp-tool': 'haven_pay_x402_quote',
        'content-type': 'application/json',
      },
      payload: { token: 'USDC', amount: '1', to: '0xabc' },
    })

    expect(res.statusCode).toBe(202)
    await new Promise((r) => setImmediate(r))

    expect(queries.length).toBe(1)
    const [query] = queries
    expect(query.values[2]).toBe('haven_pay_x402_quote')
    expect(query.values[3]).toBe('33333333-3333-3333-3333-333333333333')
    expect(query.values[4]).toBe('ok')
    expect(query.values[5]).toBe('wait_for_user_approval')
    expect(query.values[7]).toBe(202)

    await app.close()
  })

  it('records 403 responses as denied with error_code', async () => {
    const { pool, queries } = buildFakePool()
    const app = await buildAppWithFakeAuth(pool)

    const res = await app.inject({
      method: 'POST',
      url: '/payments/deny',
      headers: {
        'x-test-agent': '1',
        'x-haven-mcp-tool': 'haven_pay_x402_quote',
      },
    })

    expect(res.statusCode).toBe(403)
    await new Promise((r) => setImmediate(r))

    expect(queries.length).toBe(1)
    const [query] = queries
    expect(query.values[4]).toBe('denied')
    expect(query.values[6]).toBe('agent_paused')
    expect(query.values[7]).toBe(403)

    await app.close()
  })

  it('does not write a row when the header is absent', async () => {
    const { pool, queries } = buildFakePool()
    const app = await buildAppWithFakeAuth(pool)

    await app.inject({
      method: 'GET',
      url: '/agents/me',
      headers: { 'x-test-agent': '1' },
    })

    await new Promise((r) => setImmediate(r))
    expect(queries.length).toBe(0)

    await app.close()
  })

  it('does not write a row when the tool name is not in the allowlist', async () => {
    const { pool, queries } = buildFakePool()
    const app = await buildAppWithFakeAuth(pool)

    await app.inject({
      method: 'GET',
      url: '/agents/me',
      headers: {
        'x-test-agent': '1',
        'x-haven-mcp-tool': 'haven_doom',
      },
    })

    await new Promise((r) => setImmediate(r))
    expect(queries.length).toBe(0)

    await app.close()
  })

  it('does not write a row when no agent context is attached (unauthenticated)', async () => {
    const { pool, queries } = buildFakePool()
    const app = await buildAppWithFakeAuth(pool)

    await app.inject({
      method: 'GET',
      url: '/agents/me',
      headers: { 'x-haven-mcp-tool': 'haven_get_agent' },
    })

    await new Promise((r) => setImmediate(r))
    expect(queries.length).toBe(0)

    await app.close()
  })
})
