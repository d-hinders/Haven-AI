import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchTokenPrices, getTokenPrice } from '../prices.js'

/**
 * Guards the cache-poisoning fix: a 200 response carrying no usable price (empty
 * or degraded upstream, e.g. a soft rate-limit) must throw rather than resolve,
 * so getOrFetch never caches an all-zero map for the full TTL.
 */

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

afterEach(() => vi.restoreAllMocks())

describe('fetchTokenPrices cache poisoning guard', () => {
  it('throws on a 200 response with no usable prices (not cached)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}))
    await expect(fetchTokenPrices()).rejects.toThrow(/no usable prices/)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('does not cache the degraded response — a later good fetch succeeds', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValue(jsonResponse({ 'usd-coin': { usd: 1, eur: 0.9, sek: 10.5 } }))

    await expect(fetchTokenPrices()).rejects.toThrow(/no usable prices/)

    const price = await getTokenPrice('USDC.e')
    expect(price.sek).toBe(10.5)
    // Two real network attempts: the degraded one was never cached.
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})
