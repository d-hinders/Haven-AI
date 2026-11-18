import { describe, expect, it } from 'vitest'
import {
  lastPaidText,
  productFacetValue,
  productIdFromFacetValue,
  salesSearchTerm,
  catalogueChainId,
  catalogueHost,
  catalogueNeedsAttention,
  catalogueView,
  accountLedgerCount,
  isEmptyPeriod,
  isOnChainHash,
  isStripeHeld,
  ledgerCount,
  stripeSalesCount,
  stripeSalesRaw,
  payerKindLine,
  payerName,
  payerSubline,
  previousSalesRange,
  revenueChangePercent,
  salesAmountText,
  salesApprox,
  salesRate,
  salesTotalText,
  type SalesMoney,
  salesChartDays,
  salesDayRange,
  salesRangeDays,
  tokenText,
  usdcExactText,
  usdcText,
  type SalesCatalogue,
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

describe('a wallet is never named, whatever name it carries (owner decision 2, #4894)', () => {
  // A wallet that arrives with a name (another Haven user's agent, say) must
  // still read as "Wallet": the page never tells a merchant a payer uses Haven.
  const NAMED_WALLET = { kind: 'wallet' as const, name: "Someone's agent", address: WALLET.address }

  it('reads as Wallet in the name, the subline and the kind line', () => {
    expect(payerName(NAMED_WALLET)).toBe('Wallet')
    expect(payerSubline(NAMED_WALLET, false)).toBe('Wallet · 0x8f3a…21c0')
    expect(payerKindLine(NAMED_WALLET)).toBe('0x8f3a…21c0')
    expect(payerSubline(NAMED_WALLET, false)).not.toContain('Someone')
  })

  it('says an own payer is an account or an agent, which the read does not tell apart', () => {
    expect(payerKindLine({ kind: 'own', name: 'Atlas', address: '0x2' })).toBe('Your account or agent')
  })
})

describe('amounts', () => {
  it('floors a token figure under four decimals', () => {
    expect(tokenText(0.00004)).toBe('<0.0001 USDC')
    expect(usdcText('10')).toBe('<0.0001 USDC')
    expect(usdcText('4500')).toBe('0.0045 USDC')
    expect(usdcText('0')).toBe('0.00 USDC')
  })

  const BASE = 8453
  const RATES = { usd: 0.9998, eur: 0.92, sek: 10.5 }
  const usd: SalesMoney = { currency: 'USD', chainId: BASE, rates: RATES }
  const sek: SalesMoney = { currency: 'SEK', chainId: BASE, rates: RATES }
  const eur: SalesMoney = { currency: 'EUR', chainId: BASE, rates: RATES }
  const nbsp = '\u00a0'

  it('follows the sub-cent rule in USD', () => {
    expect(salesAmountText('18000', usd)).toBe('$0.02')
    expect(salesAmountText('4500', usd)).toBe('$0.0045')
    expect(salesAmountText('2140000', usd)).toBe('$2.14')
  })

  it('strikes USD 1:1 from the registry peg, never reading rates.usd, and never marks it', () => {
    expect(salesRate(usd)).toBe(1)
    expect(salesAmountText('2140000', usd)).toBe('$2.14')
    expect(salesAmountText('2140000', { ...usd, rates: undefined })).toBe('$2.14')
    expect(salesApprox(usd, 'total')).toBe(false)
    expect(salesTotalText('2140000', usd)).toBe('$2.14')
  })

  it('converts SEK and EUR by the rate and marks totals and details, never rows', () => {
    expect(salesAmountText('2140000', sek)).toBe(`22,47${nbsp}kr`)
    expect(salesAmountText('2140000', eur)).toBe(`1,97${nbsp}\u20ac`)
    expect(salesApprox(sek, 'total')).toBe(true)
    expect(salesApprox(eur, 'detail')).toBe(true)
    expect(salesApprox(sek, 'row')).toBe(false)
    expect(salesTotalText('2140000', sek)).toBe(`\u224822,47${nbsp}kr`)
  })

  it('reads in USDC, not a converted figure, where that currency has no rate or no rates are on the wire', () => {
    expect(salesAmountText('2140000', { ...sek, rates: { ...RATES, sek: null } })).toBe('2.14 USDC')
    expect(salesAmountText('4500', { ...eur, rates: null as never })).toBe('0.0045 USDC')
    expect(salesAmountText('2140000', { ...sek, rates: undefined })).toBe('2.14 USDC')
    expect(salesApprox({ ...sek, rates: undefined }, 'total')).toBe(false)
    expect(salesTotalText('2140000', { ...sek, rates: undefined })).toBe('2.14 USDC')
  })

  it('does not treat an unknown chain as pegged: USD then needs its rate', () => {
    expect(salesRate({ currency: 'USD', chainId: null, rates: undefined })).toBeNull()
    expect(salesRate({ currency: 'USD', chainId: null, rates: RATES })).toBe(0.9998)
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

  it('#4954: lists the Stripe sales too, and counts them apart from the account', () => {
    const withStripe = { ...summary, received_in_stripe: { count: 2, amount_raw: '30000' } } as SalesSummary
    expect(accountLedgerCount(withStripe)).toBe(6)
    expect(stripeSalesCount(withStripe)).toBe(2)
    expect(stripeSalesRaw(withStripe)).toBe('30000')
    expect(ledgerCount(withStripe)).toBe(8)
    // An older backend without the field reads as none.
    expect(stripeSalesCount(summary)).toBe(0)
    expect(stripeSalesRaw(summary)).toBe('0')
  })

  it('#4954: a period with only Stripe sales is not empty', () => {
    const none = { ...summary, sales: 0, without_product: { count: 0, amount_raw: '0' }, own_moves: { count: 0, amount_raw: '0' } } as unknown as SalesSummary
    expect(isEmptyPeriod(none)).toBe(true)
    expect(isEmptyPeriod({ ...none, received_in_stripe: { count: 1, amount_raw: '10000' } } as SalesSummary)).toBe(false)
  })

  it('#4954: Stripe-held is the row\'s held_by, and nothing else', () => {
    expect(isStripeHeld({ held_by: 'stripe' })).toBe(true)
    expect(isStripeHeld({ held_by: 'account' })).toBe(false)
    expect(isStripeHeld({})).toBe(false)
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

describe('exact USDC prices (a token surface)', () => {
  it('keeps every decimal the atomic amount has, and never fewer than two', () => {
    expect(usdcExactText('18000')).toBe('0.018 USDC')
    expect(usdcExactText('100')).toBe('0.0001 USDC')
    expect(usdcExactText('1000000')).toBe('1.00 USDC')
    expect(usdcExactText('1230000')).toBe('1.23 USDC')
    expect(usdcExactText('1234567')).toBe('1.234567 USDC')
    expect(usdcExactText('0')).toBe('0.00 USDC')
    expect(usdcExactText('12345000000')).toBe('12,345.00 USDC')
  })
})

describe('the catalogue', () => {
  const none: SalesCatalogue = {
    deployment_url: null,
    last_read_at: null,
    last_read_status: 'never',
    last_read_detail: null,
    mismatch: false,
    mismatch_reason: null,
    document_name: null,
    document_operator_name: null,
    document_network: null,
    document_pay_to: null,
    document_updated: null,
    products: [],
  }
  const saved = { ...none, deployment_url: 'https://inference.example.com' }

  it('names the view the read puts the Products tab in', () => {
    expect(catalogueView(none)).toBe('none')
    expect(catalogueView(saved)).toBe('never')
    expect(catalogueView({ ...saved, last_read_status: 'ok' })).toBe('ok')
    expect(catalogueView({ ...saved, last_read_status: 'unreachable' })).toBe('unreachable')
    expect(catalogueView({ ...saved, last_read_status: 'malformed' })).toBe('malformed')
    expect(catalogueView({ ...saved, last_read_status: 'refused' })).toBe('refused')
    // A mismatch wins over the status the flag rides on.
    expect(catalogueView({ ...saved, last_read_status: 'ok', mismatch: true })).toBe('mismatch')
    expect(catalogueView({ ...saved, last_read_status: 'mismatch' })).toBe('mismatch')
  })

  it('flags the tabs only for a list Haven is not using or could not read', () => {
    expect(catalogueNeedsAttention(null)).toBe(false)
    expect(catalogueNeedsAttention(none)).toBe(false)
    expect(catalogueNeedsAttention({ ...saved, last_read_status: 'ok' })).toBe(false)
    expect(catalogueNeedsAttention({ ...saved, last_read_status: 'unreachable' })).toBe(true)
    expect(catalogueNeedsAttention({ ...saved, mismatch: true })).toBe(true)
  })

  it('reads the chain and host from the strings the document carries', () => {
    expect(catalogueChainId('eip155:8453')).toBe(8453)
    expect(catalogueChainId('solana:mainnet')).toBeUndefined()
    expect(catalogueChainId(null)).toBeUndefined()
    expect(catalogueHost('https://inference.example.com')).toBe('inference.example.com')
    expect(catalogueHost('not a url')).toBe('not a url')
  })

  it('tells an on-chain hash from a held-by-Stripe reference', () => {
    expect(isOnChainHash(`0x${'ab'.repeat(32)}`)).toBe(true)
    expect(isOnChainHash('pi_3Q8example')).toBe(false)
    expect(isOnChainHash('0xab')).toBe(false)
  })
})

describe('filters and Last paid (#4960)', () => {
  // Local-time instants: the text is the VIEWER's clock, whatever zone runs the test.
  const now = new Date(2026, 10, 17, 20, 0)

  it('says Today with the time for a payment earlier today', () => {
    expect(lastPaidText(new Date(2026, 10, 17, 14, 17).toISOString(), now)).toBe('Today, 14:17')
  })

  it('says the day and the time for an earlier day of this year, and adds the year otherwise', () => {
    expect(lastPaidText(new Date(2026, 10, 12, 9, 10).toISOString(), now)).toBe('12 Nov, 09:10')
    expect(lastPaidText(new Date(2026, 10, 16, 23, 59).toISOString(), now)).toBe('16 Nov, 23:59')
    expect(lastPaidText(new Date(2025, 10, 12, 9, 10).toISOString(), now)).toBe('12 Nov 2025, 09:10')
  })

  it('sends a search only from two characters, counted as the backend counts them (code points)', () => {
    expect(salesSearchTerm('a')).toBe('')
    expect(salesSearchTerm('  a  ')).toBe('')
    expect(salesSearchTerm('ab')).toBe('ab')
    // One emoji is TWO UTF-16 units but ONE character to the backend's schema: not sent.
    expect(salesSearchTerm('😀')).toBe('')
    expect(salesSearchTerm('😀😀')).toBe('😀😀')
    // Cut at 100 characters without splitting a surrogate pair.
    const long = '😀'.repeat(120)
    expect(Array.from(salesSearchTerm(long))).toHaveLength(100)
    expect(salesSearchTerm(long)).toBe('😀'.repeat(100))
  })

  it('keeps any product id intact through the comma-joined URL facet', () => {
    for (const id of ['chat', 'pro,annual', ' padded ', 'all', 'ALL', '~tilde', '100%', 'a b']) {
      const value = productFacetValue(id)
      expect(value.includes(','), id).toBe(false)
      expect(value, id).toBe(value.trim())
      expect(value.toLowerCase(), id).not.toBe('all')
      expect(productIdFromFacetValue(value), id).toBe(id)
    }
    // An ordinary id is written as itself.
    expect(productFacetValue('chat')).toBe('chat')
  })
})
