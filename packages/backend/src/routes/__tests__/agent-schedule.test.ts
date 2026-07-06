/**
 * #770 backend half: the dashboard schedule API. Pattern-matched DB mocks
 * (#775). The auth middleware is mocked; everything else (schedule builders,
 * Smart Sessions actions) runs REAL code so the inner txs are genuine.
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }))
vi.mock('../../db.js', () => ({ default: { query: (...a: unknown[]) => mockQuery(...a) } }))
vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: async (request: { user?: unknown }) => {
    request.user = { sub: 'user-1' }
  },
}))

const agentScheduleRoutes = (await import('../agent-schedule.js')).default
const { buildSessionSchedule } = await import('../../lib/session-schedule.js')

const AGENT_ID = '11111111-1111-1111-1111-111111111111'
const DELEGATE = '0x' + '11'.repeat(20)
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const RECIPIENT = '0x' + 'ab'.repeat(20)
const RESET_MIN = 1440 // daily

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    user_id: 'user-1',
    delegate_address: DELEGATE,
    chain_id: 84532,
    execution_rail: 'session_key',
    session_permission_id: null,
    session_schedule_from_period: null,
    session_schedule_period_count: null,
    ...overrides,
  }
}

function mockDb(opts: {
  agent?: Record<string, unknown> | null
  allowances?: unknown[]
  recipients?: unknown[]
}) {
  mockQuery.mockImplementation((sql: string) => {
    const s = String(sql)
    if (/FROM agent_recipients/.test(s)) {
      return Promise.resolve({
        rows:
          opts.recipients ??
          [{
            recipient_address: RECIPIENT,
            token_address: USDC,
            label: null,
            budget_amount: '5000000',
            allowance_amount: '5000000',
          }],
      })
    }
    if (/FROM agent_allowances/.test(s)) {
      return Promise.resolve({
        rows: opts.allowances ?? [{ token_address: USDC, reset_period_min: RESET_MIN }],
      })
    }
    if (/UPDATE agents/.test(s)) return Promise.resolve({ rows: [] })
    // owned-agent lookup
    return Promise.resolve({ rows: opts.agent === null ? [] : [opts.agent ?? agentRow()] })
  })
}

describe('agent schedule API (#770)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(agentScheduleRoutes, { prefix: '/agents' })
  })
  afterAll(async () => app.close())
  beforeEach(() => mockQuery.mockReset())

  describe('GET /agents/:id/schedule', () => {
    it('legacy-rail account: session_rail false, not enabled', async () => {
      mockDb({ agent: agentRow({ execution_rail: null }) })
      const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/schedule` })
      expect(res.json()).toEqual({ session_rail: false, enabled: false })
    })

    it('session rail without a window: enabled false', async () => {
      mockDb({})
      const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/schedule` })
      expect(res.json()).toEqual({ session_rail: true, enabled: false })
    })

    it('active window: periods_remaining counted, renewal_due at ≤2 left', async () => {
      const nowPeriod = Math.floor(Date.now() / 1000 / (RESET_MIN * 60))
      mockDb({
        agent: agentRow({
          session_schedule_from_period: nowPeriod - 8,
          session_schedule_period_count: 10, // sista period = nowPeriod+1 → 2 kvar
        }),
      })
      const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/schedule` })
      expect(res.json()).toMatchObject({
        session_rail: true,
        enabled: true,
        periods_remaining: 2,
        renewal_due: true,
      })
    })

    it('404 for someone else’s agent', async () => {
      mockDb({ agent: null })
      const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/schedule` })
      expect(res.statusCode).toBe(404)
    })
  })

  describe('POST /agents/:id/schedule/build', () => {
    it('409 when the account is not on the session rail', async () => {
      mockDb({ agent: agentRow({ execution_rail: null }) })
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/schedule/build`, payload: {},
      })
      expect(res.statusCode).toBe(409)
    })

    it('409 when there is no recipient policy to schedule', async () => {
      mockDb({ recipients: [] })
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/schedule/build`, payload: {},
      })
      expect(res.statusCode).toBe(409)
      expect(res.json().error).toMatch(/recipient/)
    })

    it('fresh schedule: ONE enable inner tx whose sessions match the real builders', async () => {
      mockDb({})
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/schedule/build`, payload: { periods: 3 },
      })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      expect(body.inner_txs).toHaveLength(1) // no old window → enable only
      expect(body.replaced).toBe(false)
      expect(body.period_count).toBe(3)
      // Bit-for-bit determinism against the production builder:
      const expected = buildSessionSchedule(
        AGENT_ID,
        {
          sessionKeyAddress: DELEGATE as `0x${string}`,
          usdcAddress: USDC as `0x${string}`,
          allowedRecipient: RECIPIENT as `0x${string}`,
          budgetAtomic: 5_000_000n,
          chainId: 84532n,
        },
        RESET_MIN,
        body.from_period,
        3,
      )
      expect(body.first_permission_id).toBe(expected.entries[0].permissionId)
      expect(body.inner_txs[0].data).toBe(expected.enablePayload.data)
    })

    it('replacement: removes the old window’s remaining sessions in the same batch', async () => {
      const nowPeriod = Math.floor(Date.now() / 1000 / (RESET_MIN * 60))
      mockDb({
        agent: agentRow({
          session_schedule_from_period: nowPeriod - 1,
          session_schedule_period_count: 4, // kvar: now, now+1, now+2 → 3 removes
        }),
      })
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/schedule/build`, payload: { periods: 2 },
      })
      const body = res.json()
      expect(body.replaced).toBe(true)
      expect(body.inner_txs).toHaveLength(4) // 3 removes + 1 enable
    })
  })

  describe('POST /agents/:id/schedule/confirm', () => {
    it('validates the window fields', async () => {
      mockDb({})
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/schedule/confirm`,
        payload: { from_period: 1, period_count: 0, first_permission_id: '0xnope' },
      })
      expect(res.statusCode).toBe(400)
    })

    it('records the window scoped to the owning user', async () => {
      mockDb({})
      const pid = `0x${'ab'.repeat(32)}`
      const res = await app.inject({
        method: 'POST', url: `/agents/${AGENT_ID}/schedule/confirm`,
        payload: { from_period: 100, period_count: 90, first_permission_id: pid },
      })
      expect(res.json()).toEqual({ recorded: true })
      const update = mockQuery.mock.calls.find((c) => /UPDATE agents/.test(String(c[0])))!
      expect(String(update[0])).toContain('user_id = $5')
      expect(update[1]).toEqual([100, 90, pid, AGENT_ID, 'user-1'])
    })
  })
})
