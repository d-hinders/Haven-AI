/**
 * Public entry point for the transactions module (#992, epic #980 M4).
 * Outside callers (routes, tests) must import ONLY from this file — see the
 * `module-entry-transactions` dependency-cruiser rule in
 * `.dependency-cruiser.cjs`. Internal files (`aggregate.ts`, `enrichment.ts`,
 * `x402.ts`, `ordering.ts`, `cache-key.ts`, `orchestration.ts`) are private.
 *
 * `routes/transactions.ts` keeps request validation, auth wiring, and
 * response serialization; aggregation, enrichment, and caching live here.
 * Data access goes through `infra/repositories/transaction-history.ts`
 * (#985 convention). `lib/explorer-api.ts` / `lib/gnosisscan.ts` stay in
 * `lib/` for now (M5 foldering issue).
 */

export type {
  EnrichedTransaction,
  FetchSafeTransactionsParams,
  FetchSafeTransactionsResult,
  ParsedTokenFilter,
  Transaction,
  UserSafeRow,
} from './types.js'

export { buildTransactionCacheKey } from './cache-key.js'
export { compareTransactions, enrichedTransactionIdentityKey } from './ordering.js'
export { fetchSafeTransactions } from './aggregate.js'
export { enrichTransactionsWithAgents } from './enrichment.js'
export { fetchConfirmedX402Transactions, mergeX402Transactions } from './x402.js'

export {
  aggregateSafeTransactions,
  buildSafeTransactionsPage,
  filterEnrichedTransactions,
  mergeSortDedupeAndEnrich,
  paginateByOffset,
  resolveTransactionFilters,
  type AggregateSafeTransactionsResult,
  type OffsetPage,
  type SafeTransactionsPage,
  type SafeTransactionsPageParams,
  type TransactionFilterOptions,
  type TransactionFilterResult,
  type TransactionFilterTokenOption,
} from './orchestration.js'
