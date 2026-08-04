import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import agentRoutes from '../agents.js'

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
}))

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
    // The create path opens a transaction client; route its queries to the same
    // mock so BEGIN/INSERT/COMMIT/ROLLBACK are observable in mockQuery.calls.
    connect: async () => ({
      query: (...args: unknown[]) => mockQuery(...args),
      release: () => {},
    }),
  },
}))

// The passport module is mocked so the creation-path guarantee can be tested
// directly: a passport problem must never fail, delay, or roll back the agent.
const { mockRequestPassport, mockIssueBestEffort } = vi.hoisted(() => ({
  mockRequestPassport: vi.fn(),
  mockIssueBestEffort: vi.fn(),
}))
vi.mock('../../lib/passport/index.js', () => ({
  requestPassport: (...a: unknown[]) => mockRequestPassport(...a),
  issuePassportBestEffort: (...a: unknown[]) => mockIssueBestEffort(...a),
  PASSPORT_CHAIN_IDS: new Set([84532]),
}))

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: async (request: { user?: { sub: string } }) => {
    request.user = { sub: 'user-1' }
  },
}))

const VALID_DELEGATE = '0x1111111111111111111111111111111111111111'
const VALID_TOKEN = '0x3333333333333333333333333333333333333333'
const UINT96_OVERFLOW = (1n << 96n).toString()

const VALID_ALLOWANCE = {
  token_address: VALID_TOKEN,
  token_symbol: 'USDC',
  allowance_amount: '25000000',
  reset_period_min: 1440,
}

