/**
 * Route-shaped orchestration for the transactions module (#992): each
 * function here corresponds to one `routes/transactions.ts` handler's
 * aggregation pipeline, so the route itself is left doing only request
 * validation, auth wiring, and response serialization. Extracted verbatim
 * from the route — sequencing and behavior are unchanged.
 */
import type { FastifyBaseLogger } from 'fastify'
import {
  listAgentsForTransactionFilters,
  listBasicSafesForUser,
  type TransactionFilterAgentRow,
} from '../../infra/repositories/transaction-history.js'
import { getChain } from '../../domain/chains.js'
import { fetchSafeTransactions } from './aggregate.js'
import { compareEnrichedTransactions, enrichedTransactionIdentityKey } from './ordering.js'
import { enrichTransactionsWithAgents } from './enrichment.js'
import { enrichTransactionsWithAccounting } from './accounting.js'
import { fetchConfirmedX402Transactions, mergeX402Transactions } from './x402.js'
import type { EnrichedTransaction, ParsedTokenFilter, Transaction, UserSafeRow } from './types.js'

// ── GET / (paginated, filterable feed across every owned Safe) ─────────────

export interface AggregateSafeTransactionsResult {
  merged: EnrichedTransaction[]
  failedSafeIds: string[]
  /**
   * Any account's history came back cut off at the explorer window (#2882).
   * Aggregated with OR: one capped account makes the whole feed incomplete,
   * because the rows are merged into one list and the caller cannot tell
   * which account's tail is missing.
   *
   * Computed BEFORE `filterEnrichedTransactions`, deliberately. A view
   * filtered down to a small, complete account still reports truncation when
   * some other account is capped — one caveat too many rather than a false
   * claim of completeness, which is the direction every judgement call in
   * this feature errs toward. Making it filter-aware would mean deciding
   * which accounts a filter can still reach, and the honest answer for an
   * unfiltered `total` is the one here.
   */
  truncated: boolean
}

/** Fans `fetchSafeTransactions` out across every Safe, tagging each transaction with its Safe. */
export async function aggregateSafeTransactions(
  safes: UserSafeRow[],
  log: FastifyBaseLogger,
  fresh: boolean,
): Promise<AggregateSafeTransactionsResult> {
  const merged: EnrichedTransaction[] = []
  const failedSafeIds: string[] = []
  let truncated = false

  for (const safe of safes) {
    try {
      const { transactions, hadFailures, truncated: safeTruncated } = await fetchSafeTransactions({
        safeId: safe.id,
        safeAddress: safe.safe_address,
        chainId: safe.chain_id,
        log,
        fresh,
      })

      if (hadFailures) {
        failedSafeIds.push(safe.id)
      }

      if (safeTruncated) {
        truncated = true
      }

      for (const tx of transactions) {
        merged.push({
          ...tx,
          chainId: safe.chain_id,
          safeId: safe.id,
          safeAddress: safe.safe_address,
          safeName: safe.name,
        })
      }
    } catch (err) {
      failedSafeIds.push(safe.id)
      log.warn(
        { err, safeId: safe.id, safeAddress: safe.safe_address, chainId: safe.chain_id },
        'Safe transaction aggregation failed',
      )
    }
  }

  return { merged, failedSafeIds, truncated }
}

