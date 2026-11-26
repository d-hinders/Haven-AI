/**
 * The owner's sales reads and the clear action (#4897, epic #4885).
 *
 * The figures come from `infra/repositories/merchant-sales-reads.ts`, which
 * cuts the totals, the breakdowns and the list from one per-transaction
 * relation. This file is what sits on top of it:
 *
 * - the account a read is about: the user's merchant account, and only while
 *   merchant services are on (off, or no account, reads as the empty state);
 * - the period: whole UTC days, `from` inclusive, `to` inclusive;
 * - the keyset cursor over `(block_time, tx_hash)`;
 * - the payer KIND of every address, and the product LABEL of every sale;
 * - the filters and the search (#4959): the search term is matched HERE, in JS,
 *   against the same names and labels the reads show (the caller's own
 *   contacts, accounts and agents through `buildPayerDirectory`, and
 *   `labelProducts` over the period's products), and handed to the repository
 *   as addresses and product ids. The SQL never resolves a name, so it cannot
 *   disagree with what the page shows, and another Haven user's name is never
 *   matchable: it is in no index this file reads.
 *
 * ## Payer kinds, and what a read never says
 *
 * Each payer is one of: `contact` (an address-book entry, with the name), `own`
 * (one of the owner's own addresses: an account, or an agent's delegate address
 * current or replaced, with its name) or `wallet` (the address and nothing
 * else). Nothing in any read tells the merchant that a wallet belongs to
 * another Haven user or agent: the only lookups are the CALLER's own accounts,
 * agents and contacts, so another user's agent delegate is a `wallet`.
 *
 * ## The own flag, and its residual
 *
 * Whether a transfer is the owner's own is decided once, at index time, and
 * stored (`inbound_transfers.sender_is_own_address`); the reads never recompute
 * it, so a later account or rotation cannot rewrite past revenue. Migration 133
 * backfilled the rows indexed before the widened set existed. The remaining
 * residual: an ingest whose own-address lookup fails stamps false
 * (`receive.ts`), and nothing repairs that row, so such a transfer counts as
 * revenue while its payer reads `own`.
 *
 * Authority note (money-path gate): nothing here holds a key, signs or moves
 * funds. The one write is the owner clearing a sale record: it deletes the
 * merchant's statement, never a transfer.
 */
import { labelSaleProducts } from '../catalog/index.js'
import { settlementTokenForChain } from '../../domain/chains.js'
import { type FiatValues, loadTokenRates } from '../../infra/fiat-values.js'
import {
  findMerchantAccountForUser,
  readMerchantSetting,
} from '../../infra/repositories/merchant-services.js'
import { deleteMerchantSale } from '../../infra/repositories/merchant-sales.js'
import { listOwnAccountAddresses } from '../../infra/repositories/inbound-transfers.js'
import {
  countPayments,
  findPayment,
  listAgentNamesByDelegate,
  listPaymentLegs,
  listPayments,
  listPeriodSaleProducts,
  NO_FILTERS,
  type PaymentLegRow,
  readPeriodFacets,
  readSalesSummary,
  type SalesFilters,
  type PaymentKind,
  type PaymentRow,
  type PaymentsCursor,
  type PeriodBounds,
  type SalesScope,
} from '../../infra/repositories/merchant-sales-reads.js'
import { loadRecipientNameIndex } from './recipient-name-index.js'
import { resolveRecipientName } from './counterparty-name.js'
import { TX_HASH_PATTERN } from './receive.js'

export const PAYMENTS_DEFAULT_LIMIT = 50
export const PAYMENTS_MAX_LIMIT = 200

/** The merchant account the owner's reads are about, or null (off, or no account). */
export async function resolveSalesScope(userId: string): Promise<SalesScope | null> {
  const [setting, account] = await Promise.all([
    readMerchantSetting(userId),
    findMerchantAccountForUser(userId),
  ])
  if (!setting?.enabled || account === null) return null
  return { accountId: account.id, userId, chainId: Number(account.chain_id) }
}

