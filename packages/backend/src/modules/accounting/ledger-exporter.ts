import type { AccountingEntry } from './accounting-entry.js'

/**
 * Rail-agnostic export of canonical accounting entries (epic #462, P1 #464).
 *
 * Mirrors the fee module's executor pattern: one shared record
 * (`AccountingEntry`), pluggable per-target output. New markets/targets (SIE,
 * Fortnox, DATEV, QuickBooks) are additional `LedgerExporter`s over the same
 * input. See `docs/research/bookkeeping-ready-export.md` §7.
 */
export interface ExportOptions {
  /** Company name written into the file header (e.g. SIE `#FNAMN`). */
  companyName: string
  /** When the export was generated; defaults to now. */
  generatedAt?: Date
}

export interface ExportResult {
  format: string
  filename: string
  mimeType: string
  content: string
  /** Entries written to the file. */
  entryCount: number
  /** Entries skipped because they lacked a book-time SEK value (unbookable). */
  skipped: number
}

export interface LedgerExporter {
  /** Stable identifier, e.g. `'sie'`. */
  format: string
  export(entries: AccountingEntry[], opts: ExportOptions): ExportResult
}
