/**
 * The pure half of the Sales page (#4900, epic #4885).
 *
 * The reads (`GET /merchant-sales/*`, #4897) answer in atomic USDC and in the
 * owner's own vocabulary of payer kinds. Everything the page decides that does
 * not need React lives here so one fixture can prove the tiles, the
 * breakdowns and the rows agree: the period's UTC day range, the previous
 * period for the Revenue comparison, the payer's name, the amount's words and
 * the figures the page derives from the summary.
 *
 * Every money figure is struck by ONE helper (`salesRate`, #4963): USDC atomic
 * to the display currency, from the one rate the answer it came from carries.
 */

import { shouldMarkApprox, tokenPeg, type ApiSchema } from '@haven_ai/core'
import { formatAnalyticsDay, unknownRecipientShortAddress } from '@/lib/analytics-format'
import { formatFiatDisplay } from '@/lib/format'
import type { PeriodValue } from '@/components/ui/list-url-codec'
import type { StackedBarDay } from '@/components/ui/StackedBarChart'

export type SalesSummary = ApiSchema<'MerchantSalesSummary'>
export type SalesPayment = ApiSchema<'MerchantSalesPayment'>
export type SalesPaymentsPage = ApiSchema<'MerchantSalesPaymentsPage'>
export type SalesPayer = ApiSchema<'MerchantSalesPayer'>

/** The page size the ledger asks for and "Show N more" names. */
export const SALES_PAGE_SIZE = 50

/** USDC has six decimals; the reads never pre-scale. */
const USDC_DECIMALS = 6

// ── The period ──────────────────────────────────────────────────────────────

/** A period as the reads take it: UTC calendar days, both inclusive. */
export interface SalesDayRange {
  from: string
  to: string
}

const DAY_MS = 24 * 60 * 60 * 1000

