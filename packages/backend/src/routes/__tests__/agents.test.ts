import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import agentRoutes from '../agents.js'

const { mockQuery } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
}))

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
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
    expect(String(mockQuery.mock.calls[0][0])).toContain("a.status != 'pending_approval'")
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
    expect(String(mockQuery.mock.calls[0][0])).toContain("a.status != 'pending_approval'")

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
    expect(String(mockQuery.mock.calls[0][0])).toContain("a.status != 'pending_approval'")

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
