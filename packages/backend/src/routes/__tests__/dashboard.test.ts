import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mockQuery = vi.fn()
const mockFetchPortfolioForSafe = vi.fn()

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}))

vi.mock('../../lib/portfolio.js', () => ({
  fetchPortfolioForSafe: (...args: unknown[]) => mockFetchPortfolioForSafe(...args),
}))

vi.mock('../../lib/fiat-values.js', () => ({
  getFiatValuesForTokenAmount: vi.fn(async () => ({ usd: 0, eur: 0 })),
}))

vi.mock('../transactions.js', () => ({
  compareTransactions: vi.fn(() => 0),
  enrichTransactionsWithAgents: vi.fn(async (_userId: string, transactions: unknown[]) => transactions),
  fetchSafeTransactions: vi.fn(async () => ({ transactions: [], hadFailures: false })),
}))

import dashboardRoutes from '../dashboard.js'

describe('Dashboard routes', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-04T12:00:00.000Z'))

    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(dashboardRoutes, { prefix: '/dashboard' })
  })

  afterAll(async () => {
    vi.useRealTimers()
    await app.close()
  })

  beforeEach(() => {
    mockQuery.mockReset()
    mockFetchPortfolioForSafe.mockReset()
    mockFetchPortfolioForSafe.mockResolvedValue({ totalUsd: 12.34, totalEur: 11.11 })
  })

  it('includes self-sign confirmed spend in monthly agent spend totals', async () => {
    const token = app.jwt.sign({ sub: 'user-1', email: 'test@example.com' })
    const today = '2026-05-04'
    const yesterday = '2026-05-03'

    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM user_safes')) {
        return {
          rows: [
            {
              id: 'safe-1',
              safe_address: '0x1234567890abcdef1234567890abcdef12345678',
              chain_id: 100,
              name: 'Main Safe',
              is_default: true,
            },
          ],
        }
      }

      if (sql.includes('FROM agents a')) {
        return { rows: [] }
      }

      if (sql.includes(`FROM approval_requests\n         WHERE user_id = $1 AND status = 'pending'`)) {
        return { rows: [{ count: '0' }] }
      }

      if (sql.includes('FROM user_daily_portfolio_snapshots')) {
        return {
          rows: [
            { snapshot_date: today, total_usd: '12.34', total_eur: '11.11' },
            { snapshot_date: yesterday, total_usd: '10.00', total_eur: '9.00' },
          ],
        }
      }

      if (sql.includes('FROM payment_intents')) {
        return { rows: [] }
      }

      if (sql.includes('FROM self_sign_payment_intents')) {
        return {
          rows: [
            {
              token_symbol: 'USDC',
              usd_sum: '0.17',
              eur_sum: '0.15',
              fallback_amount: '0',
            },
          ],
        }
      }

      if (sql.includes(`FROM approval_requests\n         WHERE user_id = $1\n           AND status = 'executed'`)) {
        return { rows: [] }
      }

      throw new Error(`Unexpected query: ${sql}`)
    })

    const response = await app.inject({
      method: 'GET',
      url: '/dashboard/overview',
      headers: {
        authorization: `Bearer ${token}`,
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json().metrics).toMatchObject({
      monthlyAgentSpendUsd: 0.17,
      monthlyAgentSpendEur: 0.15,
    })
  })
})
