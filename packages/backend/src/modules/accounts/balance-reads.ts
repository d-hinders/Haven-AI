// One shared balance-read cache (#3460, epic #3457 slice 3).
//
// The dashboard polls every 10 s while visible and reads the same on-chain
// balances through TWO in-process caches with different TTLs: `GET
// /balances/:addr` (30 s) and `fetchPortfolioForAccount` (60 s, behind
// /portfolio and /dashboard/overview). Under that poll pattern the two
// caches together re-read each account's native and ERC-20 balances about
// 2.4x/minute. This module replaces BOTH for balances with one cache keyed
// by (chainId, address), TTL 60 s — the longer of the two.
//
// ONE TTL LAYER (the issue's "decided here"): the portfolio's old 60 s
// `portfolioCache` is GONE — it used to cache the whole Portfolio envelope,
// which over this shared cache would have stacked two 60 s layers and could
// serve portfolio balances ~120 s old. `fetchPortfolioForAccount` now reads
// the cached balance reads fresh on every call and re-derives the envelope;
// the only other layer behind it is CoinGecko's own pre-existing 60 s price
// cache (`infra/prices.ts`, untouched by this change), so a portfolio's
// BALANCES are at most 60 s old — the same bound /balances has. Worst-case
// age per endpoint: /balances ≤ 60 s, /portfolio and /dashboard/overview
// balances ≤ 60 s, their price inputs ≤ 60 s (unchanged).
//
// One implementation detail had to move with the cache: `GET /balances` read
// through the ethers ChainClient (`getChainClient('ethers')`) while
// `fetchPortfolioForAccount` built its own ethers Contracts on the raw
// relayer provider. One shared cache needs one read shape, so BOTH paths go
// through the ethers ChainClient now — the reads are the same `balanceOf` /
// native-balance calls either way, and every test that mocked the provider
// keeps working.
import { createCache } from '../../platform/cache.js'
import { getChain } from '../../domain/chains.js'
import { getChainClient } from '../../infra/chain/index.js'
import {
  balanceFreshness,
  knownBalance,
  recordKnownBalance,
  type BalanceFreshness,
} from './balance-freshness.js'

/** The TTL, the longer of the two it replaces (30 s /balances, 60 s portfolio). */
export const BALANCE_READ_CACHE_TTL_MS = 60_000

/**
 * One cached read-set for one (chainId, address): native + every registry
 * ERC-20, as PromiseSettledResults so each consumer applies #3295's
 * degradation rules itself — a FAILED leg is never cached as a value, the
 * settled results carry the failure to whoever asked.
 */
export interface BalanceReads {
  native: PromiseSettledResult<bigint>
  erc20: PromiseSettledResult<bigint>[]
}

const balanceReadsCache = createCache<BalanceReads>(BALANCE_READ_CACHE_TTL_MS)

/**
 * The cache key. The address is lowercased — the chain answers case-
 * insensitively and the two former caches normalised the same way
 * (`bal:${chainId}:${address.toLowerCase()}`); one key space must not fork
 * on checksum casing.
 */
export function balanceReadsCacheKey(chainId: number, accountAddress: string): string {
  return `bal:${chainId}:${accountAddress.toLowerCase()}`
}

/**
 * The (cached) on-chain balance reads for one (chainId, address): the
 * native balance plus every registry ERC-20, read through the ethers
 * ChainClient. Concurrent callers share one in-flight load (platform/cache
 * single-flight); a completed read-set is served for the 60 s TTL.
 */
export async function fetchBalanceReads(
  chainId: number,
  accountAddress: string,
): Promise<BalanceReads> {
  return balanceReadsCache.getOrFetch(balanceReadsCacheKey(chainId, accountAddress), async () => {
    const chain = getChain(chainId)
    const client = getChainClient('ethers')
    const tokens = Object.values(chain.tokens)
    const erc20Tokens = tokens.filter((token) => token.address !== null)

    const results = await Promise.allSettled([
      client.getNativeBalance(chainId, accountAddress),
      ...erc20Tokens.map((token) =>
        client.getTokenBalance(chainId, token.address!, accountAddress),
      ),
    ])

    return { native: results[0], erc20: results.slice(1) }
  })
}

/**
 * Drop the cached read-set for one (chainId, address). Called right after a
 * FAILED read-set is served — a failed read is never cached, so the next
 * request re-reads the chain (#3292's rule, carried over verbatim; only
 * concurrent callers already waiting on the same in-flight load share it).
 * An unpriceable read over CLEAN reads (a price problem, #3296/#3297) does
 * not evict: the balances were read successfully and legitimately stay
 * cached; only the portfolio envelope is uncached.
 */
export function evictBalanceReads(chainId: number, accountAddress: string): void {
  balanceReadsCache.delete(balanceReadsCacheKey(chainId, accountAddress))
}

/**
 * Resolve one settled read against the last-known store (#3295): a fulfilled
 * read is recorded as the token's last-known balance and is fresh; a rejected
 * one substitutes the last-known value (or '0') and carries the marker.
 * Shared by both consumers so the two paths cannot drift — this is
 * `balances.ts`'s inline logic and `portfolio.ts`'s `resolveBalanceRead`,
 * which were textually identical apart from shape.
 */
export function resolveSettledBalance(
  chainId: number,
  accountAddress: string,
  tokenAddress: string | null,
  result: PromiseSettledResult<bigint>,
): { raw: string; freshness: BalanceFreshness | null } {
  if (result.status === 'fulfilled') {
    const raw = result.value.toString()
    recordKnownBalance(chainId, accountAddress, tokenAddress, raw)
    return { raw, freshness: null }
  }
  const known = knownBalance(chainId, accountAddress, tokenAddress)
  return { raw: known?.balance ?? '0', freshness: balanceFreshness(true, known) }
}

/**
 * Whether any leg of a read-set failed — the condition that makes a result
 * degraded on every path (#3295): the served balances carry markers, and the
 * result must not stay cached.
 */
export function balanceReadsDegraded(reads: BalanceReads): boolean {
  return reads.native.status === 'rejected' || reads.erc20.some((r) => r.status === 'rejected')
}