describe('agent routes', () => {
  beforeEach(() => {
    mockQuery.mockReset()
    mockRequestPassport.mockReset().mockResolvedValue(true)
    mockIssueBestEffort.mockReset()
  })

  it('fetches one agent with allowances and null mcp_last_seen_at when never called', async () => {
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
          mcp_last_seen_at: null,
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
      mcp_last_seen_at: null,
    })
    // #1069: pending_approval agents are SURFACED, not hidden — an abandoned
    // setup used to leave the user with "Agents 0" and no route back to an
    // agent that exists. The list/detail include them; the UI badges them
    // 'Needs setup' and links to the page where the budget grant activates.
    expect(String(mockQuery.mock.calls[0][0])).not.toContain("pending_approval")
    expect(mockQuery.mock.calls[0][1]).toEqual(['user-1', 'agent-1'])

    await app.close()
  })

  it('returns mcp_last_seen_at when agent has made tool calls', async () => {
    const app = Fastify({ logger: false })
    await app.register(agentRoutes, { prefix: '/agents' })

    const lastSeenAt = '2026-05-28T14:00:00.000Z'
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
          mcp_last_seen_at: lastSeenAt,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })

    const response = await app.inject({
      method: 'GET',
      url: '/agents/agent-1',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().mcp_last_seen_at).toBe(lastSeenAt)
    // #1069: pending_approval agents are SURFACED, not hidden — an abandoned
    // setup used to leave the user with "Agents 0" and no route back to an
    // agent that exists. The list/detail include them; the UI badges them
    // 'Needs setup' and links to the page where the budget grant activates.
    expect(String(mockQuery.mock.calls[0][0])).not.toContain("pending_approval")

    await app.close()
  })

  it('excludes pending Connect Agent 2 setups from the legacy agent list', async () => {
    const app = Fastify({ logger: false })
    await app.register(agentRoutes, { prefix: '/agents' })

    mockQuery.mockResolvedValueOnce({ rows: [] })

    const response = await app.inject({
      method: 'GET',
      url: '/agents',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ agents: [] })
    // #1069: pending_approval agents are SURFACED, not hidden — an abandoned
    // setup used to leave the user with "Agents 0" and no route back to an
    // agent that exists. The list/detail include them; the UI badges them
    // 'Needs setup' and links to the page where the budget grant activates.
    expect(String(mockQuery.mock.calls[0][0])).not.toContain("pending_approval")

    await app.close()
  })

  it.each([
    ['bad token address', { ...VALID_ALLOWANCE, token_address: 'not-an-address' }, /Valid token address/],
    ['blank token symbol', { ...VALID_ALLOWANCE, token_symbol: '   ' }, /Token symbol is required/],
    ['overlong token symbol', { ...VALID_ALLOWANCE, token_symbol: 'A'.repeat(21) }, /20 characters or fewer/],
    ['zero allowance amount', { ...VALID_ALLOWANCE, allowance_amount: '0' }, /positive decimal atomic amount/],
    ['signed allowance amount', { ...VALID_ALLOWANCE, allowance_amount: '+1' }, /positive decimal atomic amount/],
    ['scientific allowance amount', { ...VALID_ALLOWANCE, allowance_amount: '1e6' }, /positive decimal atomic amount/],
    ['uint96 overflow allowance amount', { ...VALID_ALLOWANCE, allowance_amount: UINT96_OVERFLOW }, /uint96/],
    ['negative reset period', { ...VALID_ALLOWANCE, reset_period_min: -1 }, /0 to 65535/],
    ['uint16 overflow reset period', { ...VALID_ALLOWANCE, reset_period_min: 65536 }, /0 to 65535/],
  ])('rejects invalid create-agent allowance input: %s', async (_label, allowance, errorPattern) => {
    const app = Fastify({ logger: false })
    await app.register(agentRoutes, { prefix: '/agents' })

    const response = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'Research Agent',
        delegate_address: VALID_DELEGATE,
        allowances: [allowance],
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toMatch(errorPattern)
    expect(mockQuery).not.toHaveBeenCalled()

    await app.close()
  })

  it('rejects duplicate create-agent allowances after token address normalization', async () => {
    const app = Fastify({ logger: false })
    await app.register(agentRoutes, { prefix: '/agents' })

    const response = await app.inject({
      method: 'POST',
      url: '/agents',
      payload: {
        name: 'Research Agent',
        delegate_address: VALID_DELEGATE,
        allowances: [
          VALID_ALLOWANCE,
          {
            ...VALID_ALLOWANCE,
            token_address: VALID_TOKEN.toUpperCase().replace('X', 'x'),
            allowance_amount: '50000000',
          },
        ],
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toMatch(/Duplicate token/)
    expect(mockQuery).not.toHaveBeenCalled()

    await app.close()
  })

  it('blocks allowance updates while Connect Agent 2 setup is pending wallet approval', async () => {
    const app = Fastify({ logger: false })
    await app.register(agentRoutes, { prefix: '/agents' })

    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'agent-1',
        status: 'pending_approval',
      }],
    })

    const response = await app.inject({
      method: 'POST',
      url: '/agents/agent-1/allowances',
      payload: {
        token_address: '0x3333333333333333333333333333333333333333',
        token_symbol: 'USDC',
        allowance_amount: '25000000',
        reset_period_min: 1440,
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toMatch(/pending wallet approval/)
    expect(mockQuery).toHaveBeenCalledTimes(1)

    await app.close()
  })

  it.each([
    ['bad token address', { ...VALID_ALLOWANCE, token_address: 'not-an-address' }, /Valid token address/],
    ['zero allowance amount', { ...VALID_ALLOWANCE, allowance_amount: '0' }, /positive decimal atomic amount/],
    ['hex allowance amount', { ...VALID_ALLOWANCE, allowance_amount: '0x10' }, /positive decimal atomic amount/],
    ['uint96 overflow allowance amount', { ...VALID_ALLOWANCE, allowance_amount: UINT96_OVERFLOW }, /uint96/],
    ['fractional reset period', { ...VALID_ALLOWANCE, reset_period_min: 1.5 }, /0 to 65535/],
    ['uint16 overflow reset period', { ...VALID_ALLOWANCE, reset_period_min: 65536 }, /0 to 65535/],
  ])('rejects invalid allowance update input before agent lookup: %s', async (_label, allowance, errorPattern) => {
    const app = Fastify({ logger: false })
    await app.register(agentRoutes, { prefix: '/agents' })

    const response = await app.inject({
      method: 'POST',
      url: '/agents/agent-1/allowances',
      payload: allowance,
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toMatch(errorPattern)
    expect(mockQuery).not.toHaveBeenCalled()

    await app.close()
  })

  it('normalizes allowance update inputs before writing the mirror row', async () => {
    const app = Fastify({ logger: false })
    await app.register(agentRoutes, { prefix: '/agents' })

    mockQuery
      .mockResolvedValueOnce({
        rows: [{
          id: 'agent-1',
          status: 'active',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'allowance-1',
          agent_id: 'agent-1',
          token_address: VALID_TOKEN,
          token_symbol: 'USDC',
          allowance_amount: '25000000',
          reset_period_min: 1440,
        }],
      })
      .mockResolvedValueOnce({ rows: [] }) // schedule-state lookup (#802) — no schedule

    const response = await app.inject({
      method: 'POST',
      url: '/agents/agent-1/allowances',
      payload: {
        token_address: '0x3333333333333333333333333333333333333333'.toUpperCase().replace('X', 'x'),
        token_symbol: '  USDC  ',
        allowance_amount: '00025000000',
        reset_period_min: 1440,
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      token_address: VALID_TOKEN,
      token_symbol: 'USDC',
      allowance_amount: '25000000',
    })
    expect(mockQuery.mock.calls[1][1]).toEqual([
      'agent-1',
      VALID_TOKEN,
      'USDC',
      '25000000',
      1440,
    ])

    await app.close()
  })

  it('blocks allowance updates for revoked agents', async () => {
    const app = Fastify({ logger: false })
    await app.register(agentRoutes, { prefix: '/agents' })

    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'agent-1',
        status: 'revoked',
      }],
    })

    const response = await app.inject({
      method: 'POST',
      url: '/agents/agent-1/allowances',
      payload: VALID_ALLOWANCE,
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toMatch(/Revoked agent/)
    expect(mockQuery).toHaveBeenCalledTimes(1)

    await app.close()
  })

  it('blocks allowance deletes while Connect Agent 2 setup is pending wallet approval', async () => {
    const app = Fastify({ logger: false })
    await app.register(agentRoutes, { prefix: '/agents' })

    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'agent-1',
        status: 'pending_approval',
      }],
    })

    const response = await app.inject({
      method: 'DELETE',
      url: '/agents/agent-1/allowances/0x3333333333333333333333333333333333333333',
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toMatch(/pending wallet approval/)
    expect(mockQuery).toHaveBeenCalledTimes(1)

    await app.close()
  })

  it('rejects invalid allowance delete token addresses before agent lookup', async () => {
    const app = Fastify({ logger: false })
    await app.register(agentRoutes, { prefix: '/agents' })

    const response = await app.inject({
      method: 'DELETE',
      url: '/agents/agent-1/allowances/not-an-address',
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toMatch(/Valid token address/)
    expect(mockQuery).not.toHaveBeenCalled()

    await app.close()
  })

  it('blocks allowance deletes for revoked agents', async () => {
    const app = Fastify({ logger: false })
    await app.register(agentRoutes, { prefix: '/agents' })

    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'agent-1',
        status: 'revoked',
      }],
    })

    const response = await app.inject({
      method: 'DELETE',
      url: `/agents/agent-1/allowances/${VALID_TOKEN}`,
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toMatch(/Revoked agent/)
    expect(mockQuery).toHaveBeenCalledTimes(1)

    await app.close()
  })
})

