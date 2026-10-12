/**
 * Shared formatting helpers. Extracted from many components that each had
 * their own inline copy of these — any divergence between them was a bug.
 */

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
 * `formatFiat` for DISPLAY (#3897, owner decision 2026-10-12): a non-zero
 * figure under a cent renders "<$0.01" ("<0,01 kr", "<0,01 €") instead of a
 * `0.00` that states nothing was spent. Zero stays `$0.00`; everything else
 * is `formatFiat`'s output unchanged. A negative sub-cent figure keeps its
 * sign ("-<$0.01"); callers that sign by direction pass the magnitude.
 *
 * Deliberately NOT folded into `formatFiat`: that one also drives the
 * balance count-up (which would flash "<$0.01" while counting from 0), the
 * "since yesterday" line and /accounts, which keep plain rounding.
 */
export function formatFiatDisplay(value: number, currency: 'USD' | 'EUR' | 'SEK'): string {
  if (!isSubCent(value)) return formatFiat(value, currency)
  return `${value < 0 ? '-' : ''}<${formatFiat(0.01, currency)}`
}

/**
 * Humanised "x minutes ago" relative time. For the absolute value, pair
 * the result with `title={new Date(iso).toLocaleString()}` on the element.
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
