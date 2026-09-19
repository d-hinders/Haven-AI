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
  listBasicAccountsForUser,
  type TransactionFilterAgentRow,
} from '../../infra/repositories/transaction-history.js'
import { getChain } from '../../domain/chains.js'
import {
  DEFAULT_TRANSACTION_CURRENCY,
  transactionCurrencyOrDefault,
  type TransactionCurrency,
} from '../../domain/transaction-currency.js'
import { findCurrencyPreference } from '../../infra/repositories/users.js'
import { fetchAccountTransactions } from './aggregate.js'
import { toCanonicalAddress } from './normalize.js'
import { compareEnrichedTransactions, enrichedTransactionIdentityKey } from './ordering.js'
import { enrichTransactionsWithAgents } from './enrichment.js'
import { enrichTransactionsWithAccounting } from './accounting.js'
import { fetchConfirmedX402Transactions, mergeX402Transactions } from './x402.js'
import type { EnrichedTransaction, ParsedTokenFilter, Transaction, SmartAccountRow } from './types.js'

// ── GET / (paginated, filterable feed across every owned account) ─────────────

export interface AggregateAccountTransactionsResult {
  merged: EnrichedTransaction[]
  failedAccountIds: string[]
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

/** Fans `fetchAccountTransactions` out across every account, tagging each transaction with its account. */
export async function aggregateAccountTransactions(
  safes: SmartAccountRow[],
  log: FastifyBaseLogger,
  fresh: boolean,
): Promise<AggregateAccountTransactionsResult> {
  const merged: EnrichedTransaction[] = []
  const failedAccountIds: string[] = []
  let truncated = false

  for (const safe of safes) {
    try {
      const { transactions, hadFailures, truncated: accountTruncated } = await fetchAccountTransactions({
        accountId: safe.id,
        accountAddress: safe.account_address,
        chainId: safe.chain_id,
        log,
        fresh,
      })

      if (hadFailures) {
        failedAccountIds.push(safe.id)
      }

      if (accountTruncated) {
        truncated = true
      }

      for (const tx of transactions) {
        merged.push({
          ...tx,
          chainId: safe.chain_id,
          accountId: safe.id,
          // #3129: the third place an address reaches the wire row. The two
          // ROW producers normalise, but `accountAddress` is attached here,
          // during assembly, so it skipped the boundary entirely. It is
          // checksummed in practice only because `computeHybridAccountAddress`
          // happens to write it that way — every lookup is
          // `LOWER(account_address) = LOWER($2)`, so nothing enforces it, and
          // one row written lowercase would put both forms in one response.
          accountAddress: toCanonicalAddress(safe.account_address),
          accountName: safe.name,
        })
      }
    } catch (err) {
      failedAccountIds.push(safe.id)
      log.warn(
        { err, accountId: safe.id, accountAddress: safe.account_address, chainId: safe.chain_id },
        'Account transaction aggregation failed',
      )
    }
  }

  return { merged, failedAccountIds, truncated }
}

/** x402-merge, sort, dedupe, and agent-enrich the full merged feed (pre-filter, pre-paginate). */
export async function mergeSortDedupeAndEnrich(
  userId: string,
  safes: SmartAccountRow[],
  merged: EnrichedTransaction[],
  currency: TransactionCurrency = DEFAULT_TRANSACTION_CURRENCY,
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

  return enrichTransactionsWithAgents(userId, deduped, currency)
}

/**
 * The currency this user's converted amounts are struck in (#3127): their
 * stored `currency_preference`, or SEK when none is set — the documented
 * default, not an inherited one. One preference read per request, on the
 * same scoped repository read `/user/preferences` serves.
 */
export async function resolveTransactionCurrency(userId: string): Promise<TransactionCurrency> {
  return transactionCurrencyOrDefault(await findCurrencyPreference(userId))
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

// ── GET /:accountAddress (single-account, page/limit pagination) ───────────

export interface AccountTransactionsPageParams {
  userId: string
  accountId: string
  accountAddress: string
  chainId: number
  log: FastifyBaseLogger
  fresh: boolean
  page: number
  limit: number
  /**
   * The currency the converted triple is struck in (#3127). The route
   * resolves it from the user's preference and passes it in — this pipeline
   * stays preference-blind like the rest of the module.
   */
  currency?: TransactionCurrency
}

export interface AccountTransactionsPage {
  /** Still carries `chainId`/`accountId`/`accountAddress`/`accountName`/`agentId` — the route strips those for serialization. */
  transactions: EnrichedTransaction[]
  total: number
}

/**
 * The `/:accountAddress` pipeline: fetch, x402-merge, sort (NOT deduped — matches
 * the pre-#992 route, which only dedupes on the multi-Safe `GET /` feed),
 * paginate, then enrich only the paginated page (enrichment runs after
 * pagination here, unlike `mergeSortDedupeAndEnrich`, to avoid attributing
 * agents to rows that are never returned).
 */
export async function buildAccountTransactionsPage(
  params: AccountTransactionsPageParams,
): Promise<AccountTransactionsPage> {
  const { userId, accountId, accountAddress, chainId, log, fresh, page, limit, currency = DEFAULT_TRANSACTION_CURRENCY } = params
  const { transactions: allTransactions } = await fetchAccountTransactions({
    accountId,
    accountAddress,
    chainId,
    log,
    fresh,
  })

  const ownedAccount: SmartAccountRow = {
    id: accountId,
    account_address: accountAddress,
    chain_id: chainId,
    name: '',
  }
  const enrichedAllTransactions = await mergeX402Transactions(
    userId,
    [ownedAccount],
    allTransactions.map((tx) => ({
      ...tx,
      chainId,
      accountId,
      // #3129: as above — and this one is the URL path parameter, so its
      // casing is whatever the caller typed.
      //
      // The `fetchAccountTransactions({ accountAddress })` call sites are
      // deliberately left raw, and not because normalising them would be
      // risky: it would be behaviour-neutral, since `buildTransactionCacheKey`
      // lowercases and the in/out compare goes through `addrLower`. They are
      // left alone because that value is an INPUT — it reaches a cache key, a
      // direction compare, an explorer URL and a log line, never a row — so
      // normalising it would add a call that guarantees nothing. (The same
      // raw value also becomes `ownedAccount.account_address` below: that is
      // the one path by which it could reach a row, and it does not, because
      // `mergeX402Transactions` reads only `safe.id` from those rows and each
      // x402 row takes its own `accountAddress` from the normalised
      // `row.account_address`.) The other two input sites are the
      // `fetchAccountTransactions` calls in `aggregateAccountTransactions`
      // and in the token-filter collector.
      accountAddress: toCanonicalAddress(accountAddress),
      accountName: '',
    })),
  )

  enrichedAllTransactions.sort(compareEnrichedTransactions)

  const total = enrichedAllTransactions.length
  const start = (page - 1) * limit
  const paginated = enrichedAllTransactions.slice(start, start + limit)

  const attributed = await enrichTransactionsWithAgents(userId, paginated, currency)
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
  safes: SmartAccountRow[]
  agents: TransactionFilterAgentRow[]
  tokens: TransactionFilterTokenOption[]
}

export async function resolveTransactionFilters(
  userId: string,
  log: FastifyBaseLogger,
  fresh: boolean,
): Promise<TransactionFilterResult> {
  const [safes, agents] = await Promise.all([
    listBasicAccountsForUser(userId),
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
        const { transactions } = await fetchAccountTransactions({
          accountId: safe.id,
          accountAddress: safe.account_address,
          chainId: safe.chain_id,
          log,
          fresh,
        })

        return { safe, transactions }
      } catch (err) {
        log.warn(
          { err, accountId: safe.id, accountAddress: safe.account_address, chainId: safe.chain_id },
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
