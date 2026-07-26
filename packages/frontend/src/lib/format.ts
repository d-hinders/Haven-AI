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
