import { describe, expect, it } from 'vitest'
import {
  OWN_MOVES_HINT,
  REVENUE_NO_PRODUCT_COLOR,
  REVENUE_OTHER_COLOR,
  REVENUE_TOP_PRODUCTS,
  ownMovesCaption,
  revenueChartDays,
  revenueChartLabel,
  revenueMoney,
} from '../analytics-revenue'
import { productLines, type SalesMoney, type SalesSummary } from '../sales'

/**
 * The Analytics Revenue side's pure half (#4901).
 *
 * The load-bearing property is that the chart's stack ADDS UP to the Revenue
 * tile: the top five products, the products past them folded into "Other", and
 * the payments with no sale record. A chart that quietly left a class of money
 * out would disagree with the tile above it, which is the one thing a revenue
 * page cannot do.
 */

const BASE = 8453
const RATES = { usd: 0.9998, eur: 0.92, sek: 11.2 }

/** Seven products, ranked by revenue; one payment with no sale record. */
const SUMMARY = {
  usdc_rates: RATES,
  revenue_raw: '1675000',
  revenue_in_account_raw: '1675000',
  sales: 7,
  // 1675000 / (7 sales + 1 without a product), rounded down (#4981).
  average_sale_raw: '209375',
  without_product: { count: 1, amount_raw: '100000' },
  own_moves: { count: 2, amount_raw: '500000' },
  by_product: [
    { product_id: 'p1', label: 'Chat completion', sales: 1, amount_raw: '500000' },
    { product_id: 'p2', label: 'Embeddings', sales: 2, amount_raw: '400000' },
    { product_id: 'p3', label: 'Rerank', sales: 1, amount_raw: '300000' },
    { product_id: 'p4', label: 'Vision', sales: 1, amount_raw: '200000' },
    { product_id: 'p5', label: 'Speech', sales: 1, amount_raw: '100000' },
    { product_id: 'p6', label: 'Translate', sales: 1, amount_raw: '50000' },
    { product_id: 'p7', label: 'Summarise', sales: 1, amount_raw: '25000' },
  ],
  by_product_other: { products: 0, sales: 0, amount_raw: '0' },
  by_payer: [],
  by_payer_other: { payers: 0, payments: 0, amount_raw: '0' },
  unattributed: { payments: 0, amount_raw: '0' },
  by_day: [
    {
      day: '2026-11-16',
      payments: 2,
      sales: 2,
      revenue_raw: '600000',
      without_product_raw: '0',
      in_stripe_raw: '0',
      by_product: [
        { product_id: 'p1', amount_raw: '500000' },
        { product_id: 'p2', amount_raw: '100000' },
      ],
      other_products_raw: '0',
    },
    {
      day: '2026-11-17',
      payments: 6,
      sales: 5,
      revenue_raw: '1075000',
      without_product_raw: '100000',
      in_stripe_raw: '0',
      by_product: [
        { product_id: 'p2', amount_raw: '300000' },
        { product_id: 'p3', amount_raw: '300000' },
        { product_id: 'p4', amount_raw: '200000' },
        { product_id: 'p5', amount_raw: '100000' },
        { product_id: 'p6', amount_raw: '50000' },
        { product_id: 'p7', amount_raw: '25000' },
      ],
      other_products_raw: '0',
    },
  ],
  received_in_stripe: { count: 0, amount_raw: '0' },
} as unknown as SalesSummary

const RANGE = { from: '2026-11-16', to: '2026-11-18' }
const usd: SalesMoney = { currency: 'USD', chainId: BASE, rates: RATES }

describe('revenueMoney', () => {
  it('carries the summary’s own rate triple, so every figure on the side agrees', () => {
    expect(revenueMoney(SUMMARY, 'SEK', BASE)).toEqual({ currency: 'SEK', chainId: BASE, rates: RATES })
  })

  it('reads a null rate as no rate, never as a zero multiplier', () => {
    const noRates = { ...SUMMARY, usdc_rates: null } as SalesSummary
    expect(revenueMoney(noRates, 'SEK', BASE).rates).toBeUndefined()
  })
})

