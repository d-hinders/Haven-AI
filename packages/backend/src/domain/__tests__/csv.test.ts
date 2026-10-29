import { describe, it, expect } from 'vitest'
import {
  CSV_BOM,
  EXPORT_ROW_CAP,
  buildCsvExportFilename,
  csvExportTooLargeBody,
  csvField,
  exceedsExportRowCap,
  refuseCsvExportOverCap,
  sendCsvExport,
  toCsv,
  type CsvExportReply,
} from '../csv.js'

describe('csvField', () => {
  it('always quotes, so a comma never splits a field', () => {
    expect(csvField('Acme, Inc')).toBe('"Acme, Inc"')
  })

  it('doubles embedded quotes per RFC 4180', () => {
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
  })

  it('keeps an embedded newline inside the quoted field', () => {
    expect(csvField('line1\nline2')).toBe('"line1\nline2"')
  })

  it('neutralises leading formula characters', () => {
    // A counterparty name comes from the user-controlled address book, so a
    // value starting with one of these must not execute in Excel/Sheets.
    expect(csvField('=1+1')).toBe('"\'=1+1"')
    expect(csvField('+cmd')).toBe('"\'+cmd"')
    expect(csvField('-2')).toBe('"\'-2"')
    expect(csvField('@SUM(A1)')).toBe('"\'@SUM(A1)"')
    expect(csvField('\tx')).toBe('"\'\tx"')
    expect(csvField('\rx')).toBe('"\'\rx"')
  })

  it('leaves an ordinary value alone apart from the quotes', () => {
    expect(csvField('0.50')).toBe('"0.50"')
    expect(csvField('')).toBe('""')
  })
})

describe('toCsv', () => {
  const columns = ['a', 'b'] as const

  it('writes the header first and CRLF between records', () => {
    expect(toCsv(columns, [{ a: '1', b: '2' }])).toBe('a,b\r\n"1","2"')
  })

  it('writes a header-only file for no rows', () => {
    expect(toCsv(columns, [])).toBe('a,b')
  })

  it('writes a missing value as an empty field rather than throwing', () => {
    expect(toCsv(columns, [{ a: '1' }])).toBe('a,b\r\n"1",""')
  })

  it('quotes every field of a row containing separators', () => {
    expect(toCsv(columns, [{ a: 'x,y', b: 'q"z' }])).toBe('a,b\r\n"x,y","q""z"')
  })
})

describe('CSV_BOM', () => {
  it('is the UTF-8 byte-order mark Excel needs to read the file as UTF-8', () => {
    expect(CSV_BOM).toBe('﻿')
    expect(Buffer.from(CSV_BOM, 'utf8')).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
  })
})

// #4327: the CSV-export response, moved here from `modules/transactions` with
// its tests, plus the lower-bound sentence and the send step the agent ledger
// export added.
describe('exceedsExportRowCap', () => {
  it('admits a count at the cap and refuses one above it', () => {
    expect(exceedsExportRowCap(EXPORT_ROW_CAP - 1)).toBe(false)
    expect(exceedsExportRowCap(EXPORT_ROW_CAP)).toBe(false)
    expect(exceedsExportRowCap(EXPORT_ROW_CAP + 1)).toBe(true)
  })

  it('admits an empty export', () => {
    expect(exceedsExportRowCap(0)).toBe(false)
  })
})

describe('csvExportTooLargeBody', () => {
  it('is null at the cap', () => {
    expect(csvExportTooLargeBody(EXPORT_ROW_CAP, { narrowBy: 'status' })).toBeNull()
  })

  it('states an exact count with grouped digits and the route’s own way out', () => {
    expect(csvExportTooLargeBody(10_002, { narrowBy: 'account or period' })).toEqual({
      error: 'Export too large',
      statusCode: 413,
      details:
        'This export would contain 10,002 rows; the limit is 10,000. ' +
        'Narrow the filters — by account or period — and export again.',
    })
  })

  it('says "more than" for a lower bound instead of a number it does not have', () => {
    const body = csvExportTooLargeBody(EXPORT_ROW_CAP + 1, { narrowBy: 'status', lowerBound: true })
    expect(body?.details).toBe(
      'This export would contain more than 10,000 rows; the limit is 10,000. ' +
        'Narrow the filters — by status — and export again.',
    )
    expect(body?.details).not.toContain('10,001')
  })
})

/** A recording stand-in for the three reply calls the steps make. */
function recordingReply() {
  const calls: { code?: number; headers: Record<string, string>; payload?: unknown } = { headers: {} }
  const reply: CsvExportReply = {
    code(statusCode) {
      calls.code = statusCode
      return reply
    },
    header(name, value) {
      calls.headers[name] = value
      return reply
    },
    send(payload) {
      calls.payload = payload
      return reply
    },
  }
  return { reply, calls }
}

describe('refuseCsvExportOverCap', () => {
  it('sends nothing and returns null when the count fits', () => {
    const { reply, calls } = recordingReply()
    expect(refuseCsvExportOverCap(reply, EXPORT_ROW_CAP, { narrowBy: 'status' })).toBeNull()
    expect(calls).toEqual({ headers: {} })
  })

  it('answers 413 with the body over the cap', () => {
    const { reply, calls } = recordingReply()
    expect(refuseCsvExportOverCap(reply, EXPORT_ROW_CAP + 1, { narrowBy: 'status' })).toBe(reply)
    expect(calls.code).toBe(413)
    expect(calls.payload).toEqual(csvExportTooLargeBody(EXPORT_ROW_CAP + 1, { narrowBy: 'status' }))
  })
})

describe('buildCsvExportFilename', () => {
  it('stamps the UTC date, so two timezones name the same export alike', () => {
    expect(buildCsvExportFilename('haven-transactions', new Date('2026-01-05T23:30:00.000Z'))).toBe(
      'haven-transactions-20260105.csv',
    )
  })

  it('takes the prefix it is given', () => {
    expect(buildCsvExportFilename('haven-agent-payments', new Date('2026-10-23T08:00:00Z'))).toBe(
      'haven-agent-payments-20261023.csv',
    )
  })
})

describe('sendCsvExport', () => {
  it('writes the content type, the dated attachment name, the row count and the BOM', () => {
    const { reply, calls } = recordingReply()
    sendCsvExport(reply, {
      csv: 'a,b\r\n"1","2"',
      rowCount: 1,
      filenamePrefix: 'haven-agent-payments',
      now: new Date('2026-10-23T08:00:00Z'),
    })
    expect(calls.code).toBeUndefined()
    expect(calls.headers).toEqual({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="haven-agent-payments-20261023.csv"',
      'X-Export-Row-Count': '1',
    })
    expect(calls.payload).toBe(`${CSV_BOM}a,b\r\n"1","2"`)
  })
})
