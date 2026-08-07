import Fastify, { FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockQuery, mockGetSafeDetails } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockGetSafeDetails: vi.fn(),
}))

vi.mock('../../db.js', () => ({
  default: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}))

vi.mock('../../modules/accounts/index.js', () => ({
  getSafeDetails: (...args: unknown[]) => mockGetSafeDetails(...args),
}))

import safeDetailRoutes from '../safe-details.js'

const SAFE_ADDRESS = '0x1111111111111111111111111111111111111111'

describe('Safe details routes', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(safeDetailRoutes, { prefix: '/safe' })
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    mockQuery.mockReset()
    mockGetSafeDetails.mockReset()
  })

  function signToken(payload: { sub: string; email: string }): string {
    return app.jwt.sign(payload, { expiresIn: '1h' })
  }

  function mockDetails(chainId: number) {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: `safe-${chainId}`, chain_id: chainId }] })
    mockGetSafeDetails.mockResolvedValueOnce({
      address: SAFE_ADDRESS,
      owners: ['0x2222222222222222222222222222222222222222'],
      threshold: 1,
      nonce: 7,
    })
  }

  it('uses the requested owned chain when fetching details', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockDetails(8453)

    const response = await app.inject({
      method: 'GET',
      url: `/safe/${SAFE_ADDRESS}/details?chain_id=8453`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('AND chain_id = $3'),
      ['user-1', SAFE_ADDRESS, 8453],
    )
    expect(mockGetSafeDetails).toHaveBeenCalledWith(SAFE_ADDRESS, 8453)
  })

  it('keeps the legacy address-only lookup when no chain is requested', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockDetails(100)

    const response = await app.inject({
      method: 'GET',
      url: `/safe/${SAFE_ADDRESS}/details`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(200)
    expect(mockQuery).toHaveBeenCalledWith(
      expect.not.stringContaining('AND chain_id = $3'),
      ['user-1', SAFE_ADDRESS],
    )
    expect(mockGetSafeDetails).toHaveBeenCalledWith(SAFE_ADDRESS, 100)
  })

  it('rejects malformed chain_id values before ownership lookup', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })

    const response = await app.inject({
      method: 'GET',
      url: `/safe/${SAFE_ADDRESS}/details?chain_id=8453.5`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('Invalid chain_id')
    expect(mockQuery).not.toHaveBeenCalled()
    expect(mockGetSafeDetails).not.toHaveBeenCalled()
  })

  it('rejects unsupported chains before ownership lookup', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })

    const response = await app.inject({
      method: 'GET',
      url: `/safe/${SAFE_ADDRESS}/details?chain_id=999999`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().error).toBe('Unsupported chain: 999999')
    expect(mockQuery).not.toHaveBeenCalled()
    expect(mockGetSafeDetails).not.toHaveBeenCalled()
  })

  it('does not fall back to another chain when the requested chain is not owned', async () => {
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockQuery.mockResolvedValueOnce({ rows: [] })

    const response = await app.inject({
      method: 'GET',
      url: `/safe/${SAFE_ADDRESS}/details?chain_id=8453`,
      headers: { authorization: `Bearer ${token}` },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json().error).toBe('Not your Safe')
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('AND chain_id = $3'),
      ['user-1', SAFE_ADDRESS, 8453],
    )
    expect(mockGetSafeDetails).not.toHaveBeenCalled()
  })
})

describe('non-Safe accounts answer cleanly (#1107)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(safeDetailRoutes, { prefix: '/safe' })
  })
  afterAll(async () => app.close())
  beforeEach(() => {
    mockQuery.mockReset()
    mockGetSafeDetails.mockReset()
  })

  it('a delegator_hybrid account gets a 409, never a Safe-ABI probe that 500s', async () => {
    const token = app.jwt.sign({ sub: 'user-1', email: 't@e.com' }, { expiresIn: '1h' })
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'safe-1', chain_id: 84532, account_type: 'delegator_hybrid' }],
    })
    const response = await app.inject({
      method: 'GET',
      url: `/safe/${SAFE_ADDRESS}/details?chain_id=84532`,
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.statusCode).toBe(409)
    expect(response.json().error).toMatch(/not a Safe/)
    // The Safe ABI is never probed against a Hybrid:
    expect(mockGetSafeDetails).not.toHaveBeenCalled()
  })
})