/**
 * #4963: today's USDC rate in each display currency, for the page to convert
 * its USDC figures on the client. The symbol is the chain registry's settlement
 * token for the account's chain (never a literal), and every row of every read
 * is that token, so one triple serves a whole answer. `null` when the read
 * failed or the chain has no settlement token; one currency can be `null` alone
 * (a zero quote). A DISPLAY rate at today's price: it books nothing and gates
 * nothing, and a failed read costs the page its conversion, never its figures.
 */
export async function readUsdcRates(chainId: number): Promise<FiatValues | null> {
  let symbol: string | undefined
  try {
    symbol = settlementTokenForChain(chainId)?.symbol
  } catch {
    return null
  }
  if (symbol === undefined) return null
  return (await loadTokenRates([symbol])).get(symbol) ?? null
}

// --- period ---------------------------------------------------------------

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const DAY_MS = 24 * 60 * 60 * 1000

function parseUtcDay(value: string): number | null {
  const match = DAY_PATTERN.exec(value)
  if (!match) return null
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  const back = new Date(ms)
  // A real calendar day only: 2026-02-31 does not roll over into March.
  if (
    back.getUTCFullYear() !== Number(match[1]) ||
    back.getUTCMonth() !== Number(match[2]) - 1 ||
    back.getUTCDate() !== Number(match[3])
  ) {
    return null
  }
  return ms
}

export type PeriodParse = { ok: true; period: PeriodBounds } | { ok: false; message: string }

/**
 * `from` and `to` are UTC calendar days, both inclusive: `from=2026-11-01&to=
 * 2026-11-30` is the half-open interval [2026-11-01T00:00Z, 2026-12-01T00:00Z).
 * Either may be absent (unbounded on that side).
 */
export function parsePeriod(from: string | undefined, to: string | undefined): PeriodParse {
  let lower: Date | null = null
  let upper: Date | null = null
  if (from !== undefined) {
    const ms = parseUtcDay(from)
    if (ms === null) return { ok: false, message: '`from` must be a calendar day, YYYY-MM-DD (UTC).' }
    lower = new Date(ms)
  }
  if (to !== undefined) {
    const ms = parseUtcDay(to)
    if (ms === null) return { ok: false, message: '`to` must be a calendar day, YYYY-MM-DD (UTC).' }
    upper = new Date(ms + DAY_MS)
  }
  if (lower !== null && upper !== null && lower.getTime() >= upper.getTime()) {
    return { ok: false, message: '`from` must not be after `to`.' }
  }
  return { ok: true, period: { from: lower, to: upper } }
}

// --- cursor ---------------------------------------------------------------

const CURSOR_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2})(?::?(\d{2}))?)$/

/** A timestamp Postgres would accept: real calendar day, hour, minute, second and offset. */
function isRealTimestamp(text: string): boolean {
  const m = CURSOR_TIME_PATTERN.exec(text)
  if (!m) return false
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number)
  const d = new Date(Date.UTC(year, month - 1, day))
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return false
  if (hour > 23 || minute > 59 || second > 59) return false
  if (m[7] !== undefined && (Number(m[7]) > 15 || Number(m[8] ?? 0) > 59)) return false
  return true
}

export function encodePaymentsCursor(row: { block_time_text: string; tx_hash: string }): string {
  return Buffer.from(`${row.block_time_text}|${row.tx_hash}`, 'utf8').toString('base64url')
}

/** Null when the cursor is not one this read issued. */
export function decodePaymentsCursor(cursor: string): PaymentsCursor | null {
  let text: string
  try {
    text = Buffer.from(cursor, 'base64url').toString('utf8')
  } catch {
    return null
  }
  const parts = text.split('|')
  if (parts.length !== 2) return null
  const [blockTime, txHash] = parts
  if (!isRealTimestamp(blockTime) || !TX_HASH_PATTERN.test(txHash)) return null
  return { blockTime, txHash: txHash.toLowerCase() }
}

// --- payer ----------------------------------------------------------------

