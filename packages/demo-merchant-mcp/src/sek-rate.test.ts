import { describe, expect, it, vi } from 'vitest'
import { SEK_RATE_URL, createSekRateFeed, parseSekRate } from './sek-rate.js'

/** #4856: the USDC→SEK rate cache the Stripe product's receipt reads. */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('parseSekRate (#4856)', () => {
  it('reads the SEK price of usd-coin', () => {
    expect(parseSekRate({ 'usd-coin': { sek: 10.0742 } })).toBe(10.0742)
  })
  it.each([
    ['no body', null],
    ['another coin', { tether: { sek: 10 } }],
    ['no sek', { 'usd-coin': { usd: 1 } }],
    ['a string', { 'usd-coin': { sek: '10.07' } }],
    ['zero', { 'usd-coin': { sek: 0 } }],
    ['negative', { 'usd-coin': { sek: -1 } }],
    ['not finite', { 'usd-coin': { sek: Number.POSITIVE_INFINITY } }],
  ])('refuses %s', (_name, body) => {
    expect(parseSekRate(body)).toBeUndefined()
  })
})

describe('createSekRateFeed (#4856)', () => {
  it('has no rate before the first fetch', () => {
    const feed = createSekRateFeed({ fetchImpl: vi.fn() })
    expect(feed.current()).toBeUndefined()
  })

  it('caches a fetched rate with its source and the time it was read', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ 'usd-coin': { sek: 10.0742 } }))
    const at = new Date('2026-11-17T12:00:00Z')
    const feed = createSekRateFeed({ fetchImpl, now: () => at })
    await feed.refresh()
    expect(fetchImpl).toHaveBeenCalledWith(SEK_RATE_URL, expect.anything())
    expect(feed.current()).toEqual({ rate: 10.0742, source: 'coingecko_spot', fetchedAt: at })
  })

  it('stops stating a rate once it is older than the maximum age', async () => {
    let now = new Date('2026-11-17T12:00:00Z')
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ 'usd-coin': { sek: 10 } }))
    const feed = createSekRateFeed({ fetchImpl, now: () => now, maxAgeMs: 60_000 })
    await feed.refresh()
    now = new Date(now.getTime() + 60_000)
    expect(feed.current()?.rate).toBe(10)
    now = new Date(now.getTime() + 1)
    expect(feed.current()).toBeUndefined()
  })

  it('keeps the previous rate when a later fetch fails, an HTTP error comes back or the body is unusable', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ 'usd-coin': { sek: 10 } }))
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(jsonResponse({ error: 'rate limited' }, 429))
      .mockResolvedValueOnce(jsonResponse({ 'usd-coin': {} }))
    const feed = createSekRateFeed({ fetchImpl })
    await feed.refresh()
    await feed.refresh()
    await feed.refresh()
    await feed.refresh()
    expect(fetchImpl).toHaveBeenCalledTimes(4)
    expect(feed.current()?.rate).toBe(10)
  })

  it('refresh never rejects', async () => {
    const feed = createSekRateFeed({ fetchImpl: vi.fn().mockRejectedValue(new Error('down')) })
    await expect(feed.refresh()).resolves.toBeUndefined()
    expect(feed.current()).toBeUndefined()
  })

  it('current() never fetches: the purchase path only reads the cache', () => {
    const fetchImpl = vi.fn()
    const feed = createSekRateFeed({ fetchImpl })
    feed.current()
    feed.current()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('start fetches at once and on the interval, once however often it is called; stop ends it', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ 'usd-coin': { sek: 10 } }))
      const feed = createSekRateFeed({ fetchImpl, refreshMs: 1_000 })
      feed.start()
      feed.start()
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(fetchImpl).toHaveBeenCalledTimes(2)
      feed.stop()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
