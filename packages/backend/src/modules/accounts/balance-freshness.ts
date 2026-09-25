// Last-known balance store and the degraded-balance marker (#3295).
//
// A failed on-chain balance read used to be indistinguishable from a real
// zero: `fetchPortfolioForAccount` and `GET /balances` mapped a rejected read
// to '0' and every screen rendered an understated total as if it were known
// (the dRPC batch-limit incident, #2769). PR #3292 stopped the zero from being
// CACHED; this module completes the fix at the display layer.
//
// Three pieces, all in-process and per replica (owner decision 2026-09-25):
//
//  1. The last-known balance per (chain, account, token), written ONLY by
//     successful reads. A failed read substitutes it, so a display blip shows
//     the last figure we actually saw, marked stale, instead of a zero. It
//     resets on deploy, which is acceptable for a display value and needs no
//     migration; Postgres/Redis is a follow-up only if multi-replica use makes
//     the gap visible.
//
//  2. `BalanceFreshness` — the additive wire marker. `status: 'stale'` carries
//     `asOf`, when the served value was last read from the chain.
//     `status: 'unavailable'` says no balance has EVER been read for the token
//     (first read after a deploy), so the consumer knows the accompanying
//     balance string is a filler, not a figure. The marker is ABSENT on a
//     clean read — a fresh response is byte-identical to the pre-#3295 one.
//
//  3. The predicates `hasDegradedBalances` and `combineBalanceFreshness`.
//     #3296 (snapshot gating) and #3297 (last-good prices) build on this
//     module rather than writing a second parallel marker.

/** The last balance successfully read from the chain for one token. */
export interface LastKnownBalance {
  /** Raw base units as a decimal string — the same shape the reads return. */
  balance: string
  /** ISO 8601 timestamp of the successful read. */
  asOf: string
}

/**
 * Additive marker on a balance entry whose underlying read did not succeed.
 * Absent entirely when the read was clean; `asOf` is present exactly when
 * `status` is `'stale'`.
 */
export type BalanceFreshness =
  | { status: 'stale'; asOf: string }
  | { status: 'unavailable' }

const lastKnown = new Map<string, LastKnownBalance>()

/**
 * Store key for one (chain, account, token) triple. Token address is
 * lowercased; the chain-native token is `null` on the wire and 'native' here.
 */
export function lastKnownBalanceKey(
  chainId: number,
  accountAddress: string,
  tokenAddress: string | null,
): string {
  const tokenKey = tokenAddress === null ? 'native' : tokenAddress.toLowerCase()
  return `${chainId}:${accountAddress.toLowerCase()}:${tokenKey}`
}

/**
 * Record a successful read. Stores even a zero — a successful read of zero is
 * the truth, and substituting it on a later failure is correct.
 */
export function recordKnownBalance(
  chainId: number,
  accountAddress: string,
  tokenAddress: string | null,
  balance: string,
): void {
  lastKnown.set(lastKnownBalanceKey(chainId, accountAddress, tokenAddress), {
    balance,
    asOf: new Date().toISOString(),
  })
}

/** The last successfully read balance for this token, if any. */
export function knownBalance(
  chainId: number,
  accountAddress: string,
  tokenAddress: string | null,
): LastKnownBalance | undefined {
  return lastKnown.get(lastKnownBalanceKey(chainId, accountAddress, tokenAddress))
}

/**
 * The marker for one token's read result. A fulfilled read is fresh (the
 * caller omits the marker); a rejected one is stale when a last-known value
 * exists — served substituted — and unavailable when none does (the caller
 * serves '0' as a filler).
 */
export function balanceFreshness(
  readFailed: boolean,
  known: LastKnownBalance | undefined,
): BalanceFreshness | null {
  if (!readFailed) return null
  if (known) return { status: 'stale', asOf: known.asOf }
  return { status: 'unavailable' }
}

/**
 * Whether any entry in `items` carries a degraded-balance marker — the
 * predicate #3296 gates the daily snapshot insert on, and the one this issue
 * owns for #3296/#3297 to reuse. Works over portfolio breakdown items and
 * balance-route items alike: both carry the same optional marker field.
 */
export function hasDegradedBalances(
  items: ReadonlyArray<{ balanceFreshness?: BalanceFreshness }>,
): boolean {
  return items.some((item) => item.balanceFreshness !== undefined)
}

/**
 * Worst-of across markers, for totals and aggregated envelopes. An
 * unavailable token makes the whole figure understated by an unknown amount
 * (worse than stale); among stale markers the OLDEST asOf wins, because the
 * total is at least as old as its oldest part.
 */
export function combineBalanceFreshness(
  markers: ReadonlyArray<BalanceFreshness | undefined | null>,
): BalanceFreshness | null {
  let oldestStaleAsOf: string | undefined
  let anyUnavailable = false
  for (const marker of markers) {
    if (!marker) continue
    if (marker.status === 'unavailable') {
      anyUnavailable = true
      continue
    }
    if (oldestStaleAsOf === undefined || marker.asOf < oldestStaleAsOf) {
      oldestStaleAsOf = marker.asOf
    }
  }
  if (anyUnavailable) return { status: 'unavailable' }
  if (oldestStaleAsOf !== undefined) return { status: 'stale', asOf: oldestStaleAsOf }
  return null
}

/**
 * Test seam — the store is module-level and outlives individual tests.
 * Production code never calls this; the store is deliberately allowed to
 * grow with (chain, account, token) triples observed this process lifetime.
 */
export function resetLastKnownBalancesForTests(): void {
  lastKnown.clear()
}
