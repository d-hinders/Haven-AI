/**
 * Characterization tests for the agent-activity statements `agent-activity.
 * test.ts` never reaches (#1167).
 *
 * The existing suite covers the two activity feeds' payment/approval joins.
 * Untouched before this file, and all of it about to move into
 * `infra/repositories/agent-activity.ts`:
 *
 *  - the whole `GET /:id/stats` route — its ownership check plus four
 *    aggregates (all-time, today, this week, pending approvals);
 *  - the 404 branch both `/:id/*` routes take when the ownership check finds
 *    no row, and the fact that it short-circuits before any further read;
 *  - the `agent_tool_invocations` audit rows, answered empty everywhere else;
 *  - `GET /feed`'s early return when the user owns no agents, which must skip
 *    every downstream read including the pending-approval count.
 *
 * Written against the UNCHANGED routes and passing before the extraction.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'

const mockQuery = vi.fn()

vi.mock('../../db.js', () => ({
  default: { query: (...args: unknown[]) => mockQuery(...args) },
}))

import agentActivityRoutes from '../agent-activity.js'

/**
 * Match the user-scoped approval COUNT without pinning its casing or layout.
 * The literal `'SELECT COUNT(*) as count FROM approval_requests'` broke the
 * moment #1179 converged the two copies into one constant with the other
 * copy's spelling — the query was semantically identical, the string was not.
 * Match the shape instead.
 */
const isUserApprovalCount = (sql: string) =>
  /COUNT\(\*\)/i.test(sql) && /FROM\s+approval_requests\s+WHERE\s+user_id/is.test(sql)

/** The per-AGENT variant of the same count — a different question, same table. */
const isAgentApprovalCount = (sql: string) =>
  /COUNT\(\*\)/i.test(sql) && /FROM\s+approval_requests\s+WHERE\s+agent_id/is.test(sql)


function invocationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    agent_id: 'agent-1',
    tool_name: 'haven_pay',
    payment_id: 'payment-1',
    result_status: 'ok',
    next_action: null,
    error_code: null,
    status_code: 200,
    created_at: '2026-05-08T11:50:00Z',
    ...overrides,
  }
}

function callsMatching(pattern: string) {
  return mockQuery.mock.calls.filter(([sql]) => String(sql).includes(pattern))
}

/** `callsMatching` for a predicate rather than a literal fragment. */
function callsMatchingFn(predicate: (sql: string) => boolean) {
  return mockQuery.mock.calls.filter(([sql]) => predicate(String(sql)))
}

