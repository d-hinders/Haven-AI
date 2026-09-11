/**
 * RFC 4180 CSV writer (#2871).
 *
 * Server-side successor to the frontend's `lib/transaction-csv.ts` generator,
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