function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function utcDayMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`)
}

/**
 * The URL's period as a day range. A preset is the last N UTC days INCLUDING
 * today (so "Last 30 days" is 30 calendar days, not 31); a custom range is its
 * own days. Anything else (All time) is not a range the page offers, so it
 * reads as the default 30 days rather than an unbounded read.
 */
export function salesDayRange(period: PeriodValue | undefined, now: Date = new Date()): SalesDayRange {
  if (period?.from && period.to) return { from: period.from, to: period.to }
  const days = period?.preset ? Number(period.preset.replace('d', '')) : 30
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return { from: utcDayKey(today - (days - 1) * DAY_MS), to: utcDayKey(today) }
}

/** The days in a range, both ends included. */
export function salesRangeDays(range: SalesDayRange): number {
  return Math.round((utcDayMs(range.to) - utcDayMs(range.from)) / DAY_MS) + 1
}

/** The period of the same length that ends the day before this one starts. */
export function previousSalesRange(range: SalesDayRange): SalesDayRange {
  const days = salesRangeDays(range)
  const to = utcDayMs(range.from) - DAY_MS
  return { from: utcDayKey(to - (days - 1) * DAY_MS), to: utcDayKey(to) }
}

// ── Amounts ─────────────────────────────────────────────────────────────────

/** Atomic USDC to a number of dollars. Safe far past any single merchant's total. */
export function usdcOf(raw: string): number {
  return Number(BigInt(raw || '0')) / 10 ** USDC_DECIMALS
}

/** The display currencies the page can show. */
export type SalesCurrency = 'USD' | 'EUR' | 'SEK'

/** Today's USDC price in each display currency, as the reads carry it (#4963). */
export type SalesUsdcRates = ApiSchema<'MerchantSalesUsdcRates'>

/**
 * How one view strikes its figures: the display currency, the Sales account's
 * chain (it decides whether USDC IS the display currency), and the ONE rate
 * the view's answer carries. `rates` is undefined for an older backend and
 * null when the read failed; both read as "no rate".
 */
export interface SalesMoney {
  currency: SalesCurrency
  chainId: number | null | undefined
  rates: SalesUsdcRates | undefined
}

/**
 * The multiplier from USDC to the display currency, or null for token mode.
 *
 * - The registry pegs USDC to the display currency (USD on Base): exactly 1,
 *   and `rates.usd` is never read — the feed says about 0.9998.
 * - Otherwise today's rate for that currency (EUR, SEK).
 * - No usable rate, or no `usdc_rates` at all: null, and the figure reads in
 *   USDC — the existing "an unknown rate falls back to token mode" rule
 *   (`lib/budget-caption.ts`).
 */
export function salesRate(money: SalesMoney): number | null {
  if (tokenPeg(money.chainId, 'USDC') === money.currency) return 1
  const rate = money.rates?.[money.currency.toLowerCase() as 'usd' | 'eur' | 'sek']
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : null
}

/** True when the figures strike in the display currency (the rate is known). */
export function salesInFiat(money: SalesMoney): boolean {
  return salesRate(money) !== null
}

/**
 * Whether a figure of this kind carries "≈": the one rule (`shouldMarkApprox`),
 * asked only where the figure was actually converted. Rows never mark.
 */
export function salesApprox(money: SalesMoney, kind: 'total' | 'detail' | 'row'): boolean {
  return (
    salesInFiat(money) &&
    shouldMarkApprox({
      repriced: true,
      chainId: money.chainId,
      tokenSymbol: 'USDC',
      displayCurrency: money.currency,
      kind,
    })
  )
}

/** USDC in words: two decimals, four under a cent (the same sub-cent rule as fiat). */
export function usdcText(raw: string): string {
  return tokenText(usdcOf(raw))
}

/**
 * A figure in USDC as text: two decimals, four under a cent, and
 * "<0.0001 USDC" under the smallest figure four decimals can show (the same
 * floor `formatFiatDisplay` states in dollars).
 */
export function tokenText(human: number): string {
  if (human !== 0 && Math.abs(human) < 0.00005) return `${human < 0 ? '-' : ''}<0.0001 USDC`
  const digits = human !== 0 && Math.abs(human) < 0.01 ? 4 : 2
  return `${new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(human)} USDC`
}

/** A figure in USDC, converted to the display currency when there is a rate. */
export function salesFiatAmount(human: number, money: SalesMoney): number | null {
  const rate = salesRate(money)
  return rate === null ? null : human * rate
}

/** A figure in USDC as text, in the display currency's mode. */
export function salesNumberText(human: number, money: SalesMoney): string {
  const fiat = salesFiatAmount(human, money)
  return fiat === null ? tokenText(human) : formatFiatDisplay(fiat, money.currency)
}

/** One atomic amount as text, in the display currency's mode. */
export function salesAmountText(raw: string, money: SalesMoney): string {
  return salesNumberText(usdcOf(raw), money)
}

/**
 * A total or detail figure as text: "≈" prefixed where the conversion changes
 * the number, as the budget caption prints it (`lib/budget-caption.ts`).
 */
export function salesTotalText(raw: string, money: SalesMoney, kind: 'total' | 'detail' = 'total'): string {
  return `${salesApprox(money, kind) ? '≈' : ''}${salesAmountText(raw, money)}`
}

// ── Payers ──────────────────────────────────────────────────────────────────

/**
 * What a payer is called. A contact or one of the owner's own accounts and
 * agents is named; EVERY other payer is "Wallet" — including another Haven
 * user's agent, because the page never tells a merchant that a payer uses
 * Haven (owner decision 2, #4894). A named payer whose name is missing falls
 * back to "Wallet" rather than to an address.
 */
export function payerName(payer: SalesPayer | null): string {
  if (payer !== null && payer.kind !== 'wallet' && payer.name) return payer.name
  return 'Wallet'
}

/** The second line under a payer's name in the breakdown: its kind, or the short address of a wallet. */
export function payerKindLine(payer: SalesPayer | null): string {
  if (payer === null) return ''
  if (payer.kind === 'contact' && payer.name) return 'Contact'
  // `own` covers the owner's accounts AND agents and the payer does not say
  // which, so the line is true for both.
  if (payer.kind === 'own' && payer.name) return 'Your account or agent'
  return unknownRecipientShortAddress(payer.address)
}

/** The payer in a ledger row's subline: the name, with a wallet's short address beside it. */
export function payerSubline(payer: SalesPayer | null, severalPayers: boolean): string {
  if (payer === null) return severalPayers ? 'Several wallets' : 'Wallet'
  if (payer.kind !== 'wallet' && payer.name) return payer.name
  return `Wallet · ${unknownRecipientShortAddress(payer.address)}`
}

/** A stable key for a payer row, by address (the reads give one row per payer). */
export function payerKey(payer: SalesPayer): string {
  return `${payer.kind}:${payer.address.toLowerCase()}`
}

// ── What the summary says ───────────────────────────────────────────────────

/** Every payment the ledger lists for the period: sales, no-product payments and own moves. */
export function ledgerCount(summary: SalesSummary): number {
  return summary.sales + summary.without_product.count + summary.own_moves.count
}

/** Payments that count as revenue: sales plus payments with no product. */
export function revenueCount(summary: SalesSummary): number {
  return summary.sales + summary.without_product.count
}

/** The payers the Sales tile says the sales came from. */
export function payerCount(summary: SalesSummary): number {
  return summary.by_payer.length + summary.by_payer_other.payers
}

/** Nothing in the period reached the account at all (a quiet period, not a first run). */
export function isEmptyPeriod(summary: SalesSummary): boolean {
  return ledgerCount(summary) === 0
}

/** The revenue change against the previous period, as a signed whole percent; null when there is no basis. */
export function revenueChangePercent(current: SalesSummary, previous: SalesSummary | null): number | null {
  if (previous === null) return null
  const before = usdcOf(previous.revenue_raw)
  if (before <= 0) return null
  return ((usdcOf(current.revenue_raw) - before) / before) * 100
}

// ── The chart ───────────────────────────────────────────────────────────────

/** The one series the by-day chart draws: revenue, in the brand colour. */
export const REVENUE_SERIES = { id: 'revenue', name: 'Revenue' } as const

/**
 * One slot per calendar day of the period, so a quiet day is an empty slot and
 * the axis reads as time. The reads give each day's revenue only, not its
 * products, so the bar is one series (a stack by product needs `by_day` to
 * carry them).
 */
export function salesChartDays(summary: SalesSummary, range: SalesDayRange): StackedBarDay[] {
  const revenueByDay = new Map(summary.by_day.map((d) => [d.day, usdcOf(d.revenue_raw)]))
  const start = utcDayMs(range.from)
  return Array.from({ length: salesRangeDays(range) }, (_, i) => {
    const day = utcDayKey(start + i * DAY_MS)
    const amount = revenueByDay.get(day) ?? 0
    return {
      label: formatAnalyticsDay(day),
      series: amount > 0 ? [{ ...REVENUE_SERIES, amount, seriesIndex: 0 }] : [],
    }
  })
}

// ── The payment's detail ────────────────────────────────────────────────────

export type SalesPaymentDetail = ApiSchema<'MerchantSalesPaymentDetail'>

/** A payment hash the explorer can open: a 32-byte hex string. A future held-by-Stripe row carries none. */
export function isOnChainHash(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value)
}

// ── The catalogue ───────────────────────────────────────────────────────────

export type SalesCatalogue = ApiSchema<'MerchantCatalogueState'>
export type SalesCatalogueProduct = ApiSchema<'MerchantCatalogueProduct'>
export type SalesKey = ApiSchema<'MerchantKey'>

/**
 * A product's price in USDC, exact: every decimal the atomic amount has (at
 * most six), trailing zeros dropped, never fewer than two. Products is a token
 * surface — the ledger rounds a $0.018 call to $0.02, and this is where the
 * exact figure is.
 */
export function usdcExactText(atomic: string): string {
  let raw: bigint
  try {
    raw = BigInt(atomic || '0')
  } catch {
    return `${atomic} USDC`
  }
  const whole = raw / BigInt(10 ** USDC_DECIMALS)
  const fraction = (raw % BigInt(10 ** USDC_DECIMALS)).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '')
  const decimals = fraction.padEnd(2, '0')
  return `${new Intl.NumberFormat('en-US').format(whole)}.${decimals} USDC`
}

/** The chain a CAIP-2 network names (`eip155:8453`), or undefined for one Haven does not know. */
export function catalogueChainId(network: string | null | undefined): number | undefined {
  const match = network ? /^eip155:(\d+)$/.exec(network) : null
  return match ? Number(match[1]) : undefined
}

/** The host of the saved kit address, for "Read from {host}". */
export function catalogueHost(deploymentUrl: string): string {
  try {
    return new URL(deploymentUrl).host
  } catch {
    return deploymentUrl
  }
}

/**
 * Which Products tab the catalogue read says, in the order the owner meets
 * them: no address saved; a read that has not happened; one whose document is
 * another account's (`mismatch`); one that could not be read or understood
 * (`unreachable`, `malformed`, `refused`); and a good list.
 */
export type CatalogueView = 'none' | 'never' | 'mismatch' | 'unreachable' | 'malformed' | 'refused' | 'ok'

export function catalogueView(catalogue: SalesCatalogue): CatalogueView {
  if (catalogue.deployment_url === null) return 'none'
  if (catalogue.mismatch || catalogue.last_read_status === 'mismatch') return 'mismatch'
  switch (catalogue.last_read_status) {
    case 'never':
      return 'never'
    case 'unreachable':
      return 'unreachable'
    case 'malformed':
      return 'malformed'
    case 'refused':
      return 'refused'
    default:
      return 'ok'
  }
}

/** The tabs the catalogue puts a warning dot on: a list Haven is not using, or one it could not read. */
export function catalogueNeedsAttention(catalogue: SalesCatalogue | null): boolean {
  if (catalogue === null) return false
  const view = catalogueView(catalogue)
  return view === 'mismatch' || view === 'unreachable' || view === 'malformed' || view === 'refused'
}
