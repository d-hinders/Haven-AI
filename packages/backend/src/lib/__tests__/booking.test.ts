import { describe, expect, it } from 'vitest'
import { buildBookingLines } from '../booking.js'
import type { AccountingEntry } from '../accounting-entry.js'

function entry(over: Partial<AccountingEntry> = {}): AccountingEntry {
  return {
    paymentId: 'pi1',
    txHash: '0xabc',
    chainId: 8453,
    settledAt: '2026-06-19T10:00:00.000Z',
    direction: 'out',
    counterparty: { address: '0xm', name: null, country: null },
    token: 'USDC',
    amountAtomic: '100000000',
    amountSek: '100.00',
    fxRate: '10',
    fxSource: 'coingecko_spot',
    fxAt: '2026-06-19T10:00:00.000Z',
    feeSek: null,
    category: 'media',
    account: null,
    vatTreatment: 'reverse_charge',
    resourceUrl: 'https://api.example/r',
    receiptRef: 'ev1',
    ...over,
  }
}

function balanced(lines: { debit: number; credit: number }[]): boolean {
  const debit = lines.reduce((s, l) => s + l.debit, 0)
  const credit = lines.reduce((s, l) => s + l.credit, 0)
  return Math.abs(debit - credit) < 1e-9
}

describe('buildBookingLines', () => {
  it('returns null for an unbookable (no SEK) entry', () => {
    expect(buildBookingLines(entry({ amountSek: null }))).toBeNull()
  })

  it('books reverse charge with self-accounted VAT, balanced', () => {
    const lines = buildBookingLines(entry())!
    expect(lines).toEqual([
      { account: '4535', debit: 100, credit: 0 },
      { account: '1930', debit: 0, credit: 100 },
      { account: '2645', debit: 25, credit: 0 },
      { account: '2614', debit: 0, credit: 25 },
    ])
    expect(balanced(lines)).toBe(true)
  })

  it('books a simple expense/cash pair for non-reverse VAT, balanced', () => {
    const lines = buildBookingLines(entry({ vatTreatment: 'none' }))!
    expect(lines).toEqual([
      { account: '6540', debit: 100, credit: 0 },
      { account: '1930', debit: 0, credit: 100 },
    ])
    expect(balanced(lines)).toBe(true)
  })

  it('honours a per-merchant account override on the debit line', () => {
    expect(buildBookingLines(entry({ vatTreatment: 'none', account: '6550' }))![0].account).toBe('6550')
    expect(buildBookingLines(entry({ account: '4531' }))![0].account).toBe('4531')
  })

  it('rounds VAT to öre and stays balanced on awkward amounts', () => {
    const lines = buildBookingLines(entry({ amountSek: '0.10' }))!
    // 25% of 0.10 = 0.025 → 0.03 after rounding
    expect(lines[2]).toEqual({ account: '2645', debit: 0.03, credit: 0 })
    expect(balanced(lines)).toBe(true)
  })
})
