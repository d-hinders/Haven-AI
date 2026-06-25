import type { AggregatedTransaction } from '@/types/transactions'

/**
 * CSV export for the transaction history page (v1 of the accounting-ready
 * export). Pure and side-effect free so it is unit-testable; the browser
 * download is a separate thin helper below.
 *
 * Book-time SEK value (`amount_sek`) is included per #463; `fee_sek` is a
 * reserved column, empty until the fee ledger (#386) lands.
 */

export interface TransactionCsvLookups {
  /**
   * Human-readable counterparty name (address book, or the user's own Safe).
   * Returns null when unknown. Mirrors the table's resolution so the CSV and
   * the on-screen rows agree.
   */
  resolveName: (address: string, chainId: number) => string | null
}

/** Column order is the public contract of the export — do not reorder casually. */
const COLUMNS = [
  'date',
  'type',
  'status',
  'direction',
  'amount',
  'token_symbol',
  'token_address',
  'counterparty_address',
  'counterparty_name',
  'safe_address',
  'agent_name',
  'tx_hash',
  'chain_id',
  'amount_sek',
  'fee_sek',
] as const

function rowType(tx: AggregatedTransaction): string {
  if (tx.activityType === 'delegate_sweep') return 'allowance funding'
  if (tx.source === 'x402') return 'x402'
  if (tx.source === 'mpp_demo') return 'mpp'
  return tx.direction === 'in' ? 'receive' : 'send'
}

function rowStatus(tx: AggregatedTransaction): string {
  if (tx.isError) return 'failed'
  if (tx.paymentFlowStatus === 'confirming_merchant') return 'pending'
  if (tx.paymentFlowStatus === 'needs_attention') return 'needs attention'
  return 'executed'
}

function counterparty(tx: AggregatedTransaction): string {
  return tx.direction === 'in' ? tx.from : tx.to
}

/**
 * Quote a field per RFC 4180 and neutralise spreadsheet formula injection.
 * A field beginning with =, +, -, @, tab, or CR can execute as a formula when
 * the CSV is opened in Excel/Sheets; prefix such values with a single quote.
 * counterparty_name comes from the user-controlled address book, so this
 * matters.
 */
function csvField(value: string): string {
  let v = value
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`
  return `"${v.replace(/"/g, '""')}"`
}

export function transactionsToCsv(
  txs: AggregatedTransaction[],
  lookups: TransactionCsvLookups,
): string {
  const lines: string[] = [COLUMNS.join(',')]

  for (const tx of txs) {
    const cp = counterparty(tx)
    const record: Record<(typeof COLUMNS)[number], string> = {
      date: new Date(tx.timestamp * 1000).toISOString(),
      type: rowType(tx),
      status: rowStatus(tx),
      direction: tx.direction,
      amount: tx.valueFormatted,
      token_symbol: tx.tokenSymbol ?? tx.asset ?? '',
      token_address: tx.tokenAddress ?? '',
      counterparty_address: cp,
      counterparty_name: lookups.resolveName(cp, tx.chainId) ?? '',
      safe_address: tx.safeAddress,
      agent_name: tx.agentName ?? '',
      tx_hash: tx.hash,
      chain_id: String(tx.chainId),
      amount_sek: tx.amountSek ?? '',
      fee_sek: '',
    }
    lines.push(COLUMNS.map((col) => csvField(record[col])).join(','))
  }

  // CRLF line endings — the RFC 4180 default and what Excel expects.
  return lines.join('\r\n')
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function buildCsvFilename(now: Date): string {
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  return `haven-transactions-${stamp}.csv`
}

/** Browser-only: trigger a download of the given CSV text. */
export function downloadCsv(csv: string, filename: string): void {
  // Prepend a UTF-8 BOM so Excel renders non-ASCII counterparty names correctly.
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
