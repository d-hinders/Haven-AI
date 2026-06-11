/**
 * Shared TTL cache used by routes and library modules.
 *
 * Currently backed by an in-process Map — the same shape as a Redis-backed
 * implementation, so swapping this out when the backend is deployed as
 * more than one instance is a one-file change (replace the body of
 * `createCache` with a Redis client; callers don't move).
 *
 * Single-flight coalescing: concurrent `getOrFetch` calls for the same key
 * share a single in-flight loader. This matters for routes like the
 * transactions/balances endpoints, where a page load can fan out several
 * requests targeting the same Safe at once.
 */

export interface Cache<T> {
  /** Returns the cached value, or undefined if missing or expired. */
  get(key: string): T | undefined
  /** Overwrites the entry with a fresh timestamp. */
  set(key: string, value: T): void
  /** Drops a key; no-op if absent. */
  delete(key: string): void
  /**
   * Returns the cached value, or calls `loader` once and caches its result.
   * Concurrent calls for the same key share the same loader promise.
   */
  getOrFetch(key: string, loader: () => Promise<T>): Promise<T>
}

export function createCache<T>(ttlMs: number): Cache<T> {
  const store = new Map<string, { data: T; ts: number }>()
  const inflight = new Map<string, Promise<T>>()

  // Expired entries are otherwise only dropped when their own key is read
  // again — keys that never get re-read (removed Safes, departed users)
  // would accumulate forever in a long-lived process.
  setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of store) {
      if (now - entry.ts >= ttlMs) store.delete(key)
    }
  }, Math.max(ttlMs, 60_000)).unref()

  const get = (key: string): T | undefined => {
    const entry = store.get(key)
    if (!entry) return undefined
    if (Date.now() - entry.ts >= ttlMs) {
      store.delete(key)
      return undefined
    }
    return entry.data
  }

  const set = (key: string, value: T): void => {
    store.set(key, { data: value, ts: Date.now() })
  }

  return {
    get,
    set,
    delete(key) {
      store.delete(key)
    },
    async getOrFetch(key, loader) {
      const cached = get(key)
      if (cached !== undefined) return cached

      const existing = inflight.get(key)
      if (existing) return existing

      const promise = loader()
        .then((value) => {
          set(key, value)
          return value
        })
        .finally(() => {
          inflight.delete(key)
        })
      inflight.set(key, promise)
      return promise
    },
  }
}