describe('revenueChartDays', () => {
  it('draws one slot per calendar day of the period, empty on a quiet day', () => {
    const days = revenueChartDays(SUMMARY, RANGE)
    expect(days.map((day) => day.label)).toEqual(['16 Nov', '17 Nov', '18 Nov'])
    expect(days[2].series.every((series) => series.amount === 0)).toBe(true)
  })

  it('stacks the top five products, then Other, then No product', () => {
    const [first] = revenueChartDays(SUMMARY, RANGE)
    expect(first.series.map((series) => series.id)).toEqual([
      'product:p1',
      'product:p2',
      'product:p3',
      'product:p4',
      'product:p5',
      'other',
      'no-product',
    ])
    // The five products take the five categorical stops, in rank order.
    expect(first.series.slice(0, REVENUE_TOP_PRODUCTS).map((series) => series.seriesIndex)).toEqual([0, 1, 2, 3, 4])
    // The two non-product series are neutral ink, never a sixth stop.
    expect(first.series[5].color).toBe(REVENUE_OTHER_COLOR)
    expect(first.series[6].color).toBe(REVENUE_NO_PRODUCT_COLOR)
    expect(first.series[5].seriesIndex).toBeUndefined()
    expect(first.series[6].seriesIndex).toBeUndefined()
  })

  it('adds up to the day’s revenue — the tile and the bars cannot disagree', () => {
    const days = revenueChartDays(SUMMARY, RANGE)
    const totals = days.map((day) => day.series.reduce((sum, series) => sum + series.amount, 0))
    expect(totals[0]).toBeCloseTo(0.6)
    expect(totals[1]).toBeCloseTo(1.075)
    expect(totals[2]).toBe(0)
    // And the period's bars add up to the Revenue tile's figure.
    expect(totals.reduce((sum, total) => sum + total, 0)).toBeCloseTo(1.675)
  })

  it('folds the products past the fifth into Other, and keeps a top-five product’s slot on a quiet day', () => {
    const days = revenueChartDays(SUMMARY, RANGE)
    const other = days[1].series.find((series) => series.id === 'other')
    // p6 + p7 = 0.075 — the products the chart does not name.
    expect(other?.amount).toBeCloseTo(0.075)
    // p1 sold nothing on the 17th, but its slot is still there at zero, so its
    // colour and legend row hold across the period.
    expect(days[1].series.find((series) => series.id === 'product:p1')?.amount).toBe(0)
  })

  it('leaves out a series with no revenue in the whole period', () => {
    const noOther = {
      ...SUMMARY,
      by_product: SUMMARY.by_product.slice(0, 5),
      without_product: { count: 0, amount_raw: '0' },
      by_day: SUMMARY.by_day.map((day) => ({ ...day, without_product_raw: '0' })),
    } as SalesSummary
    const [first] = revenueChartDays(noOther, RANGE)
    expect(first.series.map((series) => series.id)).toEqual([
      'product:p1',
      'product:p2',
      'product:p3',
      'product:p4',
      'product:p5',
    ])
  })

  it('strikes the bars in the display currency when a rate is given (#4963)', () => {
    const [first] = revenueChartDays(SUMMARY, RANGE, 11.2)
    expect(first.series[0].amount).toBeCloseTo(0.5 * 11.2)
  })
})

describe('revenueChartLabel', () => {
  it('is revenue wording, with the period’s total and the payments behind it', () => {
    expect(revenueChartLabel(SUMMARY, usd, 3)).toBe('Revenue over 3 days: $1.6750 from 8 payments.')
  })

  it('keeps a sum’s sub-cent part, as the Revenue tile does (#5088)', () => {
    expect(revenueChartLabel({ ...SUMMARY, revenue_raw: '13500' }, usd, 3)).toBe('Revenue over 3 days: $0.0135 from 8 payments.')
  })
})

describe('the Not counted tile’s words', () => {
  it('names the transfers, and says there were none rather than “0 transfers”', () => {
    expect(ownMovesCaption(0)).toBe('No transfers between your accounts')
    expect(ownMovesCaption(1)).toBe('1 transfer between your accounts')
    expect(ownMovesCaption(2)).toBe('2 transfers between your accounts')
  })

  it('says what the figure is and what it is not', () => {
    expect(OWN_MOVES_HINT).toMatch(/never revenue/)
    expect(OWN_MOVES_HINT).toMatch(/in no total/)
  })
})

describe('the By product lines the revenue side reuses', () => {
  it('names every product, folds the rest into Other, and lists No product last', () => {
    const lines = productLines(SUMMARY, usd)
    expect(lines.map((line) => line.name)).toEqual([
      'Chat completion',
      'Embeddings',
      'Rerank',
      'Vision',
      'Speech',
      'Translate',
      'Summarise',
      'No product',
    ])
    expect(lines[lines.length - 1].muted).toBe(true)
    expect(lines[lines.length - 1].countNoun).toBe('payment')
  })
})
