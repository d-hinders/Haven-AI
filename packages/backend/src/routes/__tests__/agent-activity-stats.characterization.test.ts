/**
 * Characterization tests for the agent-activity statements `agent-activity.
 * test.ts` never reaches (#1167).
 *
 * The existing suite covers the two activity feeds' payment joins. Untouched
 * before this file, and all of it about to move into
 * `infra/repositories/agent-activity.ts`:
 *
 *  - the whole `GET /:id/stats` route — its ownership check plus the two
 *    spend aggregates (all-time, and today over the caller's local day, #3977);
 *  - the 404 branch both `/:id/*` routes take when the ownership check finds
 *    no row, and the fact that it short-circuits before any further read;
 *  - the `agent_tool_invocations` audit rows, answered empty everywhere else;
 *  - `GET /feed`'s early return when the user owns no agents, which must skip
 *    every downstream read.
 *
 * Written against the UNCHANGED routes and passing before the extraction.
 *
 * #2055 (epic #1440, #2021 readability waiver): `approval_requests` is
 * dropped — `countPendingApprovalsForAgent` / `countActionableApprovalsForUser`
 * are gone, `pending_approvals` is hardcoded 0 in both the stats and feed
 * responses (the wire field survives for compatibility), and neither route
 * queries `approval_requests` at all any more. The `isUserApprovalCount` /
 * `isAgentApprovalCount` SQL-shape matchers this file used to pin those
 * counts are gone with the queries they matched.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { expectMatchesSpec } from '../../openapi/response-shape.js'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'

const mockQuery = vi.fn()

vi.mock('../../db.js', () => ({
  default: { query: (...args: unknown[]) => mockQuery(...args) },
}))

// #3824: the payment rows are priced at serve time through the CoinGecko
// read — a collaborator, stubbed here so the harness never reaches the
// network and the approx figures are deterministic.
vi.mock('../../infra/prices.js', () => ({
  getTokenPrice: async () => ({ usd: 1, eur: 0.9, sek: 10.76 }),
}))

import agentActivityRoutes from '../agent-activity.js'

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
    /** Dispatches the two spend aggregates apart by their time predicate. */
    function installStatsMock(rows: {
      allTime?: unknown[]
      today?: unknown[]
      agentFound?: boolean
    } = {}) {
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT id FROM agents')) {
          return { rows: rows.agentFound === false ? [] : [{ id: 'agent-1' }] }
        }
        // #3977: the today window is parameterised (`confirmed_at >= $2 AND
        // confirmed_at < $3`) — the route derives the caller's local-day
        // bounds, the SQL carries no literal date to dispatch on. #3975-style
        // dispatcher updated, not grown: the `this_week` branch is gone with
        // the query it matched.
        if (sql.includes('confirmed_at >= $2')) {
          return { rows: rows.today ?? [] }
        }
        if (sql.includes('FROM payment_intents')) {
          return { rows: rows.allTime ?? [] }
        }
        throw new Error(`Unexpected query: ${sql}`)
      })
    }

    // #2055: was "...plus the pending count", pinning a mocked non-zero
    // pending count — `countPendingApprovalsForAgent` is gone, so
    // `pending_approvals` is hardcoded 0 regardless of what the (now
    // nonexistent) query would have returned. #3977: `this_week` is gone —
    // no surface rendered it and its window covered up to 8 calendar days.
    it('reports all-time and today totals, pending_approvals hardcoded 0', async () => {
      installStatsMock({
        allTime: [{ token_symbol: 'USDC', total_spent: '12.50', tx_count: '5' }],
        today: [{ token_symbol: 'USDC', total_spent: '2.50', tx_count: '1' }],
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
        pending_approvals: 0,
      })
      expectMatchesSpec('GET', '/agent-activity/{id}/stats', response.json())
      expect(mockQuery.mock.calls.some(([sql]) => /approval_requests/i.test(String(sql)))).toBe(false)
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
        expect(call[1][0]).toBe('agent-1')
      }
      // #3977: the today window rides as SQL parameters, scoped to the same
      // agent — the local-day bounds the route derived, not a session-timezone
      // literal inside the SQL.
      expect(callsMatching('confirmed_at >= $2')[0][1][0]).toBe('agent-1')
    })

    it('refuses an invalid tz with 400 before any read', async () => {
      installStatsMock({})

      const response = await app.inject({
        method: 'GET',
        url: '/agent-activity/agent-1/stats?tz=Mars%2FOlympus',
        headers: auth(),
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe('unsupported tz')
      expect(mockQuery).not.toHaveBeenCalled()
    })

    /**
     * #3977: the route takes an injectable clock, so the bounds can be pinned
     * exactly — these three pins are the whole local-day contract:
     * no `tz` → the UTC day; `Europe/Stockholm` → the zone's own day, in
     * winter (CET, +01:00) and summer (CEST, +02:00). A session-level
     * `SET TIME ZONE` could never produce these — the bounds travel as
     * parameters from the route's clock.
     */
    async function injectWithClock(nowIso: string, url: string): Promise<ReturnType<FastifyInstance['inject']>> {
      const clockApp = Fastify({ logger: false })
      await clockApp.register(fastifyJwt, { secret: 'test-secret' })
      await clockApp.register(agentActivityRoutes, {
        prefix: '/agent-activity',
        now: () => new Date(nowIso),
      })
      const clockToken = clockApp.jwt.sign({ sub: 'user-1', email: 'ada@example.com' })
      const response = await clockApp.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${clockToken}` },
      })
      await clockApp.close()
      return response
    }

    it('passes the UTC day bounds as parameters when no tz is sent', async () => {
      installStatsMock({})

      await injectWithClock('2026-05-08T11:50:00Z', '/agent-activity/agent-1/stats')

      expect(callsMatching('confirmed_at >= $2')[0][1]).toEqual([
        'agent-1',
        '2026-05-08T00:00:00.000Z',
        '2026-05-09T00:00:00.000Z',
      ])
    })

    it('cuts today on the Europe/Stockholm local day from the injected clock (winter)', async () => {
      installStatsMock({})

      // 2026-03-08T22:30Z is 2026-03-08 23:30 CET — local day 2026-03-08,
      // which starts and ends at 23:00Z.
      await injectWithClock(
        '2026-03-08T22:30:00Z',
        '/agent-activity/agent-1/stats?tz=Europe%2FStockholm',
      )

      expect(callsMatching('confirmed_at >= $2')[0][1]).toEqual([
        'agent-1',
        '2026-03-07T23:00:00.000Z',
        '2026-03-08T23:00:00.000Z',
      ])
    })

    it('cuts today on the Europe/Stockholm local day from the injected clock (summer)', async () => {
      installStatsMock({})

      // 2026-07-08T22:30Z is 2026-07-09 00:30 CEST — the local day is already
      // the 9th, starting at 22:00Z the evening before: a payment confirmed
      // 00:30 local counts in the 9th's "today" (#3977).
      await injectWithClock(
        '2026-07-08T22:30:00Z',
        '/agent-activity/agent-1/stats?tz=Europe%2FStockholm',
      )

      expect(callsMatching('confirmed_at >= $2')[0][1]).toEqual([
        'agent-1',
        '2026-07-08T22:00:00.000Z',
        '2026-07-09T22:00:00.000Z',
      ])
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
      // The mcp_tool_call branch of the documented oneOf (#1446).
      expectMatchesSpec('GET', '/agent-activity/{id}/activity', body)
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

      // #2055: no more `FROM approval_requests ar` read — payments + tool
      // invocations only.
      for (const pattern of [
        'FROM payment_intents pi',
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

    // #2055: was "...and counts pending approvals for the user" — pinning a
    // mocked non-zero count. `countActionableApprovalsForUser` is gone, so
    // `pending_approvals` is hardcoded 0.
    it('labels tool invocations with their agent name, pending_approvals hardcoded 0', async () => {
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT id, name FROM agents')) {
          return { rows: [{ id: 'agent-1', name: 'Research agent' }] }
        }
        if (sql.includes('FROM payment_intents pi')) return { rows: [] }
        if (sql.includes('FROM agent_tool_invocations')) return { rows: [invocationRow()] }
        throw new Error(`Unexpected query: ${sql}`)
      })

      const body = (await app.inject({
        method: 'GET',
        url: '/agent-activity/feed',
        headers: auth(),
      })).json()

      expect(body.pending_approvals).toBe(0)
      expect(body.activity).toHaveLength(1)
      expect(body.activity[0]).toMatchObject({
        type: 'mcp_tool_call',
        agent_id: 'agent-1',
        agent_name: 'Research agent',
        tool_name: 'haven_pay',
      })
      expect(mockQuery.mock.calls.some(([sql]) => /approval_requests/i.test(String(sql)))).toBe(false)
    })

    it('falls back to "Unknown" for a row whose agent is not in the name map', async () => {
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT id, name FROM agents')) {
          return { rows: [{ id: 'agent-1', name: 'Research agent' }] }
        }
        if (sql.includes('FROM payment_intents pi')) return { rows: [] }
        if (sql.includes('FROM agent_tool_invocations')) {
          return { rows: [invocationRow({ agent_id: 'agent-gone' })] }
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
        return { rows: [] }
      })

      await app.inject({
        method: 'GET',
        url: '/agent-activity/feed?limit=10&offset=5',
        headers: auth(),
      })

      // #2055: no more `FROM approval_requests ar` read — payments + tool
      // invocations only.
      for (const pattern of [
        'FROM payment_intents pi',
        'FROM agent_tool_invocations',
      ]) {
        expect(callsMatching(pattern)[0][1], pattern).toEqual([['agent-1', 'agent-2'], 10, 5])
      }
    })
  })
})
