import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import {
  touchAgentLastSeen,
  registerAgentLastSeenHook,
  LAST_SEEN_THROTTLE_SECONDS,
  type QueryableLike,
} from '../middleware/agentAuth.js'

const AGENT_ID = '11111111-1111-1111-1111-111111111111'

interface RecordedQuery {
  text: string
  values: unknown[]
}

function buildFakePool(): { pool: QueryableLike; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = []
  const pool: QueryableLike = {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      queries.push({ text, values })
      return { rows: [], rowCount: 1 }
    }),
  }
  return { pool, queries }
}

describe('touchAgentLastSeen', () => {
  it('issues a throttled UPDATE scoped to the agent id', async () => {
    const { pool, queries } = buildFakePool()

    await touchAgentLastSeen(AGENT_ID, pool)

    expect(queries).toHaveLength(1)
    const [q] = queries
    expect(q.text).toContain('UPDATE agents')
    expect(q.text).toContain('last_seen_at = NOW()')
    // Throttle clause: only write when stale, using the exported window.
    expect(q.text).toContain('last_seen_at IS NULL')
    expect(q.text).toContain(`INTERVAL '${LAST_SEEN_THROTTLE_SECONDS} seconds'`)
    expect(q.values).toEqual([AGENT_ID])
  })

  it('is best-effort: a DB failure never rejects', async () => {
    const pool: QueryableLike = {
      query: vi.fn(async () => {
        throw new Error('db down')
      }),
    }

    await expect(touchAgentLastSeen(AGENT_ID, pool)).resolves.toBeUndefined()
  })
})

describe('registerAgentLastSeenHook', () => {
  async function buildApp(pool: QueryableLike, withAgent: boolean) {
    const app = Fastify({ logger: false })
    // Stand-in for agentAuthMiddleware: decorate request.agent when asked.
    app.addHook('onRequest', async (request) => {
      if (withAgent) {
        request.agent = {
          id: AGENT_ID,
          user_id: '22222222-2222-2222-2222-222222222222',
          name: 'Test agent',
          delegate_address: '0xdead',
          safe_address: '0xsafe',
          chain_id: 100,
          status: 'active',
        }
      }
    })
    registerAgentLastSeenHook(app, pool)
    app.get('/thing', async () => ({ ok: true }))
    await app.ready()
    return app
  }

  it('touches last_seen after an authenticated agent request', async () => {
    const { pool, queries } = buildFakePool()
    const app = await buildApp(pool, true)

    const res = await app.inject({ method: 'GET', url: '/thing' })
    expect(res.statusCode).toBe(200)

    expect(queries).toHaveLength(1)
    expect(queries[0].text).toContain('UPDATE agents')
    expect(queries[0].values).toEqual([AGENT_ID])

    await app.close()
  })

  it('does nothing when the request is not an authenticated agent', async () => {
    const { pool, queries } = buildFakePool()
    const app = await buildApp(pool, false)

    await app.inject({ method: 'GET', url: '/thing' })
    expect(queries).toHaveLength(0)

    await app.close()
  })
})