/**
 * The headline acceptance criterion of #972: creating an agent must succeed
 * even when the passport path fails. Reviewer finding #4 — the code was correct
 * on manual read but had ZERO regression protection, so nothing would catch a
 * refactor that moved this before COMMIT or let the error escape.
 */
describe('agent creation — passport opt-in never breaks creation', () => {
  // This block is a sibling of `describe('agent routes')`, so it needs its own
  // reset — the other block's beforeEach does not reach here.
  beforeEach(() => {
    mockQuery.mockReset()
    mockRequestPassport.mockReset().mockResolvedValue(true)
    mockIssueBestEffort.mockReset()
  })

  /** Mock the create path's queries: safe lookup, BEGIN, INSERT, safe info, COMMIT. */
  function mockCreateFlow() {
    mockQuery.mockImplementation(async (sql: string) => {
      if (/SELECT id FROM user_safes/.test(sql)) return { rows: [{ id: 'safe-1' }] }
      if (/INSERT INTO agents/.test(sql)) {
        return { rows: [{ id: 'agent-1', name: 'A', description: null, delegate_address: VALID_DELEGATE, safe_id: 'safe-1', api_key_prefix: 'sk_a', status: 'active', created_at: '2026-07-26T00:00:00.000Z', mcp_last_seen_at: null }] }
      }
      if (/SELECT safe_address, name AS safe_name/.test(sql)) {
        return { rows: [{ safe_address: '0x2222222222222222222222222222222222222222', safe_name: 'Main', safe_chain_id: 84532 }] }
      }
      return { rows: [] }
    })
  }

  const body = { name: 'A', delegate_address: VALID_DELEGATE, safe_id: 'safe-1', issue_passport: true }

  it('returns 201 even when requestPassport THROWS', async () => {
    const app = Fastify({ logger: false })
    await app.register(agentRoutes, { prefix: '/agents' })
    mockCreateFlow()
    mockRequestPassport.mockRejectedValue(new Error('passport table missing'))

    const res = await app.inject({ method: 'POST', url: '/agents', payload: body })
    expect(res.statusCode).toBe(201)
    expect(res.json().id).toBe('agent-1')
    // Never rolled back.
    expect(mockQuery.mock.calls.some(([sql]) => /ROLLBACK/.test(String(sql)))).toBe(false)
  })

  it('returns 201 even when issuePassportBestEffort throws synchronously', async () => {
    const app = Fastify({ logger: false })
    await app.register(agentRoutes, { prefix: '/agents' })
    mockCreateFlow()
    mockIssueBestEffort.mockImplementation(() => { throw new Error('boom') })

    const res = await app.inject({ method: 'POST', url: '/agents', payload: body })
    expect(res.statusCode).toBe(201)
    expect(mockQuery.mock.calls.some(([sql]) => /ROLLBACK/.test(String(sql)))).toBe(false)
  })

  it('does not request a passport unless explicitly opted in', async () => {
    const app = Fastify({ logger: false })
    await app.register(agentRoutes, { prefix: '/agents' })
    mockCreateFlow()

    const res = await app.inject({
      method: 'POST', url: '/agents',
      payload: { name: 'A', delegate_address: VALID_DELEGATE, safe_id: 'safe-1' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().passport_requested).toBe(false)
    expect(mockRequestPassport).not.toHaveBeenCalled()
  })

  it('skips the opt-in on an unsupported chain instead of creating a doomed row', async () => {
    const app = Fastify({ logger: false })
    await app.register(agentRoutes, { prefix: '/agents' })
    mockQuery.mockImplementation(async (sql: string) => {
      if (/SELECT id FROM user_safes/.test(sql)) return { rows: [{ id: 'safe-1' }] }
      if (/INSERT INTO agents/.test(sql)) return { rows: [{ id: 'agent-1', name: 'A', description: null, delegate_address: VALID_DELEGATE, safe_id: 'safe-1', api_key_prefix: 'sk_a', status: 'active', created_at: '2026-07-26T00:00:00.000Z', mcp_last_seen_at: null }] }
      if (/SELECT safe_address, name AS safe_name/.test(sql)) {
        return { rows: [{ safe_address: '0x2222222222222222222222222222222222222222', safe_name: 'Main', safe_chain_id: 100 }] } // Gnosis — unsupported
      }
      return { rows: [] }
    })

    const res = await app.inject({ method: 'POST', url: '/agents', payload: body })
    expect(res.statusCode).toBe(201)
    expect(res.json().passport_requested).toBe(false)
    expect(mockRequestPassport).not.toHaveBeenCalled()
  })
})
