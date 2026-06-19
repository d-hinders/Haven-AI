/**
 * CSV serialization for `haven activity export`. Mirrors the dashboard export
 * (#411): RFC 4180 quoting, CRLF line endings, and a spreadsheet
 * formula-injection guard. Kept self-contained so the CLI has no @haven_ai/*
 * runtime dependency.
 */

/** Quote per RFC 4180 and neutralise leading =,+,-,@ (Excel formula injection). */
function csvField(value: string): string {
  let v = value
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`
  return `"${v.replace(/"/g, '""')}"`
}

export function toCsv(headers: string[], rows: string[][]): string {
  const lines = [headers.join(','), ...rows.map((r) => r.map(csvField).join(','))]
  return lines.join('\r\n')
}
