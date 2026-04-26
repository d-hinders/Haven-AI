/**
 * Shared formatting helpers. Extracted from many components that each had
 * their own inline copy of these — any divergence between them was a bug.
 */

/** `0xabcd…wxyz` — 6 + 4 convention used everywhere in the app. */
export function truncate(addr: string): string {
  if (!addr) return ''
  if (addr.length <= 10) return addr
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`
}

export function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr)
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
