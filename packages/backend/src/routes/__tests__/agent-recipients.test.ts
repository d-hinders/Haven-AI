/**
 * #796 recipient CRUD. Pattern-matched DB mocks (#775); auth mocked; the
 * validation and SQL shapes run real.
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

const agentRecipientRoutes = (await import('../agent-recipients.js')).default

const AGENT_ID = '11111111-1111-1111-1111-111111111111'
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const RECIPIENT = '0x' + 'ab'.repeat(20)

function mockDb(opts: { owns?: boolean; rows?: unknown[]; deleted?: number; scheduleEnabled?: boolean } = {}) {
  mockQuery.mockImplementation((sql: string) => {
    const s = String(sql)
    if (/SELECT id FROM agents/.test(s)) {
      return Promise.resolve({ rows: opts.owns === false ? [] : [{ id: AGENT_ID }] })
    }
    if (/INSERT INTO agent_recipients/.test(s)) {
      return Promise.resolve({ rows: [{ id: 'row-1' }] })
    }
    if (/DELETE FROM agent_recipients/.test(s)) {
      return Promise.resolve({ rows: Array((opts.deleted ?? 1)).fill({ id: 'row-1' }) })
    }
    if (/session_schedule_from_period/.test(s)) {
      return Promise.resolve({
        rows: [{
          execution_rail: opts.scheduleEnabled ? 'session_key' : null,
          session_schedule_from_period: opts.scheduleEnabled ? 100 : null,
        }],
      })
    }
    if (/FROM agent_recipients/.test(s)) {
      return Promise.resolve({ rows: opts.rows ?? [] })
    }
    return Promise.resolve({ rows: [] })
  })
}

describe('agent recipient CRUD (#796)', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(agentRecipientRoutes, { prefix: '/agents' })
  })
  afterAll(async () => app.close())
  beforeEach(() => mockQuery.mockReset())

  it('GET lists recipients with budget inheritance resolved', async () => {
    mockDb({
      rows: [
        { recipient_address: RECIPIENT, token_address: USDC, label: 'API-leverantör', budget_amount: null, allowance_amount: '5000000' },
        { recipient_address: '0x' + 'cd'.repeat(20), token_address: USDC, label: null, budget_amount: '2000000', allowance_amount: '5000000' },
      ],
    })
    const res = await app.inject({ method: 'GET', url: `/agents/${AGENT_ID}/recipients` })
    const { recipients } = res.json()
    expect(recipients[0]).toMatchObject({ effective_budget: '5000000', inherits_allowance: true })
    expect(recipients[1]).toMatchObject({ effective_budget: '2000000', inherits_allowance: false })
  })

  it('404s on someone else’s agent for every verb', async () => {
    mockDb({ owns: false })
    for (const [method, url] of [
      ['GET', `/agents/${AGENT_ID}/recipients`],
      ['POST', `/agents/${AGENT_ID}/recipients`],
      ['DELETE', `/agents/${AGENT_ID}/recipients/${RECIPIENT}`],
    ] as const) {
      const res = await app.inject({ method, url, payload: method === 'POST' ? {} : undefined })
      expect(res.statusCode).toBe(404)
    }
  })

  it('POST upserts on the (agent, token, recipient) key, lowercased', async () => {
    mockDb({})
    const res = await app.inject({
      method: 'POST',
      url: `/agents/${AGENT_ID}/recipients`,
      payload: { recipient_address: RECIPIENT.toUpperCase().replace('0X', '0x'), token_address: USDC, label: 'Leverantör' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ applied_on_chain: false })
    const insert = mockQuery.mock.calls.find((c) => /INSERT INTO agent_recipients/.test(String(c[0])))!
    expect(String(insert[0])).toContain('ON CONFLICT (agent_id, token_address, recipient_address)')
    expect(String(insert[0])).toContain('LOWER($2)')
  })

  it.each([
    ['bad recipient', { recipient_address: 'nope', token_address: USDC }],
    ['bad token', { recipient_address: RECIPIENT, token_address: '0x123' }],
    ['zero budget', { recipient_address: RECIPIENT, token_address: USDC, budget_amount: '0' }],
    ['decimal budget', { recipient_address: RECIPIENT, token_address: USDC, budget_amount: '1.5' }],
    ['negative budget', { recipient_address: RECIPIENT, token_address: USDC, budget_amount: '-1' }],
    ['uint96 overflow', { recipient_address: RECIPIENT, token_address: USDC, budget_amount: String(1n << 96n) }],
  ])('POST rejects %s', async (_label, payload) => {
    mockDb({})
    const res = await app.inject({ method: 'POST', url: `/agents/${AGENT_ID}/recipients`, payload })
    expect(res.statusCode).toBe(400)
  })

  it('DELETE removes and reports the on-chain caveat flag', async () => {
    mockDb({ deleted: 2 })
    const res = await app.inject({ method: 'DELETE', url: `/agents/${AGENT_ID}/recipients/${RECIPIENT}` })
    expect(res.json()).toMatchObject({ removed: 2, applied_on_chain: false })
  })

  it('mutations carry the schedule warning when a budget schedule is enabled (#802)', async () => {
    mockDb({ scheduleEnabled: true })
    const post = await app.inject({
      method: 'POST',
      url: `/agents/${AGENT_ID}/recipients`,
      payload: { recipient_address: RECIPIENT, token_address: USDC },
    })
    expect(post.json().schedule_warning).toMatch(/budget signature/)
    const del = await app.inject({ method: 'DELETE', url: `/agents/${AGENT_ID}/recipients/${RECIPIENT}` })
    expect(del.json().schedule_warning).toMatch(/budget signature/)
    // ... and stays null without a schedule:
    mockDb({ scheduleEnabled: false })
    const post2 = await app.inject({
      method: 'POST',
      url: `/agents/${AGENT_ID}/recipients`,
      payload: { recipient_address: RECIPIENT, token_address: USDC },
    })
    expect(post2.json().schedule_warning).toBeNull()
  })

  it('DELETE 404s when nothing matched', async () => {
    mockDb({ deleted: 0 })
    const res = await app.inject({ method: 'DELETE', url: `/agents/${AGENT_ID}/recipients/${RECIPIENT}` })
    expect(res.statusCode).toBe(404)
  })
})