describe('agent activity stats + guards (characterization, #1167)', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(agentActivityRoutes, { prefix: '/agent-activity' })
    token = app.jwt.sign({ sub: 'user-1', email: 'ada@example.com' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockQuery.mockReset()
  })

  function auth() {
    return { authorization: `Bearer ${token}` }
  }

  describe('GET /:id/stats', () => {
    /** Dispatches the four stats aggregates apart by their time predicate. */
    function installStatsMock(rows: {
      allTime?: unknown[]
      today?: unknown[]
      week?: unknown[]
      pending?: string
      agentFound?: boolean
    } = {}) {
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT id FROM agents')) {
          return { rows: rows.agentFound === false ? [] : [{ id: 'agent-1' }] }
        }
        if (isAgentApprovalCount(sql)) {
          return { rows: [{ count: rows.pending ?? '0' }] }
        }
        if (sql.includes("created_at >= CURRENT_DATE - interval '7 days'")) {
          return { rows: rows.week ?? [] }
        }
        if (sql.includes('created_at >= CURRENT_DATE')) {
          return { rows: rows.today ?? [] }
        }
        if (sql.includes('FROM payment_intents')) {
          return { rows: rows.allTime ?? [] }
        }
        throw new Error(`Unexpected query: ${sql}`)
      })
    }

    it('reports all-time, today and this-week totals plus the pending count', async () => {
      installStatsMock({
        allTime: [{ token_symbol: 'USDC', total_spent: '12.50', tx_count: '5' }],
        today: [{ token_symbol: 'USDC', total_spent: '2.50', tx_count: '1' }],
        week: [{ token_symbol: 'USDC', total_spent: '7.00', tx_count: '3' }],
        pending: '4',
      })

      const response = await app.inject({
        method: 'GET',
        url: '/agent-activity/agent-1/stats',
        headers: auth(),
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        all_time: [{ token: 'USDC', total_spent: '12.50', tx_count: 5 }],
        today: [{ token: 'USDC', total_spent: '2.50', tx_count: 1 }],
        this_week: [{ token: 'USDC', total_spent: '7.00', tx_count: 3 }],
        pending_approvals: 4,
      })
    })

    it('returns empty buckets and a zero count when the agent has no history', async () => {
      installStatsMock({})

      const response = await app.inject({
        method: 'GET',
        url: '/agent-activity/agent-1/stats',
        headers: auth(),
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        all_time: [],
        today: [],
        this_week: [],
        pending_approvals: 0,
      })
    })

    it('reports one bucket entry per token', async () => {
      installStatsMock({
        allTime: [
          { token_symbol: 'USDC', total_spent: '12.50', tx_count: '5' },
          { token_symbol: 'EURe', total_spent: '3.00', tx_count: '2' },
        ],
      })

      const body = (await app.inject({
        method: 'GET',
        url: '/agent-activity/agent-1/stats',
        headers: auth(),
      })).json()

      expect(body.all_time).toEqual([
        { token: 'USDC', total_spent: '12.50', tx_count: 5 },
        { token: 'EURe', total_spent: '3.00', tx_count: 2 },
      ])
    })

    it('scopes the ownership check to the caller and the aggregates to the agent', async () => {
      installStatsMock({})

      await app.inject({
        method: 'GET',
        url: '/agent-activity/agent-1/stats',
        headers: auth(),
      })

      expect(callsMatching('SELECT id FROM agents')[0][1]).toEqual(['agent-1', 'user-1'])
      for (const call of callsMatching('FROM payment_intents')) {
        expect(call[1]).toEqual(['agent-1'])
      }
      expect(
        callsMatchingFn(isAgentApprovalCount)[0][1],
      ).toEqual(['agent-1'])
    })

    it("404s without reading any aggregate when the agent is not the caller's", async () => {
      installStatsMock({ agentFound: false })

      const response = await app.inject({
        method: 'GET',
        url: '/agent-activity/agent-9/stats',
        headers: auth(),
      })

      expect(response.statusCode).toBe(404)
      expect(response.json().error).toBe('Agent not found')
      expect(mockQuery).toHaveBeenCalledTimes(1)
    })

    it('returns 401 without auth', async () => {
      installStatsMock({})

      const response = await app.inject({ method: 'GET', url: '/agent-activity/agent-1/stats' })

      expect(response.statusCode).toBe(401)
      expect(mockQuery).not.toHaveBeenCalled()
    })
  })

  describe('GET /:id/activity', () => {
    it('maps agent_tool_invocations rows into mcp_tool_call entries', async () => {
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT id FROM agents')) return { rows: [{ id: 'agent-1' }] }
        if (sql.includes('FROM payment_intents pi')) return { rows: [] }
        if (sql.includes('FROM approval_requests ar')) return { rows: [] }
        if (sql.includes('FROM agent_tool_invocations')) {
          return { rows: [invocationRow({ next_action: 'retry', status_code: 402 })] }
        }
        throw new Error(`Unexpected query: ${sql}`)
      })

      const body = (await app.inject({
        method: 'GET',
        url: '/agent-activity/agent-1/activity',
        headers: auth(),
      })).json()

      expect(body.activity).toEqual([
        {
          type: 'mcp_tool_call',
          id: 'inv-1',
          tool_name: 'haven_pay',
          payment_id: 'payment-1',
          result_status: 'ok',
          next_action: 'retry',
          error_code: null,
          status_code: 402,
          created_at: '2026-05-08T11:50:00Z',
        },
      ])
    })

    it("404s without reading any activity when the agent is not the caller's", async () => {
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT id FROM agents')) return { rows: [] }
        throw new Error(`Unexpected query: ${sql}`)
      })

      const response = await app.inject({
        method: 'GET',
        url: '/agent-activity/agent-9/activity',
        headers: auth(),
      })

      expect(response.statusCode).toBe(404)
      expect(response.json().error).toBe('Agent not found')
      expect(mockQuery).toHaveBeenCalledTimes(1)
    })

    it('caps limit at 100 and passes limit/offset through to every read', async () => {
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT id FROM agents')) return { rows: [{ id: 'agent-1' }] }
        return { rows: [] }
      })

      await app.inject({
        method: 'GET',
        url: '/agent-activity/agent-1/activity?limit=500&offset=20',
        headers: auth(),
      })

      for (const pattern of [
        'FROM payment_intents pi',
        'FROM approval_requests ar',
        'FROM agent_tool_invocations',
      ]) {
        expect(callsMatching(pattern)[0][1], pattern).toEqual(['agent-1', 100, 20])
      }
    })
  })

  describe('GET /feed', () => {
    it('returns an empty feed without any downstream read when the user owns no agents', async () => {
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT id, name FROM agents')) return { rows: [] }
        throw new Error(`Unexpected query: ${sql}`)
      })

      const response = await app.inject({
        method: 'GET',
        url: '/agent-activity/feed',
        headers: auth(),
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ activity: [], pending_approvals: 0 })
      expect(mockQuery).toHaveBeenCalledTimes(1)
      expect(mockQuery.mock.calls[0][1]).toEqual(['user-1'])
    })

    it('labels tool invocations with their agent name and counts pending approvals for the user', async () => {
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT id, name FROM agents')) {
          return { rows: [{ id: 'agent-1', name: 'Research agent' }] }
        }
        if (sql.includes('FROM payment_intents pi')) return { rows: [] }
        if (sql.includes('FROM approval_requests ar')) return { rows: [] }
        if (sql.includes('FROM agent_tool_invocations')) return { rows: [invocationRow()] }
        if (isUserApprovalCount(sql)) {
          return { rows: [{ count: '3' }] }
        }
        throw new Error(`Unexpected query: ${sql}`)
      })

      const body = (await app.inject({
        method: 'GET',
        url: '/agent-activity/feed',
        headers: auth(),
      })).json()

      expect(body.pending_approvals).toBe(3)
      expect(body.activity).toHaveLength(1)
      expect(body.activity[0]).toMatchObject({
        type: 'mcp_tool_call',
        agent_id: 'agent-1',
        agent_name: 'Research agent',
        tool_name: 'haven_pay',
      })
      expect(
        callsMatchingFn(isUserApprovalCount)[0][1],
      ).toEqual(['user-1'])
    })

    it('falls back to "Unknown" for a row whose agent is not in the name map', async () => {
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT id, name FROM agents')) {
          return { rows: [{ id: 'agent-1', name: 'Research agent' }] }
        }
        if (sql.includes('FROM payment_intents pi')) return { rows: [] }
        if (sql.includes('FROM approval_requests ar')) return { rows: [] }
        if (sql.includes('FROM agent_tool_invocations')) {
          return { rows: [invocationRow({ agent_id: 'agent-gone' })] }
        }
        if (isUserApprovalCount(sql)) {
          return { rows: [{ count: '0' }] }
        }
        throw new Error(`Unexpected query: ${sql}`)
      })

      const body = (await app.inject({
        method: 'GET',
        url: '/agent-activity/feed',
        headers: auth(),
      })).json()

      expect(body.activity[0].agent_name).toBe('Unknown')
    })

    it('passes the agent id list plus limit/offset to every feed read', async () => {
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT id, name FROM agents')) {
          return { rows: [{ id: 'agent-1', name: 'A' }, { id: 'agent-2', name: 'B' }] }
        }
        if (isUserApprovalCount(sql)) {
          return { rows: [{ count: '0' }] }
        }
        return { rows: [] }
      })

      await app.inject({
        method: 'GET',
        url: '/agent-activity/feed?limit=10&offset=5',
        headers: auth(),
      })

      for (const pattern of [
        'FROM payment_intents pi',
        'FROM approval_requests ar',
        'FROM agent_tool_invocations',
      ]) {
        expect(callsMatching(pattern)[0][1], pattern).toEqual([['agent-1', 'agent-2'], 10, 5])
      }
    })
  })
})
