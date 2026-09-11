/**
 * Per-Safe explorer-API aggregation + caching, extracted verbatim from
 * `routes/transactions.ts` (#992). Fans out to `lib/explorer-api.ts`
 * (normal/internal/ERC-20 transfers), normalizes every source into
 * `Transaction`, sorts, dedupes, and caches the per-Safe result under
 * `buildTransactionCacheKey`. `lib/explorer-api.ts` and `lib/gnosisscan.ts`
 * stay in `lib/` per the #992 scope — this module only consumes their
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

const txCache = createCache<Transaction[]>(30_000)
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
    return { transactions: cached, hadFailures: false }
  }

  const inflight = txInflight.get(cacheKey)
  if (inflight) {
    return inflight
  }

  const requestPromise = (async () => {
    const addrLower = safeAddress.toLowerCase()
    let hadFailures = false
    const logFail = (kind: string) => (err: unknown) => {
      hadFailures = true
      log.warn({ err, chainId, safeId, safeAddress, kind }, 'Explorer API fetch failed')
      return []
    }

    const normalTxs = await fetchNormalTransactions(chainId, safeAddress).catch(
      logFail('normal'),
    )
    const internalTxs = await fetchInternalTransactions(chainId, safeAddress).catch(
      logFail('internal'),
    )
    const erc20Txs = await fetchERC20Transfers(chainId, safeAddress).catch(
      logFail('erc20'),
    )

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

    txCache.set(cacheKey, deduped)

    return {
      transactions: deduped,
      hadFailures,
    }
  })().finally(() => {
    txInflight.delete(cacheKey)
  })

  txInflight.set(cacheKey, requestPromise)
  return requestPromise
}
