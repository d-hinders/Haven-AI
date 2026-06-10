import Fastify, { FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockQuery, mockFetchPortfolioForSafe } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockFetchPortfolioForSafe: vi.fn(),
}))

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}))

vi.mock('../../lib/portfolio.js', () => ({
  fetchPortfolioForSafe: (...args: unknown[]) => mockFetchPortfolioForSafe(...args),
}))

import portfolioRoutes from '../portfolio.js'

const SAFE_ADDRESS = '0x1111111111111111111111111111111111111111'
const PORTFOLIO = {
  totalUsd: 12.34,
  totalEur: 11.22,
  breakdown: [],
}

describe('portfolio routes', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(portfolioRoutes, { prefix: '/portfolio' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockQuery.mockReset()
    mockFetchPortfolioForSafe.mockReset()
    mockFetchPortfolioForSafe.mockResolvedValue(PORTFOLIO)
  })

  function signToken(payload: { sub: string; email: string }): string {
    return app.jwt.sign(payload, { expiresIn: '1h' })
  }

  it('uses the requested owned chain when fetching portfolio totals', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'safe-base', chain_id: 8453 }] })

    const response = await app.inject({
      method: 'GET',
      url: `/portfolio/${SAFE_ADDRESS}?chain_id=8453`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('AND chain_id = $3'),
      ['user-1', SAFE_ADDRESS, 8453],
    )
    expect(mockFetchPortfolioForSafe).toHaveBeenCalledWith(8453, SAFE_ADDRESS)
    expect(response.json()).toEqual(PORTFOLIO)
  })

  it('keeps the legacy address-only lookup when no chain is requested', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'safe-gnosis', chain_id: 100 }] })

    const response = await app.inject({
      method: 'GET',
      url: `/portfolio/${SAFE_ADDRESS}`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(mockQuery).toHaveBeenCalledWith(
      expect.not.stringContaining('AND chain_id = $3'),
      ['user-1', SAFE_ADDRESS],
    )
    expect(mockFetchPortfolioForSafe).toHaveBeenCalledWith(100, SAFE_ADDRESS)
  })

  it('requires chain_id for legacy reads that match multiple owned chains', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'safe-gnosis', chain_id: 100 },
        { id: 'safe-base', chain_id: 8453 },
      ],
    })

    const response = await app.inject({
      method: 'GET',
      url: `/portfolio/${SAFE_ADDRESS}`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('chain_id required')
    expect(mockQuery).toHaveBeenCalledWith(
      expect.not.stringContaining('AND chain_id = $3'),
      ['user-1', SAFE_ADDRESS],
    )
    expect(mockFetchPortfolioForSafe).not.toHaveBeenCalled()
  })

  it('rejects malformed chain_id values before ownership lookup', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })

    const response = await app.inject({
      method: 'GET',
      url: `/portfolio/${SAFE_ADDRESS}?chain_id=8453.5`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('Invalid chain_id')
    expect(mockQuery).not.toHaveBeenCalled()
    expect(mockFetchPortfolioForSafe).not.toHaveBeenCalled()
  })

  it('rejects unsupported chains before ownership lookup', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })

    const response = await app.inject({
      method: 'GET',
      url: `/portfolio/${SAFE_ADDRESS}?chain_id=999999`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('Unsupported chain: 999999')
    expect(mockQuery).not.toHaveBeenCalled()
    expect(mockFetchPortfolioForSafe).not.toHaveBeenCalled()
  })

  it('does not fall back to another chain when the requested chain is not owned', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const response = await app.inject({
      method: 'GET',
      url: `/portfolio/${SAFE_ADDRESS}?chain_id=8453`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().error).toBe('Not your Safe')
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('AND chain_id = $3'),
      ['user-1', SAFE_ADDRESS, 8453],
    )
    expect(mockFetchPortfolioForSafe).not.toHaveBeenCalled()
  })
})
