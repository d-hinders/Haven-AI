// #3460 — one shared balance-read cache instead of two (30 s / 60 s).
//
// The route (`GET /balances`) and `fetchPortfolioForAccount` (behind
// /portfolio and /dashboard/overview) MUST hit the same
// (chainId, address)-keyed cache, so one dashboard's two polls cause one set
// of on-chain balance reads within the TTL instead of two. The chain client
// here is a counting fake: one native read + one ERC-20 read per read-SET,
// so the call counts below are read-set counts.
//
// MUTATION (acceptance criterion 4): split the cache back into two — give
// `routes/balances.ts` its own `createCache(30_000)` again (or have
// `fetchBalanceReads` bypass `balanceReadsCache`) — and the first test goes
// red: the /balances request and the portfolio derivation for the same
// address stop sharing, and the counts rise from 1 read-set to 2 (then 3
// with the second /balances read).
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockNativeReads,
  mockTokenReads,
  mockFindAccountOwnership,
  mockEmitFunnelEvent,
  mockFetchTokenPrices,
} = vi.hoisted(() => ({
  mockNativeReads: vi.fn(),
  mockTokenReads: vi.fn(),
  mockFindAccountOwnership: vi.fn(),
  mockEmitFunnelEvent: vi.fn(),
  mockFetchTokenPrices: vi.fn(),
}))

// The counting chain client: every read goes through these two fns, so a
// call count IS a read count (one native + one ERC-20 per read-set).
vi.mock('../../../infra/chain/index.js', () => ({
  getChainClient: () => ({
    getNativeBalance: (...args: unknown[]) => mockNativeReads(...args),
    getTokenBalance: (...args: unknown[]) => mockTokenReads(...args),
    normaliseAddress: (a: string) => a,
  }),
}))

vi.mock('../../../infra/repositories/transaction-history.js', () => ({
  findAccountOwnership: (...args: unknown[]) => mockFindAccountOwnership(...args),
}))

vi.mock('../../../infra/repositories/onboarding-funnel.js', () => ({
  emitFunnelEvent: (...args: unknown[]) => mockEmitFunnelEvent(...args),
}))

vi.mock('../../../infra/prices.js', () => ({
  fetchTokenPrices: (...args: unknown[]) => mockFetchTokenPrices(...args),
}))

import balanceRoutes from '../../../routes/balances.js'
import { fetchPortfolioForAccount, isPortfolioUnpriceable } from '../index.js'
import { fetchBalanceReads } from '../balance-reads.js'

// Chain 84532 (Base Sepolia) registry: ETH native + USDC.
const CHAIN = 84532
const ONE_ETH = 10n ** 18n
const TWO_USDC = 2_000_000n
const PRICES = {
  ETH: { usd: 1000, eur: 900, sek: 10_000 },
  USDC: { usd: 1, eur: 0.9, sek: 10 },
}

const account = (n: number) => '0x' + n.toString(16).padStart(40, '0')

