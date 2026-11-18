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
// #4327: the export row cap and the dated filename moved to `domain/csv.ts`
// with the rest of the CSV-export response; only the projection stays here.
export {
  TRANSACTION_CSV_COLUMNS,
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
export { serveTimeAmount, serveTimeAmountTriple } from './serve-time.js'
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
  sinceTimeWord,
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
  ingestInboundTransferByTxHash,
  explorerRowsToLegs,
  readInboundTransferByTxHash,
  TX_HASH_PATTERN,
  matchInboundTransferForAccount,
  findX402PaytoSettlement,
  type InboundMatchResult,
  type InboundTransferLeg,
  type IngestByTxHashResult,
  type ChainInboundLeg,
  type ChainReadResult,
} from './receive.js'
export {
  runMerchantInboundIndexTick,
  productionMerchantIndexDeps,
  MAX_BLOCKS_PER_PASS,
  type MerchantIndexDeps,
  type MerchantIndexTickResult,
} from './merchant-index.js'
// #4897: the sales ingest, consumed by routes/merchant-sales.ts.
export { ingestMerchantSale, serializeSale, type SaleRecordInput } from './merchant-sales.js'
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
  foldOwnAccountTransfers,
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

// The recipient-naming module (#4332, #4882): every route names the other
// side of a payment through the module's public surface, per the
// module-boundary rule — imports of `modules/` go through `index.ts`.
export {
  EMPTY_RECIPIENT_NAME_INDEX,
  allRecipientNames,
  recipientNameKey,
  recipientAddressOf,
  recipientNameSnakeWire,
  recipientNameWithoutHost,
  resolveRecipientName,
  type CounterpartyKind,
  type CounterpartyName,
  type RecipientNameIndex,
  type RecipientNameSource,
  type RecipientTarget,
} from './counterparty-name.js'
export { loadRecipientNameIndex, type LoadRecipientNameIndexOptions } from './recipient-name-index.js'
// #4897: the owner's sales reads and the clear action, consumed by
// routes/merchant-sales-reads.ts.
export {
  clearSaleRecord,
  decodePaymentsCursor,
  emptySummary,
  PAYMENTS_DEFAULT_LIMIT,
  PAYMENTS_MAX_LIMIT,
  parsePeriod,
  readPaymentDetail,
  readPaymentsPage,
  readSalesFacets,
  readSalesSummaryForOwner,
  resolveSalesScope,
  type SalesFilterInput,
} from './merchant-sales-reads.js'
// #4952: the Stripe deposit-address registry, consumed by
// routes/merchant-deposit-addresses.ts.
export {
  DEPOSIT_ADDRESS_VERIFICATION_NOTE,
  listRegistrations,
  registerDepositAddress,
  retireRegistration,
  serializeDepositAddress,
} from './merchant-deposit-addresses.js'
