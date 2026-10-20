/**
 * Public entry point for the transactions module (#992, epic #980 M4).
 * Outside callers (routes, tests) must import ONLY from this file — see the
 * `no-deep-cross-module-import` dependency-cruiser rule in
 * `.dependency-cruiser.cjs`. Internal files (`aggregate.ts`, `enrichment.ts`,
 * `x402.ts`, `ordering.ts`, `cache-key.ts`, `orchestration.ts`, `csv-export.ts`,
 * `accounting.ts`) are private.
 *
 * `routes/transactions.ts` keeps request validation, auth wiring, and
 * response serialization; aggregation, enrichment, and caching live here.
 * Data access goes through `infra/repositories/transaction-history.ts`
 * (#985 convention). `infra/explorer-api.ts` stays in `infra/` for now (M5
 * foldering issue).
 */

export type {
  ListScope,
  EnrichedTransaction,
  FetchAccountTransactionsParams,
  FetchAccountTransactionsResult,
  ParsedTokenFilter,
  Transaction,
  TransactionAccounting,
  SmartAccountRow,
} from './types.js'

export { buildTransactionCacheKey } from './cache-key.js'
export {
  EXPORT_ROW_CAP,
  TRANSACTION_CSV_COLUMNS,
  exceedsExportRowCap,
  buildTransactionCsvFilename,
  transactionCsvRow,
  transactionsToCsv,
  type TransactionCsvColumn,
  type TransactionCsvLookups,
} from './csv-export.js'
// #3129: `routes/agent-activity.ts` renders the SAME payments as the
// transaction feed, so it normalises through the same helper — otherwise
// one payment reads in two address forms on two screens.
export { toCanonicalAddress } from './normalize.js'
export { compareTransactions, enrichedTransactionIdentityKey } from './ordering.js'
export { fetchAccountTransactions } from './aggregate.js'
export { fetchLastOutgoingAt } from './last-outgoing.js'
export { enrichTransactionsWithAgents } from './enrichment.js'
export { enrichTransactionsWithAccounting } from './accounting.js'
export { serveTimeAmount } from './serve-time.js'
export {
  ACTIVITY_GROUP_LIMIT,
  ACTIVITY_WINDOW_DAYS,
  ACTIVITY_WINDOW_MS,
  activityWindowStartIso,
  buildActivityFeed,
  buildActivityGroups,
  isValidActivityTimeZone,
  localDayBounds,
  localDayKey,
  activityOutcome,
  ownAccountNameResolver,
  type ActivityFeed,
  type ActivityOutcome,
  type BuildActivityGroupsParams,
  type DashboardActivityGroup,
  type LocalDayBounds,
} from './activity.js'
export { fetchConfirmedX402Transactions, mergeX402Transactions } from './x402.js'
export {
  counterpartyAddressOf,
  counterpartyAddressesOf,
  EMPTY_SEARCH_INDEX,
  foldForSearch,
  resolvedCounterpartyNames,
  transactionMatchesSearch,
  type TransactionSearchIndex,
} from './search.js'
export {
  parseTransactionWindow,
  type ParsedTransactionWindow,
  type TransactionPeriodPreset,
  type TransactionWindow,
  type TransactionWindowParams,
} from './period.js'
export {
  ingestInboundTransfers,
  matchInboundTransferForAccount,
  findX402PaytoSettlement,
  type InboundMatchResult,
} from './receive.js'
export {
  findOffRampDestination,
  setOffRampDestination,
  usdcAddressForChain,
  type OffRampDestinationRow,
} from './off-ramp.js'

export {
  aggregateAccountTransactions,
  buildAccountTransactionsPage,
  filterEnrichedTransactions,
  mergeSortDedupeAndEnrich,
  paginateByOffset,
  resolveTransactionCurrency,
  resolveTransactionFilters,
  type AggregateAccountTransactionsResult,
  type OffsetPage,
  type AccountTransactionsPage,
  type AccountTransactionsPageParams,
  type TransactionFilterOptions,
  type TransactionFilterResult,
  type TransactionFilterTokenOption,
} from './orchestration.js'
