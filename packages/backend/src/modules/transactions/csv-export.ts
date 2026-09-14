/**
 * CSV projection of the enriched transaction feed (#2871).
 *
 * Server-side successor to the frontend's `lib/transaction-csv.ts`, which
 * could only serialize the page the browser had loaded. The quoting rules live
 * in `domain/csv.ts`; this file owns the column contract and the mapping from
 * `EnrichedTransaction`.
 */
import { toCsv } from '../../domain/csv.js'
import type { EnrichedTransaction } from './types.js'

/**
 * Column order is the public contract of the export. #2871 **replaces** the
 * v1 contract rather than extending it — `date` became `settled_at` to say
 * which timestamp it is, `counterparty_*` moved ahead of `token_*`, and
 * `amount_sek` / `fx_rate` / `fx_source` / `payment_id` were inserted mid-list
 * — so an importer keyed on v1 column indices or header names has to be
 * repointed once. From here on, append new columns at the END so existing
 * indices stay stable.
 *
 * `fee_sek` is present and always empty: there is no fee ledger to read
 * (#386). It stays in the contract so a column does not appear later and
 * shift every index; the same reservation the frontend export carried.
 *
 * Deliberately absent: the `accounting_provider` / `accounting_status` /
 * `accounting_external_ref` columns #2871 also lists. They are projections of
 * `accounting_connections`, which #2860 creates — there is nothing to read
 * yet. They append here when it lands.
 */
export const TRANSACTION_CSV_COLUMNS = [
  'settled_at',
  'type',
  'status',
  'direction',
  'counterparty_name',
  'counterparty_address',
  'token_symbol',
  'token_address',
  'amount',
  'amount_sek',
  'fx_rate',
  'fx_source',
  'fee_sek',
  'chain_id',
  'tx_hash',
  'payment_id',
  'agent_name',
  'safe_address',
  'initiator',
  // #2907 (naming P0): account-vocabulary twin of `safe_address`, same
  // value. Appended per the column-order rule above — `safe_address` stays
  // for one release (deprecated, #2914 drops it) rather than being replaced
  // in place, which would shift every column after it for an importer keyed
  // on index.
  'account_address',
] as const

export type TransactionCsvColumn = (typeof TRANSACTION_CSV_COLUMNS)[number]

export interface TransactionCsvLookups {
  /**
   * Human-readable counterparty name — address book first, then the user's
   * own accounts. Returns null when unknown. Mirrors the dashboard table's
   * resolution so the file and the on-screen rows agree.
   */
  resolveName: (address: string, chainId: number) => string | null
}

function rowType(tx: EnrichedTransaction): string {
  if (tx.activityType === 'delegate_sweep') return 'allowance funding'
  if (tx.source === 'x402') return 'x402'
  if (tx.source === 'mpp_demo') return 'mpp'
  return tx.direction === 'in' ? 'receive' : 'send'
}

function rowStatus(tx: EnrichedTransaction): string {
  if (tx.isError) return 'failed'
  if (tx.paymentFlowStatus === 'confirming_merchant') return 'pending'
  if (tx.paymentFlowStatus === 'needs_attention') return 'needs attention'
  return 'executed'
}

function counterparty(tx: EnrichedTransaction): string {
  return tx.direction === 'in' ? tx.from : tx.to
}

/** One CSV record per transaction, in `TRANSACTION_CSV_COLUMNS` order. */
export function transactionCsvRow(
  tx: EnrichedTransaction,
  lookups: TransactionCsvLookups,
): Record<TransactionCsvColumn, string> {
  const cp = counterparty(tx)
  return {
    settled_at: new Date(tx.timestamp * 1000).toISOString(),
    type: rowType(tx),
    status: rowStatus(tx),
    direction: tx.direction,
    counterparty_name: lookups.resolveName(cp, tx.chainId) ?? '',
    counterparty_address: cp,
    token_symbol: tx.tokenSymbol ?? tx.asset ?? '',
    token_address: tx.tokenAddress ?? '',
    amount: tx.valueFormatted,
    amount_sek: tx.amountSek ?? '',
    fx_rate: tx.fxRateSek ?? '',
    fx_source: tx.fxSource ?? '',
    fee_sek: '',
    chain_id: String(tx.chainId),
    tx_hash: tx.hash,
    payment_id: tx.paymentId ?? '',
    agent_name: tx.agentName ?? '',
    safe_address: tx.safeAddress,
    // The raw attribution enum — `human` | `agent` | `unknown`, empty for
    // inbound and unattributed rows. Never the display string "You", so the
    // export stays unambiguous for an accountant reading it cold.
    initiator: tx.initiatedBy ?? '',
    // #2907: same value as `safe_address` above — dual-emit, not a rename.
    account_address: tx.safeAddress,
  }
}

export function transactionsToCsv(
  transactions: EnrichedTransaction[],
  lookups: TransactionCsvLookups,
): string {
  return toCsv(
    TRANSACTION_CSV_COLUMNS,
    transactions.map((tx) => transactionCsvRow(tx, lookups)),
  )
}

/**
 * Row ceiling for one CSV export (#2871). The export runs the whole
 * aggregate-and-enrich pipeline in memory rather than streaming from the
 * database — there is no database to stream from, the feed is aggregated from
 * block explorers — so it is bounded here instead.
 *
 * It IS reachable. The explorer legs are bounded (one `EXPLORER_PAGE_SIZE`
 * window per source per account — `infra/explorer-api.ts` owns the number,
 * and #2884 paginates past it), but the x402 leg is not: `FIND_CONFIRMED_X402_PAYMENT_INTENTS_SQL` carries no
 * `LIMIT` and `mergeX402Transactions` appends every row it returns, so a user
 * with more than `EXPORT_ROW_CAP` confirmed x402 payment intents crosses this
 * on an unfiltered export. That is the case the route's 413 answers, and the
 * route test seeds it.
 */
export const EXPORT_ROW_CAP = 10_000

export function exceedsExportRowCap(rowCount: number): boolean {
  return rowCount > EXPORT_ROW_CAP
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function buildTransactionCsvFilename(now: Date): string {
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`
  return `haven-transactions-${stamp}.csv`
}
