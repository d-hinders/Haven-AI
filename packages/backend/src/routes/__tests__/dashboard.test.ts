import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'

const { mockQuery, portfolioMocks, transactionMocks } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  portfolioMocks: {
    fetchPortfolioForSafe: vi.fn(),
  },
  transactionMocks: {
    compareTransactions: vi.fn(() => 0),
    enrichedTransactionIdentityKey: vi.fn((tx: {
      chainId: number
      safeId: string
      hash: string
      type: string
      from: string
      to: string
      value: string
      tokenAddress?: string
    }) => [
      tx.chainId,
      tx.safeId,
      tx.hash.toLowerCase(),
      tx.type,
      tx.from.toLowerCase(),
      tx.to.toLowerCase(),
      tx.value,
      tx.tokenAddress?.toLowerCase() ?? 'native',
    ].join(':')),
    enrichTransactionsWithAgents: vi.fn(
      async (_userId: string, transactions: unknown[]) => transactions,
    ),
    fetchSafeTransactions: vi.fn(),
    mergeX402Transactions: vi.fn(),
  },
}))

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}))

vi.mock('../../lib/portfolio.js', () => portfolioMocks)
vi.mock('../../lib/fiat-values.js', () => ({
  getFiatValuesForTokenAmount: vi.fn(),
}))
vi.mock('../transactions.js', () => transactionMocks)

import dashboardRoutes from '../dashboard.js'

const SAFE = {
  id: 'safe-1',
  safe_address: '0x1111111111111111111111111111111111111111',
  chain_id: 8453,
  name: 'Main account',
  is_default: true,
}

const AGENT = {
  id: 'agent-1',
  name: 'Research agent',
  status: 'active',
  safe_id: SAFE.id,
  safe_name: SAFE.name,
  safe_chain_id: SAFE.chain_id,
}

describe('dashboard routes', () => {
  let app: FastifyInstance
  let token: string

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(dashboardRoutes, { prefix: '/dashboard' })
    token = app.jwt.sign({ sub: 'user-1', email: 'ada@example.com' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockQuery.mockReset()
    portfolioMocks.fetchPortfolioForSafe.mockReset()
    transactionMocks.compareTransactions.mockClear()
    transactionMocks.enrichedTransactionIdentityKey.mockClear()
    transactionMocks.enrichTransactionsWithAgents.mockClear()
    transactionMocks.fetchSafeTransactions.mockReset()
    transactionMocks.mergeX402Transactions.mockReset()

    portfolioMocks.fetchPortfolioForSafe.mockResolvedValue({
      totalUsd: 100,
      totalEur: 92,
    })
    transactionMocks.fetchSafeTransactions.mockResolvedValue({ transactions: [] })
    transactionMocks.mergeX402Transactions.mockResolvedValue([])

    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('AS has_first_agent_payment')) {
        return Promise.resolve({ rows: [{ has_first_agent_payment: true }] })
      }
      if (sql.includes('FROM user_safes') && sql.includes('ORDER BY created_at ASC')) {
        return Promise.resolve({ rows: [SAFE] })
      }
      if (sql.includes('FROM agents a')) {
        return Promise.resolve({ rows: [AGENT] })
      }
      if (sql.includes("status IN ('pending', 'approved')")) {
        return Promise.resolve({ rows: [{ count: '0' }] })
      }
      if (sql.includes('FROM agent_allowances')) {
        return Promise.resolve({ rows: [] })
      }
      if (sql.includes('FROM user_daily_portfolio_snapshots')) {
        return Promise.resolve({ rows: [] })
      }
      if (sql.includes('INSERT INTO user_daily_portfolio_snapshots')) {
        return Promise.resolve({ rows: [] })
      }
      if (sql.includes('GROUP BY token_symbol')) {
        return Promise.resolve({ rows: [] })
      }

      throw new Error(`Unexpected query: ${sql}`)
    })
  })

  it('returns first agent payment progress from authoritative payment records', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/overview',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      onboardingProgress: {
        hasFirstAgentPayment: true,
      },
    })

    const progressQuery = mockQuery.mock.calls.find(([sql]) =>
      String(sql).includes('AS has_first_agent_payment'),
    )?.[0] as string
    expect(progressQuery).toContain('FROM payment_intents')
    expect(progressQuery).toContain("status = 'confirmed'")
    expect(progressQuery).toContain('FROM approval_requests')
    expect(progressQuery).toContain("status = 'executed'")

    const agentQuery = mockQuery.mock.calls.find(([sql]) =>
      String(sql).includes('FROM agents a'),
    )?.[0] as string
    expect(agentQuery).toContain("a.status IN ('active', 'paused')")
  })

  it('counts same-address transactions on separate chains independently', async () => {
    const gnosisSafe = { ...SAFE, id: 'safe-gnosis', chain_id: 100 }
    const baseSafe = { ...SAFE, id: 'safe-base', chain_id: 8453 }
    mockQuery.mockImplementation((sql: string) => {
      if (sql.includes('AS has_first_agent_payment')) {
        return Promise.resolve({ rows: [{ has_first_agent_payment: true }] })
      }
      if (sql.includes('FROM user_safes') && sql.includes('ORDER BY created_at ASC')) {
        return Promise.resolve({ rows: [gnosisSafe, baseSafe] })
      }
      if (sql.includes('FROM agents a')) {
        return Promise.resolve({ rows: [] })
      }
      if (sql.includes("status IN ('pending', 'approved')")) {
        return Promise.resolve({ rows: [{ count: '0' }] })
      }
      if (sql.includes('FROM user_daily_portfolio_snapshots')) {
        return Promise.resolve({ rows: [] })
      }
      if (sql.includes('INSERT INTO user_daily_portfolio_snapshots')) {
        return Promise.resolve({ rows: [] })
      }
      if (sql.includes('GROUP BY token_symbol')) {
        return Promise.resolve({ rows: [] })
      }

      throw new Error(`Unexpected query: ${sql}`)
    })

    const tx = {
      hash: '0x72d03a8ff551e443c118c93c54d32260941deb613e51fcd2733cd3455e8fa1a1',
      type: 'native',
      from: '0x2222222222222222222222222222222222222222',
      to: SAFE.safe_address,
      value: '1000000000000000000',
      valueFormatted: '1',
      asset: 'ETH',
      decimals: 18,
      direction: 'in',
      timestamp: 1778240999,
      blockNumber: 45725826,
      isError: false,
    }
    transactionMocks.fetchSafeTransactions.mockResolvedValue({ transactions: [tx] })
    transactionMocks.mergeX402Transactions.mockImplementation(
      async (_userId: string, _safes: unknown[], transactions: unknown[]) => transactions,
    )

    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/overview',
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.metrics.successfulTransactions).toBe(2)
    expect(body.transactions).toHaveLength(2)
    expect(body.transactions.map((item: { chainId: number }) => item.chainId).sort()).toEqual([
      100,
      8453,
    ])
  })
})
