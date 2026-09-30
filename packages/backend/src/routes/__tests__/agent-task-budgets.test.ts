// db-mock-exempt: route-level handler test (ownership scoping, response shape) — DB behaviour is proven in infra/repositories/__tests__/task-budgets.test.ts on the real-DB harness
/**
 * #3329 §3 — owner-facing `GET /agents/:id/task-budgets`. Pattern-matched DB
 * mocks (#775), same convention as `agent-delegations.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { mockQuery, mockReadSpent } = vi.hoisted(() => ({ mockQuery: vi.fn(), mockReadSpent: vi.fn() }))
vi.mock('../../db.js', () => ({
  default: { query: (...a: unknown[]) => mockQuery(...a) },
}))
vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: async (request: { user?: unknown }) => {
    request.user = { sub: 'user-1' }
  },
}))
// #3501: the GET enriches open rows with the live enforcer spent read — the
// chain seam is mocked here, the degrade arithmetic runs REAL (the module
// boundary `task-budget-cap.ts` owns it).
vi.mock('../../modules/task-budgets/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../modules/task-budgets/index.js')>()
  return { ...actual, readTaskBudgetSpentForReport: (...a: unknown[]) => mockReadSpent(...a) }
})

const agentTaskBudgetsOwnerRoutes = (await import('../agent-task-budgets.js')).default

const AGENT_ID = '11111111-1111-1111-1111-111111111111'

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    agent_id: AGENT_ID,
    status: 'active',
    delegate_address: '0x' + 'bb'.repeat(20),
    chain_id: 84532,
    treasury_address: '0x' + 'aa'.repeat(20),
    account_type: 'delegator_hybrid',
    ...overrides,
  }
}

describe('owner task-budgets read (#3329)', () => {
  let app: FastifyInstance
  beforeEach(async () => {
    mockQuery.mockReset()
    mockReadSpent.mockReset()
    mockReadSpent.mockResolvedValue({ spentAtomic: '500000', remainingAtomic: '500000' })
    app = Fastify({ logger: false })
    await app.register(agentTaskBudgetsOwnerRoutes, { prefix: '/agents' })
  })

  it('404s when the agent is not owned by the caller', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/FROM agents/.test(String(sql))) return Promise.resolve({ rows: [] })
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/task-budgets` })
    expect(res.statusCode).toBe(404)
  })

  it('lists the owned agent task budgets', async () => {
    mockQuery.mockImplementation((sql: string) => {
      const s = String(sql)
      if (/FROM agent_task_budgets tb/.test(s)) {
        return Promise.resolve({
          rows: [
            {
              id: 'tb-1',
              agent_id: AGENT_ID,
              chain_id: 84532,
              token_address: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
              recipient_address: null,
              parent_delegation_hash: `0x${'ab'.repeat(32)}`,
              delegation_hash: `0x${'cd'.repeat(32)}`,
              label: 'Test',
              max_atomic: '1000000',
              status: 'open',
              expires_at: String(Math.floor(Date.now() / 1000) + 3600),
              prepared_user_op: null,
              close_tx_hash: null,
              created_at: '2026-09-25T00:00:00.000Z',
              updated_at: '2026-09-25T00:00:00.000Z',
              opened_at: '2026-09-25T00:00:00.000Z',
              closed_at: null,
            },
          ],
        })
      }
      if (/FROM agents/.test(s)) return Promise.resolve({ rows: [agentRow()] })
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/task-budgets` })
    expect(res.statusCode).toBe(200)
    expect(res.json().task_budgets).toHaveLength(1)
    expect(res.json().task_budgets[0].status).toBe('open')
  })

  it('#3501: an open row carries the on-chain spent/remaining figures, atomic and display', async () => {
    mockQuery.mockImplementation((sql: string) => {
      const s = String(sql)
      if (/FROM agent_task_budgets tb/.test(s)) {
        return Promise.resolve({
          rows: [
            {
              id: 'tb-1',
              agent_id: AGENT_ID,
              chain_id: 84532,
              token_address: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
              recipient_address: null,
              parent_delegation_hash: `0x${'ab'.repeat(32)}`,
              delegation_hash: `0x${'cd'.repeat(32)}`,
              label: 'Test',
              max_atomic: '1500',
              status: 'open',
              expires_at: String(Math.floor(Date.now() / 1000) + 3600),
              prepared_user_op: null,
              close_tx_hash: null,
              created_at: '2026-09-25T00:00:00.000Z',
              updated_at: '2026-09-25T00:00:00.000Z',
              opened_at: '2026-09-25T00:00:00.000Z',
              closed_at: null,
            },
          ],
        })
      }
      if (/FROM agents/.test(s)) return Promise.resolve({ rows: [agentRow()] })
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/task-budgets` })
    expect(res.statusCode).toBe(200)
    const row = res.json().task_budgets[0]
    expect(row.spent_atomic).toBe('500000')
    expect(row.remaining_atomic).toBe('500000')
    expect(row.remaining_is_from_chain).toBe(true)
    expect(row.spent_display).toBe('0.50 USDC')
    expect(row.remaining_display).toBe('0.50 USDC')
  })

  it('#3501: a failed chain read degrades to null figures with remaining_is_from_chain false — never the full cap as remaining', async () => {
    mockReadSpent.mockResolvedValue({ spentAtomic: null, remainingAtomic: null })
    mockQuery.mockImplementation((sql: string) => {
      const s = String(sql)
      if (/FROM agent_task_budgets tb/.test(s)) {
        return Promise.resolve({
          rows: [
            {
              id: 'tb-1',
              agent_id: AGENT_ID,
              chain_id: 84532,
              token_address: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
              recipient_address: null,
              parent_delegation_hash: `0x${'ab'.repeat(32)}`,
              delegation_hash: `0x${'cd'.repeat(32)}`,
              label: 'Test',
              max_atomic: '1500',
              status: 'open',
              expires_at: String(Math.floor(Date.now() / 1000) + 3600),
              prepared_user_op: null,
              close_tx_hash: null,
              created_at: '2026-09-25T00:00:00.000Z',
              updated_at: '2026-09-25T00:00:00.000Z',
              opened_at: '2026-09-25T00:00:00.000Z',
              closed_at: null,
            },
          ],
        })
      }
      if (/FROM agents/.test(s)) return Promise.resolve({ rows: [agentRow()] })
      return Promise.resolve({ rows: [] })
    })
    const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/task-budgets` })
    expect(res.statusCode).toBe(200)
    const row = res.json().task_budgets[0]
    expect(row.spent_atomic).toBeNull()
    expect(row.remaining_atomic).toBeNull()
    expect(row.spent_display).toBeNull()
    expect(row.remaining_display).toBeNull()
    expect(row.remaining_is_from_chain).toBe(false)
    expect(row.remaining_atomic).not.toBe('1500')
  })
})
