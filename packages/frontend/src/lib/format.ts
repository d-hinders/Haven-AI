/**
 * Shared formatting helpers. Extracted from many components that each had
 * their own inline copy of these — any divergence between them was a bug.
 */

/**
 * "17 May 2026" — the ONE long-date rule (en-GB, day month year, #4166).
 * The app's dates were rendered in two voices — `passkeyLabels` said
 * "October 16, 2026" (en-US) while the account page said "16 October 2026"
 * (en-GB) for the same instant. en-GB is the app's dominant voice
 * (`CompanyDetailsCard`, sub-budget, analytics), so it is the rule here, and
 * both surfaces read it.
 */
export function formatLongDate(date: string | Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(typeof date === 'string' ? new Date(date) : date)
}

/** ISO string, Date or epoch milliseconds -> Date. */
function toDate(date: string | Date | number): Date {
  return typeof date === 'string' ? new Date(date) : typeof date === 'number' ? new Date(date) : date
}

/**
 * "31 Oct 2026, 14:05" — the ONE absolute date-and-time rule (#4573).
 *
 * Twelve call sites rendered `toLocaleString()` with no locale argument, so
 * the same instant read differently on a device set to en-US ("10/31/2026,
 * 2:05:00 PM") than on the en-GB voice the rest of the app uses. Most were
 * `title` tooltips on the analytics tables, where the tooltip is the only
 * route to the exact instant — a tooltip that disagrees with the row beside
 * it is worse than no tooltip.
 *
 * en-GB, medium date, short time: the date is unambiguous (no 10/11 vs 11/10)
 * and the seconds are dropped, because a tooltip is read, not compared.
 */
export function formatDateTime(date: string | Date | number): string {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(
    toDate(date),
  )
}

/**
 * "14:05:09" — the ONE time-of-day rule (#4573), for a stamp whose date is
 * already on screen (the accounting page's "Checked …" line).
 */
export function formatTimeOfDay(date: string | Date | number): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(toDate(date))
}

/**
 * "31 Oct, 14:05" — the ONE short date-and-time rule (#4573), for a stamp
 * inside a sentence where the year is noise (the connect-agent expiry line).
 */
export function formatShortDateTime(date: string | Date | number): string {
  return new Intl.DateTimeFormat('en-GB', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(toDate(date))
}

/**
 * `YYYY-MM-DD` of an ISO instant in a zone — the ONE day-key rule (#4573).
 *
 * `tz` is optional: omitted, the key is the runtime zone's day, which is what
 * the ledger's day bands and the dashboard's Activity groups bucket by. The
 * analytics page passes the range's zone, because its `by_day` buckets are the
 * endpoint's (`infra/repositories/analytics.ts`), not the browser's.
 *
 * en-CA is the ISO-shaped locale: `format` yields `YYYY-MM-DD` directly.
 */
export function dayKeyInZone(iso: string, tz?: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso))
}

/**
 * True when the instant is not midnight in the zone — a window boundary that
 * cuts its day. The ONE rule (#4573): the dashboard's Activity window and the
 * analytics range edges ask the same question, and the analytics one takes the
 * range's zone.
 */
export function cutsItsDay(iso: string, tz?: string): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  return !(get('hour') === '00' && get('minute') === '00' && get('second') === '00')
}

/**
 * `0x1234…abcd` — the ONE address truncation rule (6 + ellipsis + 4).
 * Render addresses through `<Address>` (components/haven) where possible;
 * this is the underlying rule for plain-string contexts (#853).
 */
