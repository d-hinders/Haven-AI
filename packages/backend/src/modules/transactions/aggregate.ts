/**
 * Per-Safe explorer-API aggregation + caching, extracted verbatim from
 * `routes/transactions.ts` (#992). Fans out to `infra/explorer-api.ts`
 * (normal/internal/ERC-20 transfers), normalizes every source into
 * `Transaction`, sorts, dedupes, and caches the per-Safe result under
 * `buildTransactionCacheKey`. `infra/explorer-api.ts` and `infra/gnosisscan.ts`
 * stay in `infra/` (the flat `lib/` was folded away by #998) — this module
 * only consumes their
 * public fetchers.
 *
 * #2849 (safe-retirement slice 3) removed the Safe Transaction Service leg:
 * it was fetched unconditionally for every account, but a Hybrid DeleGator
 * is unknown to that service, so the leg failed on every delegation-rail
 * history read and permanently pinned `hadFailures` — the partial-failure
 * signal was always on. Blockscout is the source for retired-rail rows too
 * (#2669), so rows are unchanged; a healthy read now reports
 * `hadFailures: false`.
 */
import {
  fetchNormalTransactions,
  fetchInternalTransactions,
  fetchERC20Transfers,
  type RawERC20Transfer,
  type RawInternalTx,
  type RawNormalTx,
} from '../../infra/explorer-api.js'
import { getChain } from '../../domain/chains.js'
import { formatTokenValue } from '../../domain/tokens.js'
import { createCache } from '../../platform/cache.js'
import { buildTransactionCacheKey } from './cache-key.js'
import { compareTransactions, transactionDedupKey } from './ordering.js'
import type {
  FetchSafeTransactionsParams,
  FetchSafeTransactionsResult,
  Transaction,
} from './types.js'

/**
 * Cached per account. The truncation flag rides WITH the rows (#2882) rather
 * than beside them: it is a property of the read that produced them, so a
 * cache hit that returned only the rows would report a capped read as a
 * complete one for the rest of the TTL.
 */
interface CachedRead {
  transactions: Transaction[]
  truncated: boolean
}

const txCache = createCache<CachedRead>(30_000)
const txInflight = new Map<string, Promise<FetchSafeTransactionsResult>>()

export async function fetchSafeTransactions({
  safeId,
  safeAddress,
  chainId,
  log,
  fresh = false,
}: FetchSafeTransactionsParams): Promise<FetchSafeTransactionsResult> {
  const chain = getChain(chainId)
  const nativeToken = Object.values(chain.tokens).find((token) => token.address === null)!
  const cacheKey = buildTransactionCacheKey(chainId, safeAddress)

  if (fresh) {
    txCache.delete(cacheKey)
  }

  const cached = txCache.get(cacheKey)
  if (cached !== undefined) {
    return { transactions: cached.transactions, hadFailures: false, truncated: cached.truncated }
  }

  const inflight = txInflight.get(cacheKey)
  if (inflight) {
    return inflight
  }

  const requestPromise = (async () => {
    const addrLower = safeAddress.toLowerCase()
    let hadFailures = false
    const logFail =
      <T,>(kind: string) =>
      (err: unknown) => {
        hadFailures = true
        log.warn({ err, chainId, safeId, safeAddress, kind }, 'Explorer API fetch failed')
        // A failed leg is unknown, not complete: it must not contribute a
        // `hasMore: true` the feed would report as truncation, nor mask one.
        return { rows: [] as T[], hasMore: false }
      }

    const normal = await fetchNormalTransactions(chainId, safeAddress).catch(
      logFail<RawNormalTx>('normal'),
    )
    const internal = await fetchInternalTransactions(chainId, safeAddress).catch(
      logFail<RawInternalTx>('internal'),
    )
    const erc20 = await fetchERC20Transfers(chainId, safeAddress).catch(
      logFail<RawERC20Transfer>('erc20'),
    )

    const normalTxs = normal.rows
    const internalTxs = internal.rows
    const erc20Txs = erc20.rows

    const transactions: Transaction[] = []

    for (const tx of normalTxs) {
      if (tx.value === '0' && tx.functionName) continue

      transactions.push({
        hash: tx.hash,
        type: 'native',
        from: tx.from,
        to: tx.to,
        value: tx.value,
        valueFormatted: formatTokenValue(tx.value, nativeToken.decimals),
        asset: nativeToken.symbol,
        decimals: nativeToken.decimals,
        direction: tx.to.toLowerCase() === addrLower ? 'in' : 'out',
        timestamp: parseInt(tx.timeStamp, 10),
        blockNumber: parseInt(tx.blockNumber, 10),
        isError: tx.isError === '1',
      })
    }

    for (const tx of internalTxs) {
      if (tx.value === '0') continue

      transactions.push({
        hash: tx.hash,
        type: 'internal',
        from: tx.from,
        to: tx.to,
        value: tx.value,
        valueFormatted: formatTokenValue(tx.value, nativeToken.decimals),
        asset: nativeToken.symbol,
        decimals: nativeToken.decimals,
        direction: tx.to.toLowerCase() === addrLower ? 'in' : 'out',
        timestamp: parseInt(tx.timeStamp, 10),
        blockNumber: parseInt(tx.blockNumber, 10),
        isError: tx.isError === '1',
      })
    }

    for (const tx of erc20Txs) {
      const knownToken = chain.tokenByAddress[tx.contractAddress.toLowerCase()]
      const symbol = knownToken?.symbol ?? tx.tokenSymbol ?? tx.contractAddress
      const decimals = knownToken?.decimals ?? (parseInt(tx.tokenDecimal, 10) || 18)

      transactions.push({
        hash: tx.hash,
        type: 'erc20',
        from: tx.from,
        to: tx.to,
        value: tx.value,
        valueFormatted: formatTokenValue(tx.value, decimals),
        asset: symbol,
        decimals,
        direction: tx.to.toLowerCase() === addrLower ? 'in' : 'out',
        timestamp: parseInt(tx.timeStamp, 10),
        blockNumber: parseInt(tx.blockNumber, 10),
        isError: false,
        tokenAddress: tx.contractAddress,
        tokenSymbol: symbol,
      })
    }

    transactions.sort(compareTransactions)

    const seen = new Set<string>()
    const deduped = transactions.filter((tx) => {
      const key = transactionDedupKey(tx)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    // Each leg reports for itself whether the provider has more beyond what
    // it returned — Blockscout by its `next_page_params` cursor, the
    // Etherscan-shaped legs by a full page, since they offer no cursor. Where
    // the count IS the signal it errs toward "there may be more": a source
    // holding exactly one window reports one caveat too many rather than
    // claiming a completeness it cannot know. #2884 removes the remaining
    // guess by paginating; this only stops the silence.
    const truncated = normal.hasMore || internal.hasMore || erc20.hasMore

    txCache.set(cacheKey, { transactions: deduped, truncated })

    return {
      transactions: deduped,
      hadFailures,
      truncated,
    }
  })().finally(() => {
    txInflight.delete(cacheKey)
  })

  txInflight.set(cacheKey, requestPromise)
  return requestPromise
}
