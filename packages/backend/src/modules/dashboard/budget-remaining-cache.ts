/**
 * Display-only cache for the dashboard's on-chain budget-remaining reads
 * (#3804).
 *
 * ## What is cached, and what must never be
 *
 * ONLY the enforcer read is cached, keyed by `(chain_id, delegation_hash)`.
 * `readRemainingBudget` itself is UNCHANGED and stays the fresh read behind
 * every spend decision — the pre-checks, x402 authorisation, payments,
 * balance coverage, allowances, the re-key meter, task budgets and merchants
 * all read it directly. Nothing that decides spend may import this module:
 * `modules/dashboard/__tests__/budget-remaining-import-guard.test.ts` pins
 * the new dashboard route as its ONLY importer. The cache is display
 * currency: up to 60 s stale after a payment is accepted (owner decision 1,
 * `read_at` carried on every entry), never part of any authority check.
 *
 * ## Expiry
 *
 * An entry expires at the EARLIER of read time + 60 s and the period end in
 * force at the read — a cached read must never pair the last period's spend
 * with the new period, so the entry dies at the boundary even when the TTL
 * has not run out. The route passes the period end it computed from the SAME
 * `currentPeriodBounds` helper the other budget views use.
 *
 * ## Failures (#3292's rule, via the balance cache's #3460 precedent)
 *
 * A `fromChain: false` result is served to the requests already waiting on
 * it, then evicted — never cached. The next request re-reads the chain.
 * Route-level deadlines are the route's business: reads that miss the 4 s
 * budget return as unknown there, while the underlying read (bounded at
 * REMAINING_READ_TIMEOUT_MS by the reader itself) still completes and caches
 * normally for the next poll.
 *
 * ## Clock
 *
 * `nowMs` is injectable so the cache tests can run a fake clock; production
 * callers omit it. The read time is anchored at the FIRST caller's request
 * time (the moment the loader starts), which is if anything conservative —
 * a slow read makes the entry effectively fresher than `read_at` claims.
 */

import { readRemainingBudget } from '../../infra/chain/delegation-budget-reader.js'

/** The display TTL. The dashboard polls on its own 60 s cadence (#3804). */
export const BUDGET_REMAINING_CACHE_TTL_MS = 60_000

export interface BudgetRemainingParams {
  chainId: number
  delegationHash: string
  delegationJson: string
  budgetAtomic: string
  /**
   * The period end IN FORCE AT THE READ (unix seconds) — the entry never
   * outlives it. `routes/dashboard-budget-remaining.ts` computes it with
   * `currentPeriodBounds` from the row's own `start_date`/`period_seconds`.
   */
  periodEndSec: number
  /** Injectable clock (unix ms) for tests; defaults to Date.now(). */
  nowMs?: number
}

export type BudgetRemainingOutcome =
  | { status: 'known'; remainingAtomic: string; readAtMs: number }
  | { status: 'unknown' }

interface CacheEntry {
  remainingAtomic: string
  readAtMs: number
  expiresAtMs: number
}

const store = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<BudgetRemainingOutcome>>()

/**
 * The cache key. `delegation_hash` is the on-chain identity (VARCHAR(66),
 * `agent_delegations` UNIQUE) — lowercased so casing can never fork the key
 * space, the same normalisation the balance cache applies to addresses.
 */
export function budgetRemainingCacheKey(chainId: number, delegationHash: string): string {
  return `br:${chainId}:${delegationHash.toLowerCase()}`
}

/** Test seam: drop every entry and in-flight load. */
export function resetBudgetRemainingCacheForTests(): void {
  store.clear()
  inflight.clear()
}

function expiryFor(nowMs: number, periodEndSec: number): number {
  return Math.min(nowMs + BUDGET_REMAINING_CACHE_TTL_MS, periodEndSec * 1000)
}

/**
 * The (cached) remaining budget for one delegation. Concurrent callers for
 * the same key share one in-flight read; a hit is served until the earlier
 * of TTL and period end. A failed read resolves `unknown` for everyone
 * waiting and caches nothing.
 */
export function fetchBudgetRemaining(params: BudgetRemainingParams): Promise<BudgetRemainingOutcome> {
  const nowMs = params.nowMs ?? Date.now()
  const key = budgetRemainingCacheKey(params.chainId, params.delegationHash)

  const cached = store.get(key)
  if (cached) {
    if (nowMs < cached.expiresAtMs) {
      return Promise.resolve({
        status: 'known',
        remainingAtomic: cached.remainingAtomic,
        readAtMs: cached.readAtMs,
      })
    }
    store.delete(key)
  }

  const existing = inflight.get(key)
  if (existing) return existing

  const promise = readRemainingBudget(params.chainId, params.delegationJson, params.budgetAtomic)
    .then((res): BudgetRemainingOutcome => {
      if (!res.fromChain) {
        // A failed read is NEVER cached: served to the requests already
        // waiting on this load, then the next request re-reads the chain.
        return { status: 'unknown' }
      }
      store.set(key, {
        remainingAtomic: res.remainingAtomic,
        readAtMs: nowMs,
        expiresAtMs: expiryFor(nowMs, params.periodEndSec),
      })
      return { status: 'known', remainingAtomic: res.remainingAtomic, readAtMs: nowMs }
    })
    .finally(() => {
      inflight.delete(key)
    })
  inflight.set(key, promise)
  return promise
}
