/** Tiny fixed-width table for human output. Scriptable callers use `--json`. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  )
  const line = (cells: string[]) =>
    cells.map((c, i) => (c ?? '').padEnd(widths[i])).join('  ').trimEnd()
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n')
}

export function truncateAddress(address: string): string {
  if (!address || address.length <= 12) return address
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

const CHAIN_NAMES: Record<number, string> = { 100: 'Gnosis', 8453: 'Base' }

export function chainName(chainId: number): string {
  return CHAIN_NAMES[chainId] ?? `chain ${chainId}`
}

/**
 * "5m ago", "2h ago", "3d ago" — the ladder the dashboard's stale-balance
 * indicator renders (`packages/frontend/src/components/haven/
 * BalanceFreshnessIndicator.tsx`), lifted for the CLI so both surfaces word
 * the same wire marker the same way. Just-now keeps both boundaries the
 * frontend's helper keeps: a clock slightly ahead of the read, and reads
 * younger than a minute.
 */
export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return 'just now'
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(days / 365)}y ago`
}
