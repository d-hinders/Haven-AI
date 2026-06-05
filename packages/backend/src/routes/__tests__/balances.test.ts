import Fastify, { FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockQuery,
  mockGetProvider,
  mockGetBalance,
  mockBalanceOf,
  mockContractConstructor,
} = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetProvider: vi.fn(),
  mockGetBalance: vi.fn(),
  mockBalanceOf: vi.fn(),
  mockContractConstructor: vi.fn(),
}))

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}))

vi.mock('../../lib/allowance-module.js', () => ({
  getProvider: (...args: unknown[]) => mockGetProvider(...args),
}))

vi.mock('ethers', async () => {
  const actual = await vi.importActual<typeof import('ethers')>('ethers')
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      Contract: mockContractConstructor,
    },
  }
})

import balanceRoutes from '../balances.js'

const SAFE_BASE = '0x1111111111111111111111111111111111111111'
const SAFE_GNOSIS = '0x2222222222222222222222222222222222222222'

describe('balance routes', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(balanceRoutes, { prefix: '/balances' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockQuery.mockReset()
    mockGetProvider.mockReset()
    mockGetBalance.mockReset()
    mockBalanceOf.mockReset()
    mockContractConstructor.mockReset()

    mockGetProvider.mockReturnValue({
      getBalance: mockGetBalance,
    })
    mockGetBalance.mockResolvedValue(1_000_000_000_000_000_000n)
    mockBalanceOf.mockResolvedValue(2_500_000n)
    mockContractConstructor.mockImplementation(() => ({
      balanceOf: mockBalanceOf,
    }))
  })

  function signToken(payload: { sub: string; email: string }): string {
    return app.jwt.sign(payload, { expiresIn: '1h' })
  }

  it('uses the requested owned chain when fetching balances', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'safe-base', chain_id: 8453 }] })

    const response = await app.inject({
      method: 'GET',
      url: `/balances/${SAFE_BASE}?chain_id=8453`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('AND chain_id = $3'),
      ['user-1', SAFE_BASE, 8453],
    )
    expect(mockGetProvider).toHaveBeenCalledWith(8453)
    expect(response.json().balances).toEqual([
      {
        symbol: 'ETH',
        address: null,
        balance: '1000000000000000000',
        formatted: '1.00',
        decimals: 18,
      },
      {
        symbol: 'USDC',
        address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        balance: '2500000',
        formatted: '2.50',
        decimals: 6,
      },
    ])
  })

  it('keeps the legacy address-only lookup when no chain is requested', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'safe-gnosis', chain_id: 100 }] })

    const response = await app.inject({
      method: 'GET',
      url: `/balances/${SAFE_GNOSIS}`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(mockQuery).toHaveBeenCalledWith(
      expect.not.stringContaining('AND chain_id = $3'),
      ['user-1', SAFE_GNOSIS],
    )
    expect(mockGetProvider).toHaveBeenCalledWith(100)
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
      url: `/balances/${SAFE_BASE}`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('chain_id required')
    expect(mockQuery).toHaveBeenCalledWith(
      expect.not.stringContaining('AND chain_id = $3'),
      ['user-1', SAFE_BASE],
    )
    expect(mockGetProvider).not.toHaveBeenCalled()
  })

  it('rejects malformed chain_id values before ownership lookup', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })

    const response = await app.inject({
      method: 'GET',
      url: `/balances/${SAFE_BASE}?chain_id=8453.5`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('Invalid chain_id')
    expect(mockQuery).not.toHaveBeenCalled()
    expect(mockGetProvider).not.toHaveBeenCalled()
  })

  it('rejects unsupported chains before ownership lookup', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })

    const response = await app.inject({
      method: 'GET',
      url: `/balances/${SAFE_BASE}?chain_id=999999`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('Unsupported chain: 999999')
    expect(mockQuery).not.toHaveBeenCalled()
    expect(mockGetProvider).not.toHaveBeenCalled()
  })

  it('does not fall back to another chain when the requested chain is not owned', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const response = await app.inject({
      method: 'GET',
      url: `/balances/${SAFE_BASE}?chain_id=8453`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().error).toBe('Not your Safe')
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('AND chain_id = $3'),
      ['user-1', SAFE_BASE, 8453],
    )
    expect(mockGetProvider).not.toHaveBeenCalled()
  })
})
