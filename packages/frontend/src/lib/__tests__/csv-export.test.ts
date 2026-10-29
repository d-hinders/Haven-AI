/**
 * The neutral export helpers (#4328): the filename prefix comes from the
 * page, the download shim is verbatim, and the empty-body test is exact.
 * The CSV contract itself — the column order, quoting, formula-injection
 * neutralisation and per-column mapping — is proven where the file is
 * built, in the backend's `domain/__tests__/csv.test.ts` and
 * `modules/transactions/__tests__/csv-export.test.ts`.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { buildCsvFilename, downloadCsv } from '@/lib/csv-export'

describe('buildCsvFilename', () => {
  it('stamps the UTC date after the page-supplied prefix', () => {
    expect(buildCsvFilename(new Date('2026-05-08T11:49:59.000Z'), 'haven-transactions')).toBe(
      'haven-transactions-20260508.csv',
    )
  })

  it('passes a different prefix through untouched (#4328)', () => {
    // #4327's agent tab reuses the shape with its own prefix.
    expect(buildCsvFilename(new Date('2026-05-08T11:49:59.000Z'), 'haven-agent-payments')).toBe(
      'haven-agent-payments-20260508.csv',
    )
  })

  it('names the same export alike from either side of midnight UTC', () => {
    // Was the local date before #2871; UTC now, matching the backend's
    // `buildCsvExportFilename` (`domain/csv.ts`) so the two never disagree.
    expect(buildCsvFilename(new Date('2026-01-05T23:30:00.000Z'), 'haven-transactions')).toBe(
      'haven-transactions-20260105.csv',
    )
  })

  it('zero-pads month and day', () => {
    expect(buildCsvFilename(new Date('2026-02-03T12:00:00.000Z'), 'haven-transactions')).toBe(
      'haven-transactions-20260203.csv',
    )
  })
})

describe('downloadCsv', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('downloads the body verbatim under the given filename', () => {
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:csv')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL })

    const anchor = document.createElement('a')
    const click = vi.spyOn(anchor, 'click').mockImplementation(() => {})
    vi.spyOn(document, 'createElement').mockReturnValue(anchor)

    // The backend already prefixed the BOM; prepending a second one here
    // would write a stray character into the first header cell.
    const body = '﻿a,b\r\n"1","2"'
    downloadCsv(body, 'haven-transactions-20260508.csv')

    expect(createObjectURL).toHaveBeenCalledTimes(1)
    const blob = createObjectURL.mock.calls[0][0]
    expect(blob.type).toBe('text/csv;charset=utf-8')
    // jsdom's Blob has no async `text()`; size is the checkable surrogate —
    // a second BOM would make it two bytes longer.
    expect(blob.size).toBe(new Blob([body]).size)
    expect(anchor.download).toBe('haven-transactions-20260508.csv')
    expect(click).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:csv')
  })
})
