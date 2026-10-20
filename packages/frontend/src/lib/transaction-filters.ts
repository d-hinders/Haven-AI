/**
 * URL ⇄ filter-state helpers for the transaction FilterBar (#4095), shared
 * since #4098 between the transactions page and the account page's Activity
 * tab — the two surfaces whose filters live in the URL.
 *
 * The REQUEST spelling lives in `useTransactionsFeed.transactionFeedQuery`
 * (it adds the request-only `tz` and the paging window); this module owns
 * the URL side: what a shared link carries, and which values a link may
 * carry without landing the feed on a server 400.
 */
import { resolveChainOrNull } from '@/lib/chains'
import type { TransactionFilterState } from '@/types/transactions'

/** The full chain name a Network facet option carries: "Base Chain". */
export function transactionChainName(chainId: number): string {
  return resolveChainOrNull(chainId)?.name ?? `Chain ${chainId}`
}

/** The short chain name the option labels carry: "Base", not "Base Chain". */
export function transactionChainLabel(chainId: number): string {
  const chain = resolveChainOrNull(chainId)
  return chain ? chain.name.replace(/\s+Chain$/, '') : `Chain ${chainId}`
}

/**
 * A Token facet option's label. Native tokens name their chain, so two
 * networks' natives never read as the same asset.
 */
export function transactionTokenLabel(token: {
  symbol: string
  chainId: number
  isNative: boolean
}): string {
  return token.isNative
    ? `Native ${token.symbol} (${transactionChainLabel(token.chainId)})`
    : `${token.symbol} (${transactionChainLabel(token.chainId)})`
}

/** `YYYY-MM-DD` — the custom range's calendar-date shape, as the API takes it. */
const CALENDAR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * A calendar date that EXISTS — the same roundtrip the server's period parser
 * applies (`Date.UTC` clamps `2026-02-31` forward to March 3, so shape alone
 * is not existence).
 */
function isRealCalendarDate(value: string): boolean {
  if (!CALENDAR_DATE_RE.test(value)) return false
  const [year, month, dayOfMonth] = value.split('-').map(Number)
  const asUtc = new Date(Date.UTC(year, month - 1, dayOfMonth))
  return (
    asUtc.getUTCFullYear() === year &&
    asUtc.getUTCMonth() === month - 1 &&
    asUtc.getUTCDate() === dayOfMonth
  )
}

/**
 * Read a custom `from`/`to` pair off the URL, or nothing.
 *
 * Both dates must exist, be well-formed and ordered — the server refuses a
 * lone, non-existent or reversed pair with a 400, and a shared/deployed link
 * must not land the user on a broken feed. Degrading to "no Period filter"
 * keeps the page honest about what it can honour.
 */
function customRangeFromParams(
  fromParam: string | null,
  toParam: string | null,
): { from?: string; to?: string } {
  if (
    fromParam !== null &&
    toParam !== null &&
    isRealCalendarDate(fromParam) &&
    isRealCalendarDate(toParam) &&
    fromParam <= toParam
  ) {
    return { from: fromParam, to: toParam }
  }
  return {}
}

/**
 * Read a filter state off a URL's query — the exact seed the transactions
 * page (#4095) and the account Activity tab (#4098) both start from, so a
 * link reproduces the same filtered feed on either surface.
 *
 * Every dimension is validated the way the server validates it: an unknown
 * direction, a malformed period, a bogus chain id or a broken date pair is
 * dropped rather than sent — a tampered or half-typed link degrades to the
 * filters it can honour instead of a 400 page.
 */
export function parseTransactionFilters(
  params: Pick<URLSearchParams, 'get'>,
): TransactionFilterState {
  const direction = params.get('direction')
  const period = params.get('period')
  const chainId = Number(params.get('chainId'))
  return {
    accountId: params.get('accountId') ?? undefined,
    agentId: params.get('agentId') ?? undefined,
    tokenKey: params.get('tokenKey') ?? undefined,
    direction: direction === 'in' || direction === 'out' ? direction : undefined,
    chainId: Number.isInteger(chainId) && chainId > 0 ? chainId : undefined,
    search: params.get('search') ?? undefined,
    period: period === '7d' || period === '30d' || period === '90d' ? period : undefined,
    ...customRangeFromParams(params.get('from'), params.get('to')),
  }
}

/**
 * Whether any filter dimension is active — the switch the two surfaces use
 * to tell "this account has no history yet" from "these filters match
 * nothing", and to drop the completeness claim while a filter narrows the
 * feed.
 *
 * `accountId` counts on the transactions page, where picking an account IS
 * a filter. The account Activity tab passes a state that never carries one
 * — the page fixes the account — so the fixed account cannot masquerade as
 * a user-applied filter there.
 */
export function hasActiveTransactionFilters(filters: TransactionFilterState): boolean {
  return Boolean(
    filters.accountId ||
      filters.agentId ||
      filters.tokenKey ||
      filters.direction ||
      filters.chainId !== undefined ||
      filters.search?.trim() ||
      filters.period ||
      (filters.from && filters.to),
  )
}