export type PayerKind = 'contact' | 'own' | 'wallet'

export interface PayerView {
  kind: PayerKind
  /** The contact's, account's or agent's name; null for a wallet (and an unnamed account). */
  name: string | null
  address: string
}

export type PayerResolver = (address: string | null) => PayerView | null

export interface PayerDirectory {
  resolve: PayerResolver
  /**
   * #4959: every address of the caller's own data that resolves to a NAME (a
   * contact, a named account, an agent's delegate current or replaced), as the
   * resolver shows it. The search matches names against this list only.
   */
  named: PayerView[]
}

/**
 * The classifier for one user's reads, built from the caller's own data only.
 * Own beats contact (the recipient-naming order, #4882); anything else is a
 * wallet. The names come from the existing loaders: the user's named accounts
 * and contacts through `loadRecipientNameIndex` read with NO candidate
 * addresses (so no catalogue or receipt source is consulted), and the agent
 * names by delegate address, which no existing loader covers.
 */
export async function buildPayerResolver(userId: string, chainId: number): Promise<PayerResolver> {
  return (await buildPayerDirectory(userId, chainId)).resolve
}

export async function buildPayerDirectory(userId: string, chainId: number): Promise<PayerDirectory> {
  const [own, index, agentNames] = await Promise.all([
    listOwnAccountAddresses(userId),
    loadRecipientNameIndex(userId, []),
    listAgentNamesByDelegate(userId),
  ])
  const ownSet = new Set(own)
  const resolve: PayerResolver = (address) => {
    if (address === null) return null
    const key = address.toLowerCase()
    const named = resolveRecipientName(index, { address: key, chainId, x402ResourceUrl: null })
    if (ownSet.has(key)) {
      return { kind: 'own', name: (named.kind === 'own_account' ? named.label : null) ?? agentNames.get(key) ?? null, address: key }
    }
    if (named.kind === 'contact') return { kind: 'contact', name: named.label, address: key }
    return { kind: 'wallet', name: null, address: key }
  }
  const candidates = new Set<string>([
    ...ownSet,
    ...index.contacts.keys(),
    ...index.accounts.map((a) => a.account_address.toLowerCase()),
    ...agentNames.keys(),
  ])
  const namedViews: PayerView[] = []
  for (const address of candidates) {
    const view = resolve(address)
    if (view !== null && view.name !== null) namedViews.push(view)
  }
  return { resolve, named: namedViews }
}

// --- labels ---------------------------------------------------------------

/**
 * The label of each distinct product: the catalogue's name when the id is known
 * there, else the record's name, else the product id (`labelSaleProducts` is
 * the first two steps, in one catalogue read for every product (#4959); the id
 * is the last).
 */
export async function labelProducts(
  accountId: string,
  products: ReadonlyArray<{ productId: string; recordName: string | null }>,
): Promise<Map<string, string>> {
  const named = await labelSaleProducts({ merchantAccountId: accountId, products })
  const labels = new Map<string, string>()
  for (const [productId, label] of named) labels.set(productId, label ?? productId)
  return labels
}

// --- filters and search (#4959) ------------------------------------------

/** The filters as the route hands them over, already validated by the spec. */
export interface SalesFilterInput {
  kind?: PaymentKind[]
  product_id?: string[]
  payer?: string[]
  q?: string
}

/** A partial address: `0x` and at least four hex digits (6 characters). */
const ADDRESS_PREFIX = /^0x[0-9a-f]{4,40}$/

