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

vi.mock('../../infra/chain/relayer-reads.js', () => ({
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
import { installRequestValidation } from '../../openapi/request-validation.js'

const SAFE_BASE = '0x1111111111111111111111111111111111111111'
const SAFE_GNOSIS = '0x2222222222222222222222222222222222222222'

describe('balance routes', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = Fastify({ logger: false })
    // The production wiring (#3030, slice 2 of #3028): root-scope install, the
    // module enforced — off-spec requests answer the 400 envelope before the
    // handler, conformant ones reach it unchanged.
    installRequestValidation(app, { mode: 'enforce', enforcedModules: ['routes/balances.ts'] })
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

    // #3030: the shape refusal is the spec's (`integer, minimum: 1`), answered
    // by the enforced module as the 400 envelope; the handler never runs.
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ error: 'Request does not match the API spec', error_code: 'invalid_request' })
    expect(response.json().details).toContain('querystring/chain_id')
    expect(mockQuery).not.toHaveBeenCalled()
    expect(mockGetProvider).not.toHaveBeenCalled()
  })

  it('refuses a malformed address and a non-positive chain_id with the 400 envelope, before any query (#3030)', async () => {
    // Both were hand-rolled 400s before the module was enforced; the spec's
    // `address` pattern and `chain_id: integer, minimum: 1` are the guards
    // now. Mutation: drop the module from enforcedModules → the malformed
    // address reaches the ownership lookup (mockQuery called).
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    for (const url of ['/balances/not-an-address', `/balances/${SAFE_BASE}?chain_id=0`, `/balances/${SAFE_BASE}?chain_id=-8453`]) {
      const response = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } })
      expect(response.statusCode, url).toBe(400)
      expect(response.json()).toMatchObject({ error: 'Request does not match the API spec', statusCode: 400, error_code: 'invalid_request' })
    }
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

  it('does not cache a read whose balance leg failed, so the next request re-reads', async () => {
    // A fresh address: the route's cache is module-level and outlives each test.
    const account = '0x3333333333333333333333333333333333333333'
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockQuery.mockResolvedValue({ rows: [{ id: 'safe-base', chain_id: 8453 }] })
    // dRPC's free-plan batch refusal (code 31) on the first read only.
    mockBalanceOf.mockRejectedValueOnce(new Error('Batch of more than 3 requests are not allowed on free plan'))

    const request = () => app.inject({
      method: 'GET',
      url: `/balances/${account}?chain_id=8453`,
      headers: { authorization: `Bearer ${token}` },
    })

    const degraded = await request()
    expect(degraded.json().balances[1].balance).toBe('0')

    const recovered = await request()
    expect(recovered.json().balances[1].balance).toBe('2500000')
  })

  it('serves the last-known balance, marked stale, when a later read fails after a good one (#3295)', async () => {
    const account = '0x4444444444444444444444444444444444444444'
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockQuery.mockResolvedValue({ rows: [{ id: 'safe-base', chain_id: 8453 }] })

    const request = () => app.inject({
      method: 'GET',
      url: `/balances/${account}?chain_id=8453`,
      headers: { authorization: `Bearer ${token}` },
    })

    const good = await request()
    expect(good.json().balances[1]).toMatchObject({ balance: '2500000' })
    expect(good.json().balances[1].balanceFreshness).toBeUndefined()

    // Expire the 30 s route cache deterministically; the last-known store
    // timestamps with `new Date()`, which stays real.
    const realDateNow = Date.now.bind(Date)
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realDateNow() + 31_000)
    mockBalanceOf.mockRejectedValueOnce(new Error('Batch of more than 3 requests are not allowed on free plan'))

    const degraded = await request()
    const usdc = degraded.json().balances[1]
    expect(usdc.balance).toBe('2500000')
    expect(usdc.balanceFreshness).toEqual({ status: 'stale', asOf: expect.any(String) })
    // The native leg stayed clean — no marker on it.
    expect(degraded.json().balances[0].balanceFreshness).toBeUndefined()
    dateNowSpy.mockRestore()

    const recovered = await request()
    expect(recovered.json().balances[1].balance).toBe('2500000')
    expect(recovered.json().balances[1].balanceFreshness).toBeUndefined()
  })

  it('keeps a never-read token present with a string balance, marked unavailable, when its first read fails (#3295)', async () => {
    const account = '0x5555555555555555555555555555555555555555'
    const token = signToken({ sub: 'user-1', email: 'test@example.com' })
    mockQuery.mockResolvedValue({ rows: [{ id: 'safe-base', chain_id: 8453 }] })
    mockBalanceOf.mockRejectedValue(new Error('RPC down'))

    const response = await app.inject({
      method: 'GET',
      url: `/balances/${account}?chain_id=8453`,
      headers: { authorization: `Bearer ${token}` },
    })

    const usdc = response.json().balances[1]
    // Additive only: entry present, balance a decimal string — the published
    // CLI's token registry keeps its shape even when nothing is known.
    expect(usdc.symbol).toBe('USDC')
    expect(typeof usdc.balance).toBe('string')
    expect(usdc.balance).toBe('0')
    expect(usdc.balanceFreshness).toEqual({ status: 'unavailable' })
    expect(usdc.decimals).toBe(6)
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
