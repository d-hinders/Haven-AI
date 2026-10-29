/**
 * RFC 4180 CSV writer (#2871).
 *
 * Server-side successor to the frontend's `lib/csv-export.ts` generator,
 * which could only ever serialize the page the browser had loaded. Pure and
 * dependency-free so the quoting rules are unit-testable on their own.
 */

/**
 * UTF-8 byte-order mark. Excel reads a BOM-less UTF-8 CSV as the local
 * codepage and mangles non-ASCII counterparty names, so every export the
 * routes hand back is prefixed with this.
 */
export const CSV_BOM = '﻿'

/**
 * Quote one field per RFC 4180 and neutralise spreadsheet formula injection.
 *
 * A field beginning with `=`, `+`, `-`, `@`, tab or CR can execute as a
 * formula when the file is opened in Excel or Sheets; such values are
 * prefixed with a single quote. Carried forward verbatim from the frontend
 * helper this replaces — counterparty names come from the user-controlled
 * address book, so it still matters.
 */
export function csvField(value: string): string {
  let v = value
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`
  return `"${v.replace(/"/g, '""')}"`
}

/**
 * Serialize `rows` under `columns`, header first. A value missing from a row
 * is written as an empty field rather than throwing: a column the data cannot
 * populate yet (see `fee_sek`) stays present and blank, so the column set is a
 * stable contract for whoever imports the file.
 *
 * Line endings are CRLF — the RFC 4180 default and what Excel expects.
 */
export function toCsv<C extends string>(
  columns: readonly C[],
  rows: ReadonlyArray<Partial<Record<C, string>>>,
): string {
  const lines: string[] = [columns.join(',')]
  for (const row of rows) {
    lines.push(columns.map((col) => csvField(row[col] ?? '')).join(','))
  }
  return lines.join('\r\n')
}

// ── The CSV export response (#4327) ──────────────────────────────────────────
//
// Two exports write a file now (`GET /transactions/export.csv`, #2871, and the
// agent ledger's `GET /agent-activity/:id/activity/export.csv`, #4327), and
// the owner's instruction is one piece per behaviour, not one per page. So the
// row cap, the 413 body, the headers, the BOM and the dated filename live here
// and each route supplies only its rows' projection. Two steps, in this order:
// the CAP CHECK runs on the row count before any CSV is built (a refused
// export never pays for the projection), then the SEND step writes the file.
//
// The reply is typed structurally — the three calls the steps make — so
// domain/ stays free of the framework (`domain-stays-pure`).

/**
 * Row ceiling for one CSV export (#2871). Every export builds its file in
 * memory rather than streaming, so it is bounded here instead. The
 * transactions feed is aggregated from block explorers (there is no database
 * to stream from); the agent ledger reads `cap + 1` rows and refuses on the
 * extra one.
 */
export const EXPORT_ROW_CAP = 10_000

export function exceedsExportRowCap(rowCount: number): boolean {
  return rowCount > EXPORT_ROW_CAP
}

/** The three reply calls the export steps make — Fastify's reply satisfies it. */
export interface CsvExportReply {
  code(statusCode: number): CsvExportReply
  header(name: string, value: string): CsvExportReply
  send(payload?: unknown): CsvExportReply
}

export interface CsvExportTooLargeBody {
  error: 'Export too large'
  statusCode: 413
  details: string
}

export interface CsvExportCapOptions {
  /** The route's own filters, as the way out: "by account, agent, … or period". */
  narrowBy: string
  /**
   * True when `rowCount` is a LOWER bound — a capped read that fetched
   * `cap + 1` rows cannot know the real total, so the sentence says "more
   * than" instead of a number it does not have. False (the default) for an
   * exact count, which the sentence states.
   */
  lowerBound?: boolean
}

/**
 * The 413 body for an export over the cap, or null when the count fits.
 * Grouped digits: `10001` and `10000` are near-indistinguishable at a glance,
 * which defeats the sentence's job of conveying how far over the export is.
 */
export function csvExportTooLargeBody(
  rowCount: number,
  options: CsvExportCapOptions,
): CsvExportTooLargeBody | null {
  if (!exceedsExportRowCap(rowCount)) return null
  const limit = EXPORT_ROW_CAP.toLocaleString('en-US')
  const size = options.lowerBound
    ? `more than ${limit} rows`
    : `${rowCount.toLocaleString('en-US')} rows`
  return {
    error: 'Export too large',
    statusCode: 413,
    details:
      `This export would contain ${size}; the limit is ${limit}. ` +
      `Narrow the filters — by ${options.narrowBy} — and export again.`,
  }
}

/**
 * Step one, the cap check: answers the 413 and returns the reply when the
 * count is over the cap, or returns null and sends nothing. A refusal, never a
 * truncated file.
 */
export function refuseCsvExportOverCap(
  reply: CsvExportReply,
  rowCount: number,
  options: CsvExportCapOptions,
): CsvExportReply | null {
  const body = csvExportTooLargeBody(rowCount, options)
  return body ? reply.code(413).send(body) : null
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * `{prefix}-YYYYMMDD.csv`, stamped in UTC so two timezones name the same
 * export alike. The browser saves a `fetch` + Blob download under its own
 * client-side name, so this is the name a direct GET (curl, a script) gets.
 */
export function buildCsvExportFilename(prefix: string, now: Date): string {
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`
  return `${prefix}-${stamp}.csv`
}

export interface CsvExportFile {
  /** The serialized file, without the BOM (`toCsv`'s output). */
  csv: string
  /** Rows in the file, header excluded — the `X-Export-Row-Count` header. */
  rowCount: number
  filenamePrefix: string
  /** Injectable for tests; the filename's date. */
  now?: Date
}

/**
 * Step two, the send: the CSV content type, the attachment filename, the row
 * count header and the UTF-8 BOM (Excel reads a BOM-less file as the local
 * codepage).
 */
export function sendCsvExport(reply: CsvExportReply, file: CsvExportFile): CsvExportReply {
  return reply
    .header('Content-Type', 'text/csv; charset=utf-8')
    .header(
      'Content-Disposition',
      `attachment; filename="${buildCsvExportFilename(file.filenamePrefix, file.now ?? new Date())}"`,
    )
    .header('X-Export-Row-Count', String(file.rowCount))
    .send(`${CSV_BOM}${file.csv}`)
}
