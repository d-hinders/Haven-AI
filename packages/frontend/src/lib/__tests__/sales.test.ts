import { describe, expect, it } from 'vitest'
import {
  ledgerCount,
  payerKindLine,
  payerName,
  payerSubline,
  previousSalesRange,
  revenueChangePercent,
  salesAmountText,
  salesChartDays,
  salesDayRange,
  salesRangeDays,
  type SalesSummary,
} from '../sales'

const NOW = new Date('2026-11-18T09:30:00.000Z')
const WALLET = { kind: 'wallet' as const, name: null, address: '0x8f3a5e0b7c1d4a92e6f03b8d15c7a90e4b6d21c0' }

describe('the period', () => {
  it('is the last N UTC days including today', () => {
    expect(salesDayRange({ preset: '30d' }, NOW)).toEqual({ from: '2026-10-20', to: '2026-11-18' })
    expect(salesRangeDays(salesDayRange({ preset: '30d' }, NOW))).toBe(30)
    expect(salesDayRange({ preset: '7d' }, NOW)).toEqual({ from: '2026-11-12', to: '2026-11-18' })
  })

  it('takes a custom range as its own days, and defaults to 30 days for anything else', () => {
    expect(salesDayRange({ from: '2026-11-01', to: '2026-11-05' }, NOW)).toEqual({ from: '2026-11-01', to: '2026-11-05' })
    expect(salesDayRange({}, NOW)).toEqual({ from: '2026-10-20', to: '2026-11-18' })
  })

  it('compares with the period of the same length that ends the day before', () => {
    expect(previousSalesRange({ from: '2026-10-20', to: '2026-11-18' })).toEqual({ from: '2026-09-20', to: '2026-10-19' })
    expect(previousSalesRange({ from: '2026-11-01', to: '2026-11-05' })).toEqual({ from: '2026-10-27', to: '2026-10-31' })
  })
})

describe('payers', () => {
  it('names a contact and an own account, and calls every other payer Wallet', () => {
    expect(payerName({ kind: 'contact', name: 'Lumen Research', address: '0x1' })).toBe('Lumen Research')
    expect(payerName({ kind: 'own', name: 'Atlas', address: '0x2' })).toBe('Atlas')
    expect(payerName(WALLET)).toBe('Wallet')
    expect(payerName(null)).toBe('Wallet')
  })

  it('shows a wallet with its short address and never an address as a name', () => {
    expect(payerSubline(WALLET, false)).toBe('Wallet · 0x8f3a…21c0')
    expect(payerKindLine(WALLET)).toBe('0x8f3a…21c0')
    // A named kind that arrives without its name reads as a wallet, not as an address.
    expect(payerName({ kind: 'contact', name: null, address: WALLET.address })).toBe('Wallet')
    expect(payerSubline(null, true)).toBe('Several wallets')
  })
})

describe('amounts', () => {
  it('follows the sub-cent rule in USD', () => {
    expect(salesAmountText('18000', 'USD')).toBe('$0.02')
    expect(salesAmountText('4500', 'USD')).toBe('$0.0045')
    expect(salesAmountText('2140000', 'USD')).toBe('$2.14')
  })

  it('reads in USDC, not a converted figure, where no rate is on the wire', () => {
    expect(salesAmountText('2140000', 'SEK')).toBe('2.14 USDC')
    expect(salesAmountText('4500', 'EUR')).toBe('0.0045 USDC')
  })
})

describe('what the summary says', () => {
  const summary = {
    revenue_raw: '2140000',
    sales: 3,
    without_product: { count: 1, amount_raw: '1000000' },
    own_moves: { count: 2, amount_raw: '500000' },
    by_day: [{ day: '2026-11-17', payments: 2, sales: 1, revenue_raw: '1000000' }],
  } as unknown as SalesSummary

  it('lists every payment but counts only revenue ones as revenue', () => {
    expect(ledgerCount(summary)).toBe(6)
  })

  it('gives a comparison only where the period before had revenue', () => {
    expect(revenueChangePercent(summary, { ...summary, revenue_raw: '1070000' })).toBeCloseTo(100)
    expect(revenueChangePercent(summary, { ...summary, revenue_raw: '0' })).toBeNull()
    expect(revenueChangePercent(summary, null)).toBeNull()
  })

  it('draws one slot per calendar day, empty on a quiet day', () => {
    const days = salesChartDays(summary, { from: '2026-11-16', to: '2026-11-18' })
    expect(days.map((d) => d.label)).toEqual(['16 Nov', '17 Nov', '18 Nov'])
    expect(days.map((d) => d.series.length)).toEqual([0, 1, 0])
    expect(days[1].series[0].amount).toBe(1)
  })
})
