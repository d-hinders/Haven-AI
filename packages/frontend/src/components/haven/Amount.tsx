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
 *
 * ## Currency mode (#3805)
 *
 * The token mode above formats nothing — the caller owns the string. The
 * currency mode is the other half of the contract: for a figure that is
 * ALREADY a fiat valuation server-side (book-time `convertedAmount`, or
 * #3824's `approxAmount`), the caller passes the unsigned magnitude and the
 * currency it is denominated in, and the component formats through
 * `formatFiatDisplay` (`lib/format.ts`: `formatFiat`, plus exactly 4 decimals
 * for a non-zero figure under a cent — "<$0.0001" when even that would show
 * 0.0000; owner decision 2026-10-22, superseding #3897's "<$0.01") — the one
 * formatter, so a SEK figure on one screen cannot disagree with the same
 * figure on the next. It never converts
 * and never fetches a rate: the sign comes only from `direction` (a negative
 * input magnitude cannot double-sign it), `symbol` is not allowed, and the
 * per-currency locale is the same `currencyLocale` rule everywhere.
 *
 * A currency figure is a VALUATION of a token amount, not a fiat balance
 * Haven holds — the budget's own token where a budget is set, the user's
 * currency everywhere else (owner decision 2026-10-09). `≈` marks a figure
 * converted at today's rate rather than booked: it goes before the sign, and
 * it is the only new element the mode adds. The component never decides it:
 * callers pass `approx` from the one rule, `shouldMarkApprox` in
 * `@haven_ai/core` (#4165) — never on a list row, never for USDC in USD.
 *
 * Unknown is its own state: `null` (or a non-finite value) renders an em
 * dash in secondary ink — never `0,00 kr`, which would state a valuation
 * where none exists. Existing token-mode callers turned unknown into zero;
 * this mode must not.
 */

import { formatFiatDisplay } from '@/lib/format'
import type { ReactNode } from 'react'

const SIZE_CLASS = {
  sm: 'text-sm',
  md: 'text-xl',
  lg: 'text-2xl',
} as const

export type AmountDirection = 'in' | 'out'

/** The currencies `formatFiat` speaks; the value is already IN this currency. */
export type AmountCurrency = 'SEK' | 'USD' | 'EUR'

interface TokenAmountProps {
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
  /**
   * `sm` for rows and tables (default); `md` (20px) for a secondary figure
   * beside a headline, such as Last 30 days (#4259); `lg` for detail-panel
   * headlines. The size is on this span, so a wrapper's `text-*` never
   * resizes the figure — pick it here, not with `className`.
   */
  size?: keyof typeof SIZE_CLASS
  className?: string
}

interface CurrencyAmountProps {
  /**
   * Unsigned magnitude, already converted server-side (book-time
   * `convertedAmount`, or #3824's `approxAmount`). `null` — or any non-finite
   * value — renders `—` in secondary ink: an unknown valuation is not zero.
   */
  amount: number | null
  /** The currency the value is already in, e.g. `convertedCurrency`. Never read from preferences inside the component. */
  currency: AmountCurrency
  /** `≈` before the sign — pass `shouldMarkApprox`'s answer, never a raw provenance flag (#4165). */
  approx?: boolean
  direction?: AmountDirection
  failed?: boolean
  size?: keyof typeof SIZE_CLASS
  className?: string
}

export type AmountProps = TokenAmountProps | CurrencyAmountProps

export function Amount(props: AmountProps) {
  const { direction, failed = false, size = 'sm', className = '' } = props
  let tone = failed
    ? 'text-[var(--v2-danger)]'
    : direction === 'in'
      ? 'text-[var(--v2-success)]'
      : 'text-[var(--v2-ink)]'
  const sign = direction === 'in' ? '+' : direction === 'out' ? '-' : ''

  let body: string
  let approxMark: ReactNode = null
  let unknown = false
  if ('amount' in props) {
    if (props.amount === null || !Number.isFinite(props.amount)) {
      // Unknown is its own quiet state — secondary ink, no sign, never zero.
      body = '\u2014'
      tone = 'text-[var(--v2-ink-3)]'
      unknown = true
    } else {
      // The sign comes only from `direction`, so a negative magnitude is
      // formatted through its absolute value: no double sign. A non-zero
      // figure under a cent reads 4 decimals, "<$0.0001" below 0.00005 —
      // never "$0.00" (owner decision 2026-10-22, superseding #3897).
      body = formatFiatDisplay(Math.abs(props.amount), props.currency)
      if (props.approx) {
        approxMark = (
          <span title="Converted at today's rate">{'\u2248 '}</span>
        )
      }
    }
  } else {
    body = props.symbol ? `${props.value} ${props.symbol}` : props.value
  }

  return (
    // #4400: a money figure never wraps, whatever its container — the rule
    // lives here, not in each caller's cell; the layout gives the figure room.
    <span className={`v2-tabular whitespace-nowrap font-semibold ${SIZE_CLASS[size]} ${tone} ${className}`.trim()}>
      {approxMark}
      {unknown ? null : sign}
      {body}
    </span>
  )
}
