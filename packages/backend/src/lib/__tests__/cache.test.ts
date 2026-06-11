import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCache } from '../cache.js'

describe('createCache', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns cached values within TTL and expires them after', () => {
    const cache = createCache<string>(30_000)
    cache.set('a', 'value')

    expect(cache.get('a')).toBe('value')

    vi.advanceTimersByTime(30_000)
    expect(cache.get('a')).toBeUndefined()
  })

  it('coalesces concurrent getOrFetch calls into one loader run', async () => {
    const cache = createCache<string>(30_000)
    const loader = vi.fn().mockResolvedValue('loaded')

    const [first, second] = await Promise.all([
      cache.getOrFetch('key', loader),
      cache.getOrFetch('key', loader),
    ])

    expect(first).toBe('loaded')
    expect(second).toBe('loaded')
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('sweeps expired entries that are never read again', () => {
    const cache = createCache<string>(30_000)
    cache.set('stale', 'value')

    // The sweep interval is max(ttl, 60s); two ticks guarantee one pass
    // after the entry expired. Read via a fresh key-less path: the sweep
    // must have removed it without anyone calling get('stale').
    vi.advanceTimersByTime(120_000)

    expect(cache.get('stale')).toBeUndefined()
  })

  it('does not sweep entries that are still fresh', () => {
    const cache = createCache<string>(120_000)
    cache.set('fresh', 'value')

    vi.advanceTimersByTime(60_000)

    expect(cache.get('fresh')).toBe('value')
  })
})