export function truncate(addr: string): string {
  if (!addr) return ''
  if (addr.length <= 10) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

/**
 * Address format check. Re-exported from `@haven_ai/core` so the dashboard and
 * the backend share one definition — this used to be a private inline copy of
 * the 40-hex regex, one of three in this package (#983).
 *
 * NOTE: deliberately not viem's `isAddress`, which validates the EIP-55
 * checksum and so rejects the all-lowercase addresses users paste.
 */
export { isAddress as isValidAddress } from '@haven_ai/core'

/**
 * The ONE fiat formatter, shared by the dashboard, /accounts and
 * /accounts/[id] (#3127 review, finding 6). Each surface used to carry its
 * own inline copy of the currency ternary, and the copies drifted: /accounts
 * rendered `kr13,000.50` while the dashboard one click away rendered
 * `13 000,50 kr` for the same figure. One formatter, one output per currency.
 *
 * Locale per currency — the currency's own voice, the same rule that puts
 * EUR in de-DE:
 *  - USD → en-US, symbol prefix: `$1,234.56`
 *  - EUR → de-DE, symbol suffix: `1.100,00 €`
 *  - SEK → sv-SE, symbol suffix: `13 000,50 kr` (sv-SE styles `currency`
 *    without `currencyDisplay: 'name'` as a suffix `kr`, NBSP-separated)
 */
export function currencyLocale(currency: 'USD' | 'EUR' | 'SEK'): string {
  return currency === 'EUR' ? 'de-DE' : currency === 'SEK' ? 'sv-SE' : 'en-US'
}

export function formatFiat(value: number, currency: 'USD' | 'EUR' | 'SEK'): string {
  return new Intl.NumberFormat(currencyLocale(currency), {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

/**
 * Below this magnitude a non-zero figure would round to `0.00` (#3897).
 * `|value| < SUB_CENT_THRESHOLD` is the ONE sub-cent test: the display helper
 * below and the dashboard summary's count form both key on it.
 */
export const SUB_CENT_THRESHOLD = 0.005

/** True for a non-zero figure that `formatFiat` would print as `0.00`. */
export function isSubCent(value: number): boolean {
  return value !== 0 && Math.abs(value) < SUB_CENT_THRESHOLD
}

/**
 * `formatFiat` for DISPLAY (owner decision 2026-10-22 on the transactions
 * epic, superseding #3897's "<$0.01"): a non-zero figure under a cent
 * (`isSubCent`) renders with EXACTLY 4 decimals in the currency's own format
 * ("$0.0010", "0,0049 kr", "0,0010 €"), and one that would still show
 * `0.0000` (`|value| < 0.00005`) renders "<$0.0001" ("<0,0001 kr",
 * "<0,0001 €"). Zero stays `$0.00`; everything else is `formatFiat`'s output
 * unchanged. A negative sub-cent figure keeps its sign in the locale's minus
 * glyph ("-$0.0010", "\u2212<0,0001 kr"); callers that sign by direction
 * (`Amount`) pass the magnitude.
 *
 * Deliberately NOT folded into `formatFiat`: that one also drives the
 * balance count-up, the "since yesterday" line and /accounts, which keep
 * plain 2-decimal rounding.
 */
export function formatFiatDisplay(value: number, currency: 'USD' | 'EUR' | 'SEK'): string {
  if (!isSubCent(value)) return formatFiat(value, currency)
  // The locale's own minus glyph (U+2212 in sv-SE, '-' in en-US and de-DE),
  // so a negative sub-cent figure signs the same way `formatFiat` does.
  const minus =
    new Intl.NumberFormat(currencyLocale(currency))
      .formatToParts(-1)
      .find((part) => part.type === 'minusSign')?.value ?? '-'
  const sign = value < 0 ? minus : ''
  const abs = Math.abs(value)
  // Still rounds to 0.0000 at 4 decimals: say "<" instead, against the
  // smallest figure the format can show. The sign still comes from the input.
  if (abs < SUB_CENT_DISPLAY_FLOOR) return `${sign}<${fiatOf(0.0001, currency, 4)}`
  return `${sign}${fiatOf(abs, currency, 4)}`
}

/** Below this magnitude a sub-cent figure would still show 0.0000 at 4 decimals. */
const SUB_CENT_DISPLAY_FLOOR = 0.00005

/** `formatFiat`'s Intl setup at an explicit fraction-digit count. */
function fiatOf(value: number, currency: 'USD' | 'EUR' | 'SEK', fractionDigits: number): string {
  return new Intl.NumberFormat(currencyLocale(currency), {
    style: 'currency',
    currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value)
}

/**
 * Humanised "x minutes ago" relative time. For the absolute value, pair
 * the result with `title={formatDateTime(iso)}` on the element.
 *
 * Accepts: ISO string, Date, or number (milliseconds since epoch).
 */
export function timeAgo(date: string | Date | number): string {
  const ms =
    typeof date === 'string'
      ? new Date(date).getTime()
      : typeof date === 'number'
        ? date
        : date.getTime()
  const diff = Date.now() - ms
  if (diff < 0) return 'just now'
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  const years = Math.floor(days / 365)
  return `${years}y ago`
}

/**
 * Remaining duration until a future ISO date, e.g. "2h 15m" or "expired".
 */
export function timeUntil(date: string | Date | number): string {
  const ms =
    typeof date === 'string'
      ? new Date(date).getTime()
      : typeof date === 'number'
        ? date
        : date.getTime()
  const diff = ms - Date.now()
  if (diff <= 0) return 'expired'
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  return `${hours}h ${mins % 60}m`
}
