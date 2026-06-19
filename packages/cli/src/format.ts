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
