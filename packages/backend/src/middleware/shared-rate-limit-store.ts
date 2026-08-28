/**
 * A cross-replica store for `@fastify/rate-limit` (#1680).
 *
 * The plugin's default store is an in-process LRU, so on an N-replica
 * deployment each replica counts only the requests routed to it: the real
 * ceiling is `max × N`, and it RISES with load, because more traffic means
 * more replicas. Live probing of dev read `x-ratelimit-remaining` back as two
 * interleaved descending series — a limit that reads as protection and does
 * not bind, which is the failure #1670 set out to avoid in the first place.
 *
 * Postgres rather than Redis: no new infrastructure, and this is already the
 * house pattern for process-local state that breaks under replicas — see the
 * leader lock, and the #692/#1196 allowance-nonce watermark that first
 * established it (that table went with the Safe rail in #2084; the pattern is
 * documented in `docs/operations/backend-scaling.md`). It brings the same two
 * obligations, both honoured below.
 *
 * **Fail-open, and bounded.** A database error, or a query slow enough to miss
 * the deadline, falls back to this instance's in-process count — the pre-#1680
 * behaviour — rather than refusing the request. On the signup and login
 * routes, failing closed would lock every user out of the front door over a
 * database hiccup; a briefly per-replica ceiling is the smaller harm by a wide
 * margin. Nothing here is authority.
 *
 * **Accepted residual, named rather than implied:** a query abandoned at the
 * deadline is not CANCELLED — it keeps a pool connection until Postgres
 * finishes with it. Under sustained slowness (as opposed to a clean outage)
 * that adds load to the very pool already struggling, and this hook runs on
 * far more traffic than the #718 watermark that set this precedent. The
 * alternative — waiting for a query that may never settle — is worse on a
 * request path, so the bound stays; it is a thing to watch during an incident,
 * not a thing to fix by removing the deadline.
 *
 * **The database is not consulted for a client already over its limit.** Once
 * a bucket exceeds `max`, the answer is fixed until the window ends, so it is
 * cached in memory and served from there. That matters because this table is
 * written by UNAUTHENTICATED traffic: without it, a flood costs one row-locked
 * upsert per request — cheap HTTP amplified into database contention on a
 * single hot row. With it, database writes per key per window are bounded by
 * `max` (per replica), and a flood settles into memory reads.
 */

import type { Executor } from '../infra/transaction.js'
import {
  incrementRateLimit,
  readRateLimit,
  type RateLimitCount,
} from '../infra/repositories/rate-limit-counters.js'

/**
 * How long to wait for the shared count before giving up and using the local
 * one. Matches the bound the allowance-nonce coordinator carried (#718;
 * deleted with its rail by #1987) and the reason is identical: a rejection is the easy failure, a query that is slow but
 * never settles is the one that would actually hang a request — and neither
 * the pool (no `statement_timeout`) nor Fastify (no request timeout) would
 * stop it.
 */
export const SHARED_STORE_DEADLINE_MS = 250

/** Bounds both in-memory caches. Far above any real count of live offenders. */
const CACHE_SIZE = 5000

/**
 * Where degradations are reported. A module-level setter rather than a
 * constructor option because the PLUGIN constructs this store — it does
 * `new Store(globalParams)`, and `globalParams` is assembled field by field
 * from the options the plugin knows, so an unrecognised `onDegraded` would be
 * silently dropped. Same wiring shape as `setReceiptSigningKey` / `setAnchor`
 * in index.ts, for the same reason.
 *
 * Reporting matters here: falling back to per-replica counting is exactly the
 * defect this store exists to fix, so it must never happen quietly.
 */
let reportDegraded: (reason: 'error' | 'deadline') => void = () => {}

export function setRateLimitDegradedReporter(
  reporter: (reason: 'error' | 'deadline') => void,
): void {
  reportDegraded = reporter
}

/**
 * A minimal size-bounded map: on overflow it drops the oldest insertions.
 *
 * Hand-rolled rather than reaching for `toad-cache` — that package is a
 * TRANSITIVE dependency of the rate-limit plugin, not a declared one of this
 * package, and importing it here would be a phantom dependency that breaks the
 * day the plugin swaps caches. What is needed is a bound, not an eviction
 * policy: both maps hold throwaway per-window state, so evicting the oldest
 * entry can only cost a degraded-path count or an early un-block, never
 * correctness.
 */
class BoundedMap<V> {
  private readonly entries = new Map<string, V>()

  constructor(private readonly limit: number) {}

  get(key: string): V | undefined {
    return this.entries.get(key)
  }

  set(key: string, value: V): void {
    // Re-insert so the key moves to the end of Map's insertion order,
    // otherwise a long-lived hot key would be evicted before a cold one.
    this.entries.delete(key)
    this.entries.set(key, value)
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.entries.delete(oldest.value)
    }
  }

  delete(key: string): void {
    this.entries.delete(key)
  }

  get size(): number {
    return this.entries.size
  }
}

interface StoreResult {
  current: number
  ttl: number
}

type Callback = (err: Error | null, result?: StoreResult) => void

