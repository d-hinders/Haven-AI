import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Guards the cache-poisoning fix: a 200 response carrying no usable price (empty
 * or degraded upstream, e.g. a soft rate-limit) must throw rather than resolve,
 * so getOrFetch never caches an all-zero map for the full TTL.
 *
 * ## Why the module is imported per test (#2620)
 *
 * `prices.ts` holds a MODULE-LEVEL `createCache(60_000)`, so the price map
 * survives between tests in the same file. Both guards below assert an exact
 * `fetch` call count, which is only meaningful against a COLD cache — and the
 * file used to establish that by luck of declaration order alone.
 *
 * Under `--sequence.shuffle` it stopped holding: with the second test first,
 * its good response warms the cache, and the first test's `fetchTokenPrices()`
 * then RESOLVES from that cache instead of throwing
 * (`promise resolved "{ …(5) }" instead of rejecting`). That is the cache doing
 * its job — a warm entry inside its 60 s TTL should serve without a network
 * call — so the shuffled red was fixture bleed, not a hole in the guard. It was
 * settled that way before this file was stabilised, per #2620: reproduced by
 * swapping the two tests in place, which fails identically every run.
 *
 * `vi.resetModules()` + a per-test dynamic import gives each test its own module
 * instance and therefore its own empty cache. The first test below is the
 * POSITIVE CONTROL for that reset: it proves the cache is real (a second call
 * does NOT re-fetch) and the reset works (the next test fetches again), so a
 * reset that silently stopped resetting would redden rather than pass quietly.
 */

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

const GOOD = { 'usd-coin': { usd: 1, eur: 0.9, sek: 10.5 } }

/** A fresh module instance, and therefore a fresh price cache. */
async function freshPrices() {
  vi.resetModules()
  return import('../prices.js')
}

beforeEach(() => vi.resetModules())
afterEach(() => vi.restoreAllMocks())

describe('the per-test cache reset itself (#2620)', () => {
  it('POSITIVE CONTROL: the cache is real within a test, and empty at the start of one', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(GOOD))
    const { getTokenPrice } = await freshPrices()

    await getTokenPrice('USDC.e')
    await getTokenPrice('USDC.e')
    // ONE network call for two reads — the module-level cache is live, which is
    // the thing the reset has to undo.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('and the next test starts cold — the previous test\'s entry did not survive', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(GOOD))
    const { getTokenPrice } = await freshPrices()

    await getTokenPrice('USDC.e')
    // If the reset were a no-op, the entry cached one test earlier would still
    // be inside its 60 s TTL and this would be 0.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe('fetchTokenPrices cache poisoning guard', () => {
  it('throws on a 200 response with no usable prices (not cached)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}))
    const { fetchTokenPrices } = await freshPrices()

    await expect(fetchTokenPrices()).rejects.toThrow(/no usable prices/)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('does not cache the degraded response — a later good fetch succeeds', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValue(jsonResponse(GOOD))
    const { fetchTokenPrices, getTokenPrice } = await freshPrices()

    await expect(fetchTokenPrices()).rejects.toThrow(/no usable prices/)

    const price = await getTokenPrice('USDC.e')
    expect(price.sek).toBe(10.5)
    // Two real network attempts: the degraded one was never cached.
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})
