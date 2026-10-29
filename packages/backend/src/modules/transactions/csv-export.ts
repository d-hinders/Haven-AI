/**
 * CSV projection of the enriched transaction feed (#2871).
 *
 * Server-side successor to the frontend's `lib/csv-export.ts`, which
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
 * #3127 appends `reporting_currency` / `converted_currency` at the END:
 * the amounts in this file remain a fixed-SEK accounting projection (the
 * deliberate branch — the general feed converts to the user's preference,
 * this file does not), but the figures now name their currency in the file
 * itself. Appended, not inserted, so every pre-#3127 index stays stable.
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
  'initiator',
  // #2914 (naming P5): `account_address` is the only address column. #2907
  // appended it beside a deprecated `safe_address` rather than replacing it
  // in place, precisely so this removal would shift columns ONCE instead of
  // twice — an importer keyed on column INDEX sees that shift now.
  'account_address',
  // #3127: appended at the END, per the rule above. The file stays a
  // fixed-reporting-currency accounting artifact — `amount_sek` is the
  // stored book-time column and its indices are untouched — but the file now
  // SAYS which currency its figures are in (`reporting_currency`), and which
  // currency the user's dashboard feed converts in (`converted_currency`),
  // instead of both living in a header nobody can read.
  'reporting_currency',
  'converted_currency',
  // #3763: appended at the END (the rule above — an importer keyed on column
  // INDEX sees this shift once). `tx_hash` KEEPS its funding meaning, so the
  // merchant's settlement rides as its own column: empty on every row that
  // has no recorded settlement, and on all non-x402 rows.
  'settlement_tx_hash',
] as const

export type TransactionCsvColumn = (typeof TRANSACTION_CSV_COLUMNS)[number]

/**
 * Opt-in extension used only by `foldOwnTransfers=1` exports (#4265).
 * Keeping the default column constant untouched is what makes an export
 * without the flag byte-identical to the pre-fold contract.
 */
export const FOLDED_TRANSACTION_CSV_COLUMNS = [
  ...TRANSACTION_CSV_COLUMNS,
  'to_account_name',
] as const

export type FoldedTransactionCsvColumn =
  (typeof FOLDED_TRANSACTION_CSV_COLUMNS)[number]

export interface TransactionCsvLookups {
  /**
   * Human-readable counterparty name — address book first, then the user's
   * own accounts. Returns null when unknown. Mirrors the dashboard table's
   * resolution so the file and the on-screen rows agree.
   */
  resolveName: (address: string, chainId: number) => string | null
  /**
   * The currency the file reports its converted figures in (#3127). Fixed
   * SEK on the export route — the accounting semantics this file exists for
   * — carried as an explicit input so the FILE, not each call site's
   * silence, owns the statement. The contract's `converted_currency`
   * column is filled from each row's own `convertedCurrency`, so the file
   * also records what the user's dashboard feed converts in without the
   * amounts here following it.
   */
  reportingCurrency: string
}

function rowType(tx: EnrichedTransaction): string {
  if (tx.ownTransfer) return 'own_transfer'
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
  includeOwnTransferColumn = false,
): Record<TransactionCsvColumn, string> & Partial<Record<'to_account_name', string>> {
  const cp = counterparty(tx)
  const row: Record<TransactionCsvColumn, string> & Partial<Record<'to_account_name', string>> = {
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
    // #4099 (owner decision, 2026-10-19): the app's words, not the raw
    // enum — "You", the agent's name, or "Unknown"; empty on inbound rows,
    // which carry no initiator record — except a delegate sweep, which is
    // agent-attributed and carries its agent's name.
    initiator: csvInitiator(tx),
    account_address: tx.accountAddress,
    // #3127: the file reports in fixed SEK (see the route); the user's
    // effective feed currency rides along from the row's own converted
    // triple — metadata, not a conversion.
    reporting_currency: lookups.reportingCurrency,
    converted_currency: tx.convertedCurrency ?? '',
    // #3763: empty on every row without a recorded settlement — never a
    // copy of the funding hash (that would defeat the column's whole point)
    // and never a placeholder promising a later record.
    settlement_tx_hash: tx.settlementTxHash ?? '',
  }
  if (includeOwnTransferColumn) {
    row.to_account_name = tx.ownTransfer?.toAccountName ?? ''
  }
  return row
}

/**
 * The `initiator` cell (#4099): the same words the app shows. Empty only on
 * an inbound row with no initiator record (every inbound row bar an agent's
 * delegate sweep); an outbound row with no record, including one whose
 * enrichment failed, is "Unknown". `'human'` is a
 * recorded owner send; `'unknown'` an outbound row with no agent and no
 * record, which includes every owner send made before the record existed.
 * An agent-attributed row always carries its agent's name (both attribution
 * queries join `agents`); "Agent" is only the guard for a row that does not.
 */
export function csvInitiator(tx: EnrichedTransaction): string {
  switch (tx.initiatedBy) {
    case 'human':
      return 'You'
    case 'agent':
      return tx.agentName || 'Agent'
    case 'unknown':
      return 'Unknown'
    default:
      // No record at all: an inbound row, or an outbound one whose enrichment
      // failed (the step returns rows unclassified). An outbound row with no
      // record is still not known to be the owner's — "Unknown", never "".
      return tx.direction === 'out' ? 'Unknown' : ''
  }
}

export function transactionsToCsv(
  transactions: EnrichedTransaction[],
  lookups: TransactionCsvLookups,
  includeOwnTransferColumn = false,
): string {
  const columns = includeOwnTransferColumn
    ? FOLDED_TRANSACTION_CSV_COLUMNS
    : TRANSACTION_CSV_COLUMNS
  return toCsv(
    columns,
    transactions.map((tx) => transactionCsvRow(tx, lookups, includeOwnTransferColumn)),
  )
}
