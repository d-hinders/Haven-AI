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
import { formatAnalyticsDay, formatAnalyticsTick, unknownRecipientShortAddress } from '@/lib/analytics-format'
import { formatClockTime, formatFiatDisplay } from '@/lib/format'
import type { ListState, PeriodValue } from '@/components/ui/list-url-codec'
import type { StackedBarDay } from '@/components/ui/StackedBarChart'
import type { BreakdownLine } from '@/components/sales/SalesBreakdownCard'

export type SalesSummary = ApiSchema<'MerchantSalesSummary'>
export type SalesPayment = ApiSchema<'MerchantSalesPayment'>
export type SalesPaymentsPage = ApiSchema<'MerchantSalesPaymentsPage'>
export type SalesPayer = ApiSchema<'MerchantSalesPayer'>
export type SalesFacets = ApiSchema<'MerchantSalesFacets'>
export type SalesKind = SalesPayment['kind']

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

/**
 * Every UTC calendar day of a range, in order — the axis both revenue charts
 * draw one slot per day on (the Sales By-day chart and the Analytics Revenue
 * chart, #4901), so a quiet day is an empty slot rather than a missing one.
 */
export function salesDayKeys(range: SalesDayRange): string[] {
  const start = utcDayMs(range.from)
  return Array.from({ length: salesRangeDays(range) }, (_, i) => utcDayKey(start + i * DAY_MS))
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

/**
 * #4963: the chart's formatters. The chart's amounts are already struck in the
 * display currency (`salesChartDays` with the rate), so its values and its
 * axis ticks format those numbers as they are; in token mode both read USDC.
 */
export function salesChartFormat(money: SalesMoney): {
  rate: number | null
  formatValue: (value: number) => string
  formatTick: (value: number, step: number) => string
} {
  const rate = salesRate(money)
  if (rate === null) return { rate, formatValue: tokenText, formatTick: (value) => tokenText(value) }
  return {
    rate,
    formatValue: (value) => formatFiatDisplay(value, money.currency),
    formatTick: (value, step) => formatAnalyticsTick(value, step, money.currency),
  }
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

/**
 * Every payment the ledger lists for the period: the account's sales,
 * no-product payments and own moves, plus the sales received in Stripe — the
 * list carries both kinds (#4952), so its count does too.
 */
export function ledgerCount(summary: SalesSummary): number {
  return accountLedgerCount(summary) + stripeSalesCount(summary)
}

/** The payments into the Sales account itself: the ones every account figure describes. */
export function accountLedgerCount(summary: SalesSummary): number {
  return summary.sales + summary.without_product.count + summary.own_moves.count
}

// ── Received in Stripe (#4954; dev and Stripe sandbox) ──────────────────────
//
// A sale paid to a Stripe deposit address the owner registered (#4952) is in
// no account figure: Revenue, Sales, Average sale, the chart and both
// breakdowns count the Sales account's payments only. Stripe-held sales have
// ONE figure of their own, `received_in_stripe`, so each kind agrees with its
// own rows. Nothing here is a Stripe balance: Haven reads no Stripe account,
// only what the chain says reached the registered address.

/** The mark a Stripe-held sale carries, in the row and in its detail. */
export const STRIPE_MARK = { label: 'Received in Stripe', tone: 'brand' } as const

/** The sales received at a registered Stripe deposit address in the period. */
export function stripeSalesCount(summary: SalesSummary): number {
  return summary.received_in_stripe?.count ?? 0
}

/** Their amount, atomic USDC. */
export function stripeSalesRaw(summary: SalesSummary): string {
  return summary.received_in_stripe?.amount_raw ?? '0'
}

/** True for a sale received in Stripe, from the row's `held_by` (the registry's answer, never the record's). */
export function isStripeHeld(payment: { held_by?: string | null }): boolean {
  return payment.held_by === 'stripe'
}

/** Payments that count as revenue: sales plus payments with no product. */
export function revenueCount(summary: SalesSummary): number {
  return summary.sales + summary.without_product.count
}

/** The payers the Sales tile says the sales came from. */
export function payerCount(summary: SalesSummary): number {
  return summary.by_payer.length + summary.by_payer_other.payers
}

/** "N payment(s) of $X": the words the own-moves notice and the tiles share. */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * The By product lines: every product, the products folded into "Other", then
 * payments with no product. One projection for both revenue surfaces — the
 * Sales Overview's By product card and the Analytics Revenue side (#4901) —
 * so the two pages cannot disagree about what a product line says.
 */
export function productLines(summary: SalesSummary, money: SalesMoney): BreakdownLine[] {
  const lines: BreakdownLine[] = summary.by_product.map((product) => ({
    key: `product:${product.product_id}`,
    name: product.label,
    detail: product.product_id !== product.label ? product.product_id : undefined,
    revenue: salesAmountText(product.amount_raw, money),
    count: product.sales,
  }))
  const other = summary.by_product_other
  if (other.products > 0 || other.sales > 0) {
    lines.push({
      key: 'product:other',
      name: 'Other',
      detail: plural(other.products, 'product'),
      revenue: salesAmountText(other.amount_raw, money),
      count: other.sales,
    })
  }
  if (summary.without_product.count > 0) {
    lines.push({
      key: 'product:none',
      name: 'No product',
      detail: 'Paid, but your kit sent no sale record',
      revenue: salesAmountText(summary.without_product.amount_raw, money),
      count: summary.without_product.count,
      muted: true,
      countNoun: 'payment',
    })
  }
  return lines
}

/** Nothing in the period reached the account or a registered Stripe address (a quiet period, not a first run). */
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
export function salesChartDays(
  summary: SalesSummary,
  range: SalesDayRange,
  /** #4963: the display-currency rate; the bars, and so the ticks, are struck in it. Null keeps USDC. */
  rate: number | null = null,
): StackedBarDay[] {
  const revenueByDay = new Map(summary.by_day.map((d) => [d.day, usdcOf(d.revenue_raw) * (rate ?? 1)]))
  return salesDayKeys(range).map((day) => {
    const amount = revenueByDay.get(day) ?? 0
    return {
      label: formatAnalyticsDay(day),
      series: amount > 0 ? [{ ...REVENUE_SERIES, amount, seriesIndex: 0 }] : [],
    }
  })
}

// ── Filters and search (#4960; the reads are #4959) ─────────────────────────

/**
 * The URL keys of the payments list's controls, beside the period. Product and
 * payer options load with the facets read, so they list no `values` (a value
 * read before the options arrive must survive); Recorded's three are fixed.
 */
export const SALES_FACET_KEYS = { product: 'product', payer: 'payer', kind: 'recorded' } as const

/** The Recorded facet's values (the reads' `kind`) and the words each one renders as; the raw kind never renders. */
export const SALES_KIND_LABELS: Readonly<Record<SalesKind, string>> = {
  sale: 'Sale',
  no_product: 'No product recorded',
  own_move: 'Moved between your accounts',
}
export const SALES_KINDS = Object.keys(SALES_KIND_LABELS) as SalesKind[]

/** What every Overview read sends for one control state. Empty lists and an empty search are "no filter". */
export interface SalesFilters {
  q: string
  products: string[]
  payers: string[]
  kinds: SalesKind[]
}

export const NO_SALES_FILTERS: SalesFilters = { q: '', products: [], payers: [], kinds: [] }

/**
 * The reads refuse a search under 2 characters or over 100 (#4959), counted
 * as the backend's schema counts them: in CODE POINTS, so one emoji is one
 * character, not the two UTF-16 units `.length` would say.
 */
const SEARCH_MIN = 2
const SEARCH_MAX = 100

/** The search the reads are sent: trimmed, cut at 100 characters, and only once it is 2 or more. */
export function salesSearchTerm(q: string): string {
  const term = Array.from(q.trim()).slice(0, SEARCH_MAX).join('').trim()
  return Array.from(term).length >= SEARCH_MIN ? term : ''
}

/**
 * A product id as a facet value in the URL, and back. A product id is free
 * text (1–200 characters), but the list codec joins a facet's values with
 * commas, trims each one and reads `all` as All. An id that would not survive
 * that — one with a comma, an outer space, a leading `~`, or the word `all` —
 * is written as `~` and its percent-encoding (which holds no comma or space);
 * every other id is written as itself, so an ordinary link shows the plain id.
 */
const PRODUCT_ESCAPE = '~'

export function productFacetValue(productId: string): string {
  const unsafe =
    productId.includes(',') ||
    productId !== productId.trim() ||
    productId.startsWith(PRODUCT_ESCAPE) ||
    productId.toLowerCase() === 'all'
  return unsafe ? `${PRODUCT_ESCAPE}${encodeURIComponent(productId)}` : productId
}

export function productIdFromFacetValue(value: string): string {
  if (!value.startsWith(PRODUCT_ESCAPE)) return value
  try {
    return decodeURIComponent(value.slice(PRODUCT_ESCAPE.length))
  } catch {
    return value
  }
}

/** The control state as the reads' filters. */
export function salesFiltersFromList(state: ListState): SalesFilters {
  const kinds = (state.facets[SALES_FACET_KEYS.kind] ?? []).filter((k): k is SalesKind => SALES_KINDS.includes(k as SalesKind))
  return {
    q: salesSearchTerm(state.q),
    products: (state.facets[SALES_FACET_KEYS.product] ?? []).map(productIdFromFacetValue),
    payers: state.facets[SALES_FACET_KEYS.payer] ?? [],
    kinds,
  }
}

/** True when any filter narrows the reads. */
export function hasSalesFilters(filters: SalesFilters): boolean {
  return filters.q !== '' || filters.products.length > 0 || filters.payers.length > 0 || filters.kinds.length > 0
}

/**
 * The filters as query parameters, in one fixed order so the same filters are
 * the same string (the hooks key their reads on it). Each list value repeats
 * its key, as the reads take it.
 */
export function salesFilterQuery(filters: SalesFilters): string {
  const params = new URLSearchParams()
  for (const kind of [...filters.kinds].sort()) params.append('kind', kind)
  for (const product of [...filters.products].sort()) params.append('product_id', product)
  for (const payer of [...filters.payers].map((p) => p.toLowerCase()).sort()) params.append('payer', payer)
  if (filters.q !== '') params.set('q', filters.q)
  return params.toString()
}

/**
 * "Today, 14:17" or "12 Nov, 09:10": when a payer last paid, in the VIEWER's
 * local time (the periods and `by_day` stay UTC days). The year is added only
 * when it is not this year.
 */
export function lastPaidText(iso: string, now: Date = new Date()): string {
  const at = new Date(iso)
  const time = formatClockTime(at)
  const sameDay =
    at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate()
  if (sameDay) return `Today, ${time}`
  const day = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  }).format(at)
  return `${day}, ${time}`
}

// ── The payment's detail ────────────────────────────────────────────────────

export type SalesPaymentDetail = ApiSchema<'MerchantSalesPaymentDetail'>

/** A payment hash the explorer can open: a 32-byte hex string. A Stripe-held sale carries one too: the payment into the deposit address. */
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