function foldCase(text: string): string {
  return text.normalize('NFKC').toLowerCase()
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** True when the filter input filters nothing. */
function noFilter(input: SalesFilterInput): boolean {
  return input.kind === undefined && input.product_id === undefined && input.payer === undefined && input.q === undefined
}

/**
 * The filters a read hands the repository. The search term is resolved here
 * against the caller's own names and the period's product labels, so it
 * matches what the page shows and nothing else.
 */
export async function resolveSalesFilters(
  scope: SalesScope,
  period: PeriodBounds,
  input: SalesFilterInput,
): Promise<SalesFilters> {
  if (noFilter(input)) return NO_FILTERS
  const filters: SalesFilters = {
    kinds: input.kind ?? null,
    productIds: input.product_id ?? null,
    payers: input.payer?.map((a) => a.toLowerCase()) ?? null,
    search: null,
  }
  if (input.q === undefined) return filters
  const term = foldCase(input.q.trim())
  const [directory, products] = await Promise.all([
    buildPayerDirectory(scope.userId, scope.chainId),
    listPeriodSaleProducts(scope, period),
  ])
  const labels = await labelProducts(
    scope.accountId,
    products.map((p) => ({ productId: p.product_id, recordName: p.record_name })),
  )
  filters.search = {
    receiptPattern: `%${escapeLike(term)}%`,
    payers: directory.named.filter((v) => foldCase(v.name as string).includes(term)).map((v) => v.address),
    productIds: products
      .map((p) => p.product_id)
      .filter((id) => foldCase(id).includes(term) || foldCase(labels.get(id) ?? id).includes(term)),
    addressPrefix: ADDRESS_PREFIX.test(term) ? `${term}%` : null,
  }
  return filters
}

export interface SalesFacets {
  products: Array<{ product_id: string; label: string }>
  payers: PayerView[]
}

/** #4959: every product and payer of the period, unfiltered and uncapped, for the filter menus. */
export async function readSalesFacets(scope: SalesScope, period: PeriodBounds): Promise<SalesFacets> {
  const [raw, resolve] = await Promise.all([
    readPeriodFacets(scope, period),
    buildPayerResolver(scope.userId, scope.chainId),
  ])
  const labels = await labelProducts(
    scope.accountId,
    raw.products.map((p) => ({ productId: p.product_id, recordName: p.record_name })),
  )
  return {
    products: raw.products.map((p) => ({ product_id: p.product_id, label: labels.get(p.product_id) ?? p.product_id })),
    payers: raw.payers.map((a) => resolve(a) as PayerView),
  }
}

// --- reads ----------------------------------------------------------------

const ZERO = '0'

function payerView(resolve: PayerResolver, address: string | null) {
  return resolve(address)
}

/** The summary of the empty state: services off, or no merchant account. */
export function emptySummary(): SummaryResult {
  return {
    revenue_raw: ZERO,
    revenue_in_account_raw: ZERO,
    sales: 0,
    average_sale_raw: ZERO,
    without_product: { count: 0, amount_raw: ZERO },
    own_moves: { count: 0, amount_raw: ZERO },
    by_product: [],
    by_product_other: { products: 0, sales: 0, amount_raw: ZERO },
    by_payer: [],
    by_payer_other: { payers: 0, payments: 0, amount_raw: ZERO },
    unattributed: { payments: 0, amount_raw: ZERO },
    by_day: [],
    received_in_stripe: { count: 0, amount_raw: ZERO },
    usdc_rates: null,
  }
}

export interface SummaryByDay {
  day: string
  payments: number
  sales: number
  revenue_raw: string
  without_product_raw: string
  /** #4981: the part of `revenue_raw` received in Stripe. */
  in_stripe_raw: string
  /** #4959: the day's sales by product, for the products `by_product` names. */
  by_product: Array<{ product_id: string; amount_raw: string }>
  /** The day's sales of the products folded into `by_product_other`. */
  other_products_raw: string
}

export interface SummaryResult {
  revenue_raw: string
  /** #4981: the part of `revenue_raw` received in the Haven account. */
  revenue_in_account_raw: string
  sales: number
  average_sale_raw: string
  without_product: { count: number; amount_raw: string }
  own_moves: { count: number; amount_raw: string }
  by_product: Array<{ product_id: string; label: string; sales: number; amount_raw: string }>
  by_product_other: { products: number; sales: number; amount_raw: string }
  by_payer: Array<{ payer: PayerView; payments: number; amount_raw: string; last_paid_at: string }>
  by_payer_other: { payers: number; payments: number; amount_raw: string }
  unattributed: { payments: number; amount_raw: string }
  by_day: SummaryByDay[]
  /** #4952: sales received at a registered Stripe deposit address: the Stripe part of `revenue_raw` (#4981), under the same filters. */
  received_in_stripe: { count: number; amount_raw: string }
  /** #4963: today's USDC rate per display currency; null when unread (and in the Sales-off answer). */
  usdc_rates: FiatValues | null
}

export async function readSalesSummaryForOwner(
  scope: SalesScope,
  period: PeriodBounds,
  filterInput: SalesFilterInput = {},
): Promise<SummaryResult> {
  const filters = await resolveSalesFilters(scope, period, filterInput)
  const [raw, resolve, usdcRates] = await Promise.all([
    readSalesSummary(scope, period, filters),
    buildPayerResolver(scope.userId, scope.chainId),
    readUsdcRates(scope.chainId),
  ])
  const labels = await labelProducts(
    scope.accountId,
    raw.by_product.map((p) => ({ productId: p.product_id, recordName: p.record_name })),
  )
  const sales = Number(raw.tiles.sales)
  const payments = sales + Number(raw.tiles.without_product_count)
  return {
    revenue_raw: raw.tiles.revenue_raw,
    revenue_in_account_raw: raw.tiles.revenue_in_account_raw,
    sales,
    // #4981: the average is the total over EVERY payment counted, sales and
    // without-product alike, wherever the money landed; rounded down.
    average_sale_raw: payments === 0 ? ZERO : (BigInt(raw.tiles.revenue_raw) / BigInt(payments)).toString(),
    without_product: {
      count: Number(raw.tiles.without_product_count),
      amount_raw: raw.tiles.without_product_raw,
    },
    own_moves: { count: Number(raw.tiles.own_moves_count), amount_raw: raw.tiles.own_moves_raw },
    by_product: raw.by_product.map((p) => ({
      product_id: p.product_id,
      label: labels.get(p.product_id) ?? p.product_id,
      sales: Number(p.sales),
      amount_raw: p.amount_raw,
    })),
    by_product_other: {
      products: Number(raw.by_product_other.products),
      sales: Number(raw.by_product_other.sales),
      amount_raw: raw.by_product_other.amount_raw,
    },
    by_payer: raw.by_payer.map((p) => ({
      payer: payerView(resolve, p.payer) as PayerView,
      payments: Number(p.payments),
      amount_raw: p.amount_raw,
      last_paid_at: new Date(p.last_paid_at).toISOString(),
    })),
    by_payer_other: {
      payers: Number(raw.by_payer_other.payers),
      payments: Number(raw.by_payer_other.payments),
      amount_raw: raw.by_payer_other.amount_raw,
    },
    unattributed: {
      payments: Number(raw.unattributed.payments),
      amount_raw: raw.unattributed.amount_raw,
    },
    by_day: raw.by_day.map((d) => ({
      day: d.day,
      payments: Number(d.payments),
      sales: Number(d.sales),
      revenue_raw: d.revenue_raw,
      without_product_raw: d.without_product_raw,
      in_stripe_raw: d.in_stripe_raw,
      by_product: d.by_product,
      other_products_raw: d.other_products_raw,
    })),
    received_in_stripe: {
      count: Number(raw.received_in_stripe.count),
      amount_raw: raw.received_in_stripe.amount_raw,
    },
    usdc_rates: usdcRates,
  }
}

export interface PaymentView {
  tx_hash: string
  block_time: string
  kind: PaymentKind
  amount_raw: string
  product_id: string | null
  product_label: string | null
  payer: PayerView | null
  several_payers: boolean
  receipt_number: string | null
  vat_treatment: 'SE_25' | 'REVERSE_CHARGE' | null
  held_by: 'account' | 'stripe'
  /** The registered deposit address a Stripe-held sale was received at; null for an account payment. */
  receiving_address: string | null
}

function paymentView(row: PaymentRow, resolve: PayerResolver, labels: Map<string, string>): PaymentView {
  return {
    tx_hash: row.tx_hash,
    block_time: new Date(row.block_time).toISOString(),
    kind: row.kind,
    amount_raw: row.amount_raw,
    product_id: row.product_id,
    product_label: row.product_id === null ? null : (labels.get(row.product_id) ?? row.product_id),
    payer: row.several_payers ? null : payerView(resolve, row.payer),
    several_payers: row.several_payers,
    receipt_number: row.receipt_number,
    vat_treatment: row.vat_treatment,
    held_by: row.held_by,
    receiving_address: row.receiving_address,
  }
}

export interface PaymentsPage {
  payments: PaymentView[]
  next_cursor: string | null
  /** #4959: how many payments the filter set has in the period, every page included. */
  total: number
  /** #4963: today's USDC rate per display currency; null when unread (and in the Sales-off answer). */
  usdc_rates: FiatValues | null
}

export async function readPaymentsPage(
  scope: SalesScope,
  period: PeriodBounds,
  options: { limit: number; cursor: PaymentsCursor | null },
  filterInput: SalesFilterInput = {},
): Promise<PaymentsPage> {
  const filters = await resolveSalesFilters(scope, period, filterInput)
  const [fetched, total, resolve, usdcRates] = await Promise.all([
    listPayments(scope, period, options, filters),
    countPayments(scope, period, filters),
    buildPayerResolver(scope.userId, scope.chainId),
    readUsdcRates(scope.chainId),
  ])
  const hasMore = fetched.length > options.limit
  const rows = hasMore ? fetched.slice(0, options.limit) : fetched
  const labels = await labelProducts(
    scope.accountId,
    rows.flatMap((r) => (r.product_id === null ? [] : [{ productId: r.product_id, recordName: r.product_name }])),
  )
  const last = rows[rows.length - 1]
  return {
    payments: rows.map((r) => paymentView(r, resolve, labels)),
    next_cursor: hasMore && last ? encodePaymentsCursor(last) : null,
    total,
    usdc_rates: usdcRates,
  }
}

export interface PaymentDetailView extends PaymentView {
  merchant_reference: string | null
  legs: Array<{ log_index: number | null; payer: PayerView; amount_raw: string }>
  /** #4963: today's USDC rate per display currency; null when unread. */
  usdc_rates: FiatValues | null
}

function stripeSaleLegs(row: PaymentRow): PaymentLegRow[] {
  if (row.payer === null || row.several_payers) return []
  return [{ log_index: null, payer_address: row.payer, amount_raw: row.amount_raw, token_address: '' }]
}

/** One payment with its transfer legs, or null when the account has no such payment. */
export async function readPaymentDetail(
  scope: SalesScope,
  txHash: string,
): Promise<PaymentDetailView | null> {
  const row = await findPayment(scope, txHash)
  if (row === null) return null
  // A Stripe-held sale has no indexed transfers: its chain facts are the sale
  // row's (#4952), shown as the one leg the sale was read from.
  const [legs, resolve, usdcRates] = await Promise.all([
    row.held_by === 'stripe'
      ? Promise.resolve(stripeSaleLegs(row))
      : listPaymentLegs(scope, txHash),
    buildPayerResolver(scope.userId, scope.chainId),
    readUsdcRates(scope.chainId),
  ])
  const labels = await labelProducts(
    scope.accountId,
    row.product_id === null ? [] : [{ productId: row.product_id, recordName: row.product_name }],
  )
  return {
    ...paymentView(row, resolve, labels),
    merchant_reference: row.merchant_reference,
    legs: legs.map((l) => ({
      log_index: l.log_index,
      payer: payerView(resolve, l.payer_address) as PayerView,
      amount_raw: l.amount_raw,
    })),
    usdc_rates: usdcRates,
  }
}

/** Clear the sale record of one transaction. True when a record was deleted. */
export async function clearSaleRecord(scope: SalesScope, txHash: string): Promise<boolean> {
  return deleteMerchantSale(scope, txHash)
}
