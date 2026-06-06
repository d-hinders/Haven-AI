import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import selfSignAgentRoutes from '../self-sign-agents.js'

const { mockQuery, mockConnect, mockClientQuery, mockClientRelease } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockConnect: vi.fn(),
  mockClientQuery: vi.fn(),
  mockClientRelease: vi.fn(),
}))

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
    connect: (...args: unknown[]) => mockConnect(...args),
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

describe('self-sign agent routes', () => {
  beforeEach(() => {
    mockQuery.mockReset()
    mockConnect.mockReset()
    mockClientQuery.mockReset()
    mockClientRelease.mockReset()
    mockConnect.mockResolvedValue({
      query: (...args: unknown[]) => mockClientQuery(...args),
      release: mockClientRelease,
    })
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
  ])('rejects invalid create allowance input before DB work: %s', async (_label, allowance, errorPattern) => {
    const app = Fastify({ logger: false })
    await app.register(selfSignAgentRoutes, { prefix: '/self-sign-agents' })

    const response = await app.inject({
      method: 'POST',
      url: '/self-sign-agents',
      payload: {
        name: 'Research Agent',
        delegate_address: VALID_DELEGATE,
        allowances: [allowance],
      },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toMatch(errorPattern)
    expect(mockQuery).not.toHaveBeenCalled()
    expect(mockConnect).not.toHaveBeenCalled()

    await app.close()
  })

  it('rejects duplicate create allowances after token address normalization', async () => {
    const app = Fastify({ logger: false })
    await app.register(selfSignAgentRoutes, { prefix: '/self-sign-agents' })

    const response = await app.inject({
      method: 'POST',
      url: '/self-sign-agents',
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
    expect(mockConnect).not.toHaveBeenCalled()

    await app.close()
  })

  it('normalizes create allowance inputs before writing mirror rows', async () => {
    const app = Fastify({ logger: false })
    await app.register(selfSignAgentRoutes, { prefix: '/self-sign-agents' })

    mockClientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'agent-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'agent-1',
        name: 'Research Agent',
        description: null,
        delegate_address: VALID_DELEGATE,
        safe_id: null,
        safe_address: null,
        safe_name: null,
        status: 'active',
        created_at: '2026-06-05T10:00:00.000Z',
      }],
    })

    const response = await app.inject({
      method: 'POST',
      url: '/self-sign-agents',
      payload: {
        name: 'Research Agent',
        delegate_address: VALID_DELEGATE,
        allowances: [{
          token_address: VALID_TOKEN.toUpperCase().replace('X', 'x'),
          token_symbol: '  USDC  ',
          allowance_amount: '00025000000',
          reset_period_min: 1440,
        }],
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().allowances).toEqual([VALID_ALLOWANCE])
    expect(mockClientQuery.mock.calls[2][1]).toEqual([
      'agent-1',
      VALID_TOKEN,
      'USDC',
      '25000000',
      1440,
    ])
    expect(mockClientRelease).toHaveBeenCalledTimes(1)

    await app.close()
  })

  it('blocks deleting active self-sign agents before revocation', async () => {
    const app = Fastify({ logger: false })
    await app.register(selfSignAgentRoutes, { prefix: '/self-sign-agents' })

    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'agent-1' }] })

    const response = await app.inject({
      method: 'DELETE',
      url: '/self-sign-agents/agent-1',
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toBe('Only revoked agents can be deleted')
    expect(String(mockQuery.mock.calls[0][0])).toContain("status = 'revoked'")
    expect(mockQuery.mock.calls[0][1]).toEqual(['agent-1', 'user-1'])
    expect(mockQuery.mock.calls[1][1]).toEqual(['agent-1', 'user-1'])

    await app.close()
  })

  it('returns not found when deleting an unknown self-sign agent', async () => {
    const app = Fastify({ logger: false })
    await app.register(selfSignAgentRoutes, { prefix: '/self-sign-agents' })

    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })

    const response = await app.inject({
      method: 'DELETE',
      url: '/self-sign-agents/missing-agent',
    })

    expect(response.statusCode).toBe(404)
    expect(response.json().error).toBe('Agent not found')
    expect(mockQuery).toHaveBeenCalledTimes(2)

    await app.close()
  })

  it('deletes revoked self-sign agents', async () => {
    const app = Fastify({ logger: false })
    await app.register(selfSignAgentRoutes, { prefix: '/self-sign-agents' })

    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'agent-1' }] })

    const response = await app.inject({
      method: 'DELETE',
      url: '/self-sign-agents/agent-1',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ success: true })
    expect(mockQuery).toHaveBeenCalledTimes(1)
    expect(String(mockQuery.mock.calls[0][0])).toContain("status = 'revoked'")
    expect(mockQuery.mock.calls[0][1]).toEqual(['agent-1', 'user-1'])

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
    await app.register(selfSignAgentRoutes, { prefix: '/self-sign-agents' })

    const response = await app.inject({
      method: 'POST',
      url: '/self-sign-agents/agent-1/allowances',
      payload: allowance,
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toMatch(errorPattern)
    expect(mockQuery).not.toHaveBeenCalled()

    await app.close()
  })

  it('normalizes allowance update inputs before writing the mirror row', async () => {
    const app = Fastify({ logger: false })
    await app.register(selfSignAgentRoutes, { prefix: '/self-sign-agents' })

    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'agent-1', status: 'active' }] })
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
      url: '/self-sign-agents/agent-1/allowances',
      payload: {
        token_address: VALID_TOKEN.toUpperCase().replace('X', 'x'),
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

  it('blocks allowance updates for revoked self-sign agents', async () => {
    const app = Fastify({ logger: false })
    await app.register(selfSignAgentRoutes, { prefix: '/self-sign-agents' })

    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'agent-1', status: 'revoked' }] })

    const response = await app.inject({
      method: 'POST',
      url: '/self-sign-agents/agent-1/allowances',
      payload: VALID_ALLOWANCE,
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toMatch(/Revoked agent/)
    expect(mockQuery).toHaveBeenCalledTimes(1)

    await app.close()
  })

  it('rejects invalid allowance delete token addresses before agent lookup', async () => {
    const app = Fastify({ logger: false })
    await app.register(selfSignAgentRoutes, { prefix: '/self-sign-agents' })

    const response = await app.inject({
      method: 'DELETE',
      url: '/self-sign-agents/agent-1/allowances/not-an-address',
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toMatch(/Valid token address/)
    expect(mockQuery).not.toHaveBeenCalled()

    await app.close()
  })

  it('blocks allowance deletes for revoked self-sign agents', async () => {
    const app = Fastify({ logger: false })
    await app.register(selfSignAgentRoutes, { prefix: '/self-sign-agents' })

    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'agent-1', status: 'revoked' }] })

    const response = await app.inject({
      method: 'DELETE',
      url: `/self-sign-agents/agent-1/allowances/${VALID_TOKEN}`,
    })

    expect(response.statusCode).toBe(409)
    expect(response.json().error).toMatch(/Revoked agent/)
    expect(mockQuery).toHaveBeenCalledTimes(1)

    await app.close()
  })

  it('normalizes allowance delete token addresses before deleting mirror rows', async () => {
    const app = Fastify({ logger: false })
    await app.register(selfSignAgentRoutes, { prefix: '/self-sign-agents' })

    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'agent-1', status: 'active' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'allowance-1' }] })

    const response = await app.inject({
      method: 'DELETE',
      url: `/self-sign-agents/agent-1/allowances/${VALID_TOKEN.toUpperCase().replace('X', 'x')}`,
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ success: true })
    expect(mockQuery.mock.calls[1][1]).toEqual(['agent-1', VALID_TOKEN])

    await app.close()
  })
})