export interface SharedRateLimitStoreOptions {
  timeWindow?: number
  max?: number
  db?: Executor
  deadlineMs?: number
}

/**
 * Local per-window counts, used only when the shared store cannot answer.
 * Deliberately a plain map rather than the plugin's LocalStore: the fallback
 * needs the same window semantics, and reimplementing them here keeps the
 * degraded path readable instead of reaching into the plugin's internals.
 */
interface LocalEntry {
  current: number
  startedAtMs: number
}

export class SharedRateLimitStore {
  private readonly timeWindow: number
  private readonly max: number
  private readonly db: Executor | undefined
  private readonly deadlineMs: number

  /** key → epoch ms until which the key is known to be over its limit. */
  private readonly blockedUntil = new BoundedMap<number>(CACHE_SIZE)
  private readonly local = new BoundedMap<LocalEntry>(CACHE_SIZE)

  constructor(options: SharedRateLimitStoreOptions = {}) {
    this.timeWindow = options.timeWindow ?? 60_000
    this.max = options.max ?? 0
    this.db = options.db
    this.deadlineMs = options.deadlineMs ?? SHARED_STORE_DEADLINE_MS
  }

  /**
   * The plugin creates one child per route, carrying that route's `max` and
   * `timeWindow`. Children share nothing: each keeps its own caches, which is
   * correct because the SHARED count lives in Postgres — the caches are only
   * ever a degraded fallback or a blocked-key shortcut.
   */
  child(routeOptions: { timeWindow?: number; max?: number }): SharedRateLimitStore {
    return new SharedRateLimitStore({
      timeWindow: routeOptions.timeWindow ?? this.timeWindow,
      max: typeof routeOptions.max === 'number' ? routeOptions.max : this.max,
      db: this.db,
      deadlineMs: this.deadlineMs,
    })
  }

  incr(key: string, cb: Callback, timeWindow?: number, max?: number): void {
    const window = timeWindow ?? this.timeWindow
    const ceiling = max ?? this.max

    const blockedFor = this.blockedRemainingMs(key)
    if (blockedFor !== null) {
      // Already over the limit this window. The answer cannot change until the
      // window ends, so do not pay a database write to re-learn it.
      cb(null, { current: ceiling + 1, ttl: blockedFor })
      return
    }

    void this.withDeadline(incrementRateLimit(key, window, this.db))
      .then((shared) => {
        if (shared === null) {
          cb(null, this.countLocally(key, window))
          return
        }
        // `ceiling > 0` guards a route configured with `max: 0` (deny all),
        // which nothing does today: such a route is over its limit from the
        // first request, and caching that would be correct — but the check
        // costs nothing and keeps a 0 from meaning "no ceiling configured".
        if (ceiling > 0 && shared.current > ceiling) {
          this.blockedUntil.set(key, Date.now() + shared.ttl)
        }
        cb(null, shared)
      })
      .catch(() => {
        // Unreachable in practice — withDeadline resolves rather than rejects
        // — but a store that throws would 500 the route it is protecting.
        cb(null, this.countLocally(key, window))
      })
  }

  read(key: string, cb: Callback, timeWindow?: number): void {
    const window = timeWindow ?? this.timeWindow

    void this.withDeadline(readRateLimit(key, this.db))
      .then((shared) => {
        cb(null, shared ?? this.peekLocally(key, window))
      })
      .catch(() => {
        cb(null, this.peekLocally(key, window))
      })
  }

  /** Milliseconds a key stays blocked, or `null` if it is not blocked now. */
  private blockedRemainingMs(key: string): number | null {
    const until = this.blockedUntil.get(key)
    if (until === undefined) return null
    const remaining = until - Date.now()
    if (remaining <= 0) {
      this.blockedUntil.delete(key)
      return null
    }
    return remaining
  }

  /**
   * Races a shared-store call against the deadline. Resolves to `null` on
   * either failure so both degrade down one identical path.
   */
  private async withDeadline(
    work: Promise<RateLimitCount | null>,
  ): Promise<RateLimitCount | null> {
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<'deadline'>((resolve) => {
      timer = setTimeout(() => resolve('deadline'), this.deadlineMs)
      timer.unref?.()
    })

    try {
      const outcome = await Promise.race([work, deadline])
      if (outcome === 'deadline') {
        reportDegraded('deadline')
        return null
      }
      if (outcome === null) reportDegraded('error')
      return outcome
    } catch {
      reportDegraded('error')
      return null
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private countLocally(key: string, window: number): StoreResult {
    const now = Date.now()
    const entry = this.local.get(key)

    if (!entry || entry.startedAtMs + window <= now) {
      this.local.set(key, { current: 1, startedAtMs: now })
      return { current: 1, ttl: window }
    }

    entry.current += 1
    this.local.set(key, entry)
    return { current: entry.current, ttl: window - (now - entry.startedAtMs) }
  }

  private peekLocally(key: string, window: number): StoreResult {
    const now = Date.now()
    const entry = this.local.get(key)
    if (!entry || entry.startedAtMs + window <= now) return { current: 0, ttl: 0 }
    return { current: entry.current, ttl: window - (now - entry.startedAtMs) }
  }
}
