/**
 * Canonical money display (#853, epic #859).
 *
 * Encodes the "money is calm" rule structurally instead of by convention:
 * amounts render in neutral ink, incoming gains the quiet `--v2-success`,
 * and `--v2-danger` is reserved for failed transactions. Direction colour
 * for outgoing money lives in `DirectionMark`, never on the number itself —
 * callers pass facts (`direction`, `failed`), not colours.
 *
 * The value arrives pre-formatted and unsigned; the sign comes from
 * `direction` so a `+`/`-` can never disagree with the tone.
 */

const SIZE_CLASS = {
  sm: 'text-sm',
  lg: 'text-2xl',
} as const

export type AmountDirection = 'in' | 'out'

export function Amount({
  value,
  symbol,
  direction,
  failed = false,
  size = 'sm',
  className = '',
}: {
  /** Formatted, unsigned numeric string (e.g. "250.00") — callers own formatting. */
  value: string
  /** Token symbol appended after the value (e.g. "USDC"). */
  symbol?: string
  /**
   * Adds the leading +/− and drives tone (`in` → success). Omit for signless
   * figures such as budgets and balances.
   */
  direction?: AmountDirection
  /** Failed transactions render danger — the only red money ever gets. */
  failed?: boolean
  /** `sm` for rows and tables (default); `lg` for detail-panel headlines. */
  size?: keyof typeof SIZE_CLASS
  className?: string
}) {
  const tone = failed
    ? 'text-[var(--v2-danger)]'
    : direction === 'in'
      ? 'text-[var(--v2-success)]'
      : 'text-[var(--v2-ink)]'
  const sign = direction === 'in' ? '+' : direction === 'out' ? '-' : ''
  return (
    <span className={`v2-tabular font-semibold ${SIZE_CLASS[size]} ${tone} ${className}`.trim()}>
      {sign}
      {value}
      {symbol ? ` ${symbol}` : ''}
    </span>
  )
}