describe('shared balance-read cache (#3460)', () => {
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
    mockNativeReads.mockReset().mockResolvedValue(ONE_ETH)
    mockTokenReads.mockReset().mockResolvedValue(TWO_USDC)
    mockFindAccountOwnership.mockReset().mockResolvedValue({
      rows: [{ id: 'safe-1', chain_id: CHAIN }],
    })
    mockEmitFunnelEvent.mockReset()
    mockFetchTokenPrices.mockReset().mockResolvedValue(PRICES)
  })

  const getBalances = (addr: string, chainId = CHAIN) =>
    app.inject({
      method: 'GET',
      url: `/balances/${addr}?chain_id=${chainId}`,
      headers: { authorization: `Bearer ${app.jwt.sign({ sub: 'user-1', email: 't@example.com' })}` },
    })

  it('a /balances request and a /portfolio derivation for the same (chain, address) cause ONE set of on-chain reads', async () => {
    const addr = account(1)

    const res = await getBalances(addr)
    expect(res.statusCode).toBe(200)
    expect(mockNativeReads).toHaveBeenCalledTimes(1)
    expect(mockTokenReads).toHaveBeenCalledTimes(1) // one ERC-20 in the registry

    // The portfolio derivation (what GET /portfolio and
    // /dashboard/overview call) reads the SAME cached read-set — no second
    // set of on-chain reads. False before #3460: two caches, two read sets.
    const portfolio = await fetchPortfolioForAccount(CHAIN, addr)
    expect(mockNativeReads).toHaveBeenCalledTimes(1)
    expect(mockTokenReads).toHaveBeenCalledTimes(1)
    expect(portfolio.totalUsd).toBe(1002) // 1 ETH @ 1000 + 2 USDC @ 1

    // And a further /balances within the TTL still causes no new reads.
    const again = await getBalances(addr)
    expect(again.json()).toEqual(res.json())
    expect(mockNativeReads).toHaveBeenCalledTimes(1)
    expect(mockTokenReads).toHaveBeenCalledTimes(1)
  })

  it('response shapes are unchanged: /balances and the portfolio carry exactly the pre-#3460 fields', async () => {
    const addr = account(2)
    const res = await getBalances(addr)
    expect(Object.keys(res.json())).toEqual(['balances'])
    expect(Object.keys(res.json().balances[0]).sort()).toEqual([
      'address',
      'balance',
      'decimals',
      'formatted',
      'symbol',
    ])

    const portfolio = await fetchPortfolioForAccount(CHAIN, addr)
    expect(Object.keys(portfolio).sort()).toEqual(['breakdown', 'totalEur', 'totalSek', 'totalUsd'])
    // Clean read: no `balanceFreshness` marker on the entry.
    expect(Object.keys(portfolio.breakdown[0]).sort()).toEqual([
      'balance',
      'eurValue',
      'formatted',
      'sekValue',
      'symbol',
      'usdValue',
    ])
  })

  it('a failed leg is served ONCE through /balances, never cached; the next request re-reads the chain (#3295)', async () => {
    const addr = account(3)
    // The dRPC free-plan refusal that zeroed the dashboard (code 31).
    mockTokenReads.mockRejectedValueOnce(new Error('Batch of more than 3 requests are not allowed on free plan'))

    const degraded = await getBalances(addr)
    expect(degraded.json().balances[1].balance).toBe('0')
    expect(degraded.json().balances[1].balanceFreshness).toEqual({ status: 'unavailable' })
    expect(mockNativeReads).toHaveBeenCalledTimes(1)
    expect(mockTokenReads).toHaveBeenCalledTimes(1)

    const recovered = await getBalances(addr)
    expect(recovered.json().balances[1].balance).toBe('2000000')
    expect(recovered.json().balances[1].balanceFreshness).toBeUndefined()
    // One new read-set: the degraded read-set was not cached.
    expect(mockNativeReads).toHaveBeenCalledTimes(2)
    expect(mockTokenReads).toHaveBeenCalledTimes(2)
  })

  it('a failed leg is served ONCE through the portfolio, never cached, and /balances still re-reads', async () => {
    const addr = account(4)
    mockNativeReads.mockRejectedValueOnce(new Error('RPC down'))

    const degraded = await fetchPortfolioForAccount(CHAIN, addr)
    expect(degraded.breakdown[0].balance).toBe('0')
    expect(degraded.breakdown[0].balanceFreshness).toEqual({ status: 'unavailable' })
    expect(isPortfolioUnpriceable(degraded)).toBe(true)
    expect(mockNativeReads).toHaveBeenCalledTimes(1)

    // The failed read-set was evicted, so the NEXT portfolio call re-reads.
    const recovered = await fetchPortfolioForAccount(CHAIN, addr)
    expect(recovered.breakdown[0].balance).not.toBe('0')
    expect(isPortfolioUnpriceable(recovered)).toBe(false)
    expect(mockNativeReads).toHaveBeenCalledTimes(2)

    // And the route (a third consumer) reads the recovered cached set.
    await getBalances(addr)
    expect(mockNativeReads).toHaveBeenCalledTimes(2)
  })

  it('concurrent /balances and portfolio callers share ONE in-flight load', async () => {
    const addr = account(5)
    let release!: (v: bigint) => void
    const gate = new Promise<bigint>((resolve) => {
      release = resolve
    })
    mockNativeReads.mockImplementation(() => gate)

    const routePromise = getBalances(addr)
    const portfolioPromise = fetchPortfolioForAccount(CHAIN, addr)
    release(ONE_ETH)
    const [res, portfolio] = await Promise.all([routePromise, portfolioPromise])

    // Single-flight: one loader run served BOTH consumers.
    expect(mockNativeReads).toHaveBeenCalledTimes(1)
    expect(mockTokenReads).toHaveBeenCalledTimes(1)
    expect(res.json().balances[0].balance).toBe('1000000000000000000')
    expect(portfolio.totalUsd).toBe(1002)
  })

  it('after the 60 s TTL the shared cache re-reads (the visible /balances lag is now 60 s, was 30 s)', async () => {
    const addr = account(6)
    await getBalances(addr)
    expect(mockNativeReads).toHaveBeenCalledTimes(1)

    const realDateNow = Date.now.bind(Date)
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realDateNow() + 61_000)
    await getBalances(addr)
    dateNowSpy.mockRestore()
    expect(mockNativeReads).toHaveBeenCalledTimes(2)
  })

  it('an unpriceable portfolio over CLEAN reads does not evict the shared cache (#3460)', async () => {
    // Both supported chains hold only ETH and USDC, and the tests above price
    // both successfully, so the #3297 last-good quote (keyed by symbol, never
    // reset — the ordering constraint portfolio-unpriceable.test.ts documents)
    // already exists in this module instance. A FRESH module graph has none:
    // with an empty price map every held token is unpriceable while every
    // balance read SUCCEEDS. (#3671: this used to lean on chain 100's
    // never-priced tokens, which no longer have a read path.)
    vi.resetModules()
    const fresh = await import('../index.js')
    const freshReads = await import('../balance-reads.js')
    const addr = account(7)
    mockFetchTokenPrices.mockResolvedValue({})

    const unpriceable = await fresh.fetchPortfolioForAccount(CHAIN, addr)
    expect(unpriceable.totalUsd).toBe(0)
    expect(fresh.isPortfolioUnpriceable(unpriceable)).toBe(true)
    expect(mockNativeReads).toHaveBeenCalledTimes(1)

    // The reads were good and STAY cached — the next portfolio call
    // re-prices the same reads (bounded by the price backoff), and the shared
    // read-set is unaffected: no new reads, the cached native read intact.
    const again = await fresh.fetchPortfolioForAccount(CHAIN, addr)
    expect(fresh.isPortfolioUnpriceable(again)).toBe(true)
    expect(mockNativeReads).toHaveBeenCalledTimes(1)

    // The shared cache is read directly — the same read-set the route serves
    // from.
    const reads = await freshReads.fetchBalanceReads(CHAIN, addr)
    expect(mockNativeReads).toHaveBeenCalledTimes(1)
    expect(reads.native.status).toBe('fulfilled')
    expect((reads.native as PromiseFulfilledResult<bigint>).value.toString()).toBe('1000000000000000000')
  })
})
