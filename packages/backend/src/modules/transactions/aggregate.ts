/**
 * Per-Safe explorer-API aggregation + caching, extracted verbatim from
 * `routes/transactions.ts` (#992). Fans out to `infra/explorer-api.ts`
 * (normal/internal/ERC-20 transfers), normalizes every source into
 * `Transaction`, sorts, dedupes, and caches the per-Safe result under
 * `buildTransactionCacheKey`. `infra/explorer-api.ts` stays in `infra/` (the
 * flat `lib/` was folded away by #998) — this module only consumes its public
 * fetchers.
 *
 * #3129: every value this module lifts out of an explorer response goes
 * through `normalize.ts` HERE, at the boundary where explorer data becomes a
 * `Transaction`, rather than at each read site — so a field added later
 * cannot silently skip it. Three classes, all present in this one function:
 *
 * - **Addresses** (`from`, `to`, `tokenAddress`) → `toCanonicalAddress`. The
 *   providers disagree about casing (Blockscout checksums, Etherscan
 *   lowercases), so the same field's form varied by CHAIN and one row could
 *   carry both forms at once.
 * - **`blockNumber`** → `toBlockNumber`. Was a bare `parseInt`, so a
 *   malformed v1 row produced `NaN` on a field the spec declared a required
 *   integer.
 * - **`timestamp`** → `toUnixSeconds`. Same bare `parseInt`, and `NaN` here
 *   makes `compareTransactions` inconsistent.
 *
 * Everything else the loops copy was already guarded at its own boundary and
 * was re-checked for this issue: `value` (`?? '0'`), `from`/`to` (`?? ''`),
 * `tokenDecimal` (`|| 18`), `tokenSymbol`/`functionName` (`?? ''`), `isError`
 * (an equality test, not a parse). `hash` is emitted exactly as the provider
 * sent it — a hash has no checksummed form, so there is nothing to settle on
 * the wire; what #3129 settled is the KEY, where `transactionDedupKey` now
 * lowercases like `paymentAgentIdentityKey` and the two frontend twins
 * already did.
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
import { toBlockNumber, toCanonicalAddress, toUnixSeconds } from './normalize.js'
import { buildTransactionCacheKey } from './cache-key.js'
import { compareTransactions, transactionDedupKey } from './ordering.js'
import type {
  FetchAccountTransactionsParams,
  FetchAccountTransactionsResult,
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
const txInflight = new Map<string, Promise<FetchAccountTransactionsResult>>()

export async function fetchAccountTransactions({
  accountId,
  accountAddress,
  chainId,
  log,
  fresh = false,
}: FetchAccountTransactionsParams): Promise<FetchAccountTransactionsResult> {
  const chain = getChain(chainId)
  const nativeToken = Object.values(chain.tokens).find((token) => token.address === null)!
  const cacheKey = buildTransactionCacheKey(chainId, accountAddress)

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
    const addrLower = accountAddress.toLowerCase()
    let hadFailures = false
    const logFail =
      <T,>(kind: string) =>
      (err: unknown) => {
        hadFailures = true
        log.warn({ err, chainId, accountId, accountAddress, kind }, 'Explorer API fetch failed')
        // A failed leg is unknown, not complete: it must not contribute a
        // `hasMore: true` the feed would report as truncation, nor mask one.
        return { rows: [] as T[], hasMore: false }
      }

    const normal = await fetchNormalTransactions(chainId, accountAddress).catch(
      logFail<RawNormalTx>('normal'),
    )
    const internal = await fetchInternalTransactions(chainId, accountAddress).catch(
      logFail<RawInternalTx>('internal'),
    )
    const erc20 = await fetchERC20Transfers(chainId, accountAddress).catch(
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
        from: toCanonicalAddress(tx.from),
        to: toCanonicalAddress(tx.to),
        value: tx.value,
        valueFormatted: formatTokenValue(tx.value, nativeToken.decimals),
        asset: nativeToken.symbol,
        decimals: nativeToken.decimals,
        direction: tx.to.toLowerCase() === addrLower ? 'in' : 'out',
        timestamp: toUnixSeconds(tx.timeStamp),
        blockNumber: toBlockNumber(tx.blockNumber),
        isError: tx.isError === '1',
      })
    }

    for (const tx of internalTxs) {
      if (tx.value === '0') continue

      transactions.push({
        hash: tx.hash,
        type: 'internal',
        from: toCanonicalAddress(tx.from),
        to: toCanonicalAddress(tx.to),
        value: tx.value,
        valueFormatted: formatTokenValue(tx.value, nativeToken.decimals),
        asset: nativeToken.symbol,
        decimals: nativeToken.decimals,
        direction: tx.to.toLowerCase() === addrLower ? 'in' : 'out',
        timestamp: toUnixSeconds(tx.timeStamp),
        blockNumber: toBlockNumber(tx.blockNumber),
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
        from: toCanonicalAddress(tx.from),
        to: toCanonicalAddress(tx.to),
        value: tx.value,
        valueFormatted: formatTokenValue(tx.value, decimals),
        asset: symbol,
        decimals,
        direction: tx.to.toLowerCase() === addrLower ? 'in' : 'out',
        timestamp: toUnixSeconds(tx.timeStamp),
        blockNumber: toBlockNumber(tx.blockNumber),
        isError: false,
        tokenAddress: toCanonicalAddress(tx.contractAddress),
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

    // Each leg pages to exhaustion or to EXPLORER_MAX_PAGES and reports which
    // (#2884): Blockscout by following its `next_page_params` cursor, the
    // Etherscan-shaped legs by walking pages until one comes back short. A
    // leg that stopped at the budget sets `hasMore`, and a failed leg is
    // unknown, not capped (logFail above pins it to `hasMore: false`), so
    // `truncated` still means exactly "this read was capped" — only now the
    // cap is the page budget, four windows deep, rather than the first one.
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