/** x402-merge, sort, dedupe, and agent-enrich the full merged feed (pre-filter, pre-paginate). */
export async function mergeSortDedupeAndEnrich(
  userId: string,
  safes: UserSafeRow[],
  merged: EnrichedTransaction[],
): Promise<EnrichedTransaction[]> {
  const mergedWithX402 = await mergeX402Transactions(userId, safes, merged)

  mergedWithX402.sort(compareEnrichedTransactions)

  const seen = new Set<string>()
  const deduped = mergedWithX402.filter((tx) => {
    const key = enrichedTransactionIdentityKey(tx)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  return enrichTransactionsWithAgents(userId, deduped)
}

export interface TransactionFilterOptions {
  agentId?: string
  tokenFilter?: ParsedTokenFilter | null
  /**
   * Direction and chain, applied server-side for the CSV export (#2871).
   *
   * The dashboard has always filtered these two in the browser, over the page
   * it had loaded (`TransactionsClient`'s `visibleTransactions`). The export
   * runs over the whole result set, so it has to apply them here or the file
   * would not match the list it was taken from. Both are optional and the
   * `GET /` feed passes neither, so its behaviour is unchanged.
   */
  direction?: 'in' | 'out'
  chainId?: number
}

/** The agentId (including the synthetic `user`) and tokenKey filters applied to the GET / feed. */
export function filterEnrichedTransactions(
  transactions: EnrichedTransaction[],
  options: TransactionFilterOptions,
): EnrichedTransaction[] {
  return transactions.filter((tx) => {
    if (options.direction && tx.direction !== options.direction) return false
    if (options.chainId !== undefined && tx.chainId !== options.chainId) return false

    if (options.agentId === 'user') {
      return tx.direction === 'out' && !tx.agentId
    }

    if (options.agentId && options.agentId !== 'user' && tx.agentId !== options.agentId) {
      return false
    }

    if (options.tokenFilter) {
      if (tx.chainId !== options.tokenFilter.chainId) return false
      if (options.tokenFilter.address === null) {
        if (tx.type === 'erc20') return false
      } else if (
        tx.type !== 'erc20' ||
        tx.tokenAddress?.toLowerCase() !== options.tokenFilter.address
      ) {
        return false
      }
    }

    return true
  })
}

export interface OffsetPage<T> {
  page: T[]
  hasMore: boolean
}

export function paginateByOffset<T>(items: T[], offset: number, limit: number): OffsetPage<T> {
  const page = items.slice(offset, offset + limit)
  return { page, hasMore: items.length > offset + page.length }
}

// ── GET /:safeAddress (legacy single-Safe, page/limit pagination) ──────────

export interface SafeTransactionsPageParams {
  userId: string
  safeId: string
  safeAddress: string
  chainId: number
  log: FastifyBaseLogger
  fresh: boolean
  page: number
  limit: number
}

export interface SafeTransactionsPage {
  /** Still carries `chainId`/`safeId`/`safeAddress`/`safeName`/`agentId` — the route strips those for serialization. */
  transactions: EnrichedTransaction[]
  total: number
}

/**
 * The `/:safeAddress` pipeline: fetch, x402-merge, sort (NOT deduped — matches
 * the pre-#992 route, which only dedupes on the multi-Safe `GET /` feed),
 * paginate, then enrich only the paginated page (enrichment runs after
 * pagination here, unlike `mergeSortDedupeAndEnrich`, to avoid attributing
 * agents to rows that are never returned).
 */
export async function buildSafeTransactionsPage(
  params: SafeTransactionsPageParams,
): Promise<SafeTransactionsPage> {
  const { userId, safeId, safeAddress, chainId, log, fresh, page, limit } = params
  const { transactions: allTransactions } = await fetchSafeTransactions({
    safeId,
    safeAddress,
    chainId,
    log,
    fresh,
  })

  const userSafe: UserSafeRow = {
    id: safeId,
    safe_address: safeAddress,
    chain_id: chainId,
    name: '',
  }
  const enrichedAllTransactions = await mergeX402Transactions(
    userId,
    [userSafe],
    allTransactions.map((tx) => ({
      ...tx,
      chainId,
      safeId,
      safeAddress,
      safeName: '',
    })),
  )

  enrichedAllTransactions.sort(compareEnrichedTransactions)

  const total = enrichedAllTransactions.length
  const start = (page - 1) * limit
  const paginated = enrichedAllTransactions.slice(start, start + limit)

  const attributed = await enrichTransactionsWithAgents(userId, paginated)
  // #2870: after agent enrichment — that is what puts `paymentId` on raw
  // explorer rows — and over the PAGE only, so this is one ledger query.
  const transactions = await enrichTransactionsWithAccounting(userId, attributed, log)

  return { transactions, total }
}

// ── GET /filters (Safe / agent / token picklists) ───────────────────────────

export interface TransactionFilterTokenOption {
  key: string
  symbol: string
  address: string | null
  chainId: number
  isNative: boolean
}

export interface TransactionFilterResult {
  safes: UserSafeRow[]
  agents: TransactionFilterAgentRow[]
  tokens: TransactionFilterTokenOption[]
}

export async function resolveTransactionFilters(
  userId: string,
  log: FastifyBaseLogger,
  fresh: boolean,
): Promise<TransactionFilterResult> {
  const [safes, agents] = await Promise.all([
    listBasicSafesForUser(userId),
    listAgentsForTransactionFilters(userId),
  ])

  const tokenOptions = new Map<string, TransactionFilterTokenOption>()

  for (const safe of safes) {
    const chain = getChain(safe.chain_id)
    const nativeToken = Object.values(chain.tokens).find((token) => token.address === null)!
    const nativeKey = `${safe.chain_id}:native`
    tokenOptions.set(nativeKey, {
      key: nativeKey,
      symbol: nativeToken.symbol,
      address: null,
      chainId: safe.chain_id,
      isNative: true,
    })
  }

  const tokenResults = await Promise.all(
    safes.map(async (safe) => {
      try {
        const { transactions } = await fetchSafeTransactions({
          safeId: safe.id,
          safeAddress: safe.safe_address,
          chainId: safe.chain_id,
          log,
          fresh,
        })

        return { safe, transactions }
      } catch (err) {
        log.warn(
          { err, safeId: safe.id, safeAddress: safe.safe_address, chainId: safe.chain_id },
          'Transaction filter token collection failed',
        )
        return { safe, transactions: [] as Transaction[] }
      }
    }),
  )

  for (const { safe, transactions } of tokenResults) {
    for (const tx of transactions) {
      if (tx.type !== 'erc20' || !tx.tokenAddress) continue
      const key = `${safe.chain_id}:${tx.tokenAddress.toLowerCase()}`
      if (tokenOptions.has(key)) continue

      tokenOptions.set(key, {
        key,
        symbol: tx.asset,
        address: tx.tokenAddress.toLowerCase(),
        chainId: safe.chain_id,
        isNative: false,
      })
    }
  }

  try {
    const x402Transactions = await fetchConfirmedX402Transactions(userId, safes)
    for (const tx of x402Transactions) {
      if (tx.type !== 'erc20' || !tx.tokenAddress) continue
      const key = `${tx.chainId}:${tx.tokenAddress.toLowerCase()}`
      if (tokenOptions.has(key)) continue

      tokenOptions.set(key, {
        key,
        symbol: tx.asset,
        address: tx.tokenAddress.toLowerCase(),
        chainId: tx.chainId,
        isNative: false,
      })
    }
  } catch (err) {
    log.warn({ err }, 'Transaction filter x402 token collection failed')
  }

  const tokens = Array.from(tokenOptions.values()).sort((a, b) => {
    if (a.chainId !== b.chainId) return a.chainId - b.chainId
    if (a.isNative !== b.isNative) return a.isNative ? -1 : 1
    return a.symbol.localeCompare(b.symbol)
  })

  return { safes, agents, tokens }
}
