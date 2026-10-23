/**
 * The ONE rule for the "≈" mark on a money figure (#4165, owner decision
 * 2026-10-20 on epic #4093: "it is over complicating things").
 *
 * "≈" says a figure was converted at today's rate AND that the conversion
 * changed the number. It is decided here, once, for every surface — the
 * frontend's transaction rows, detail panel, totals hooks and budget caption,
 * and the backend's dashboard spend windows — so no caller re-derives it:
 *
 * - **A list row never carries it** (#3950, owner decision 2026-10-14). The
 *   detail panel is where a payment is verified; the row stays plain.
 * - **A booked figure never carries it.** A book-time `convertedAmount` is the
 *   value struck when the payment happened, not an estimate.
 * - **A token shown in the currency it is pegged to never carries it.** USDC
 *   shown in USD is dollars; the peg is a registry FACT
 *   (`CoreTokenConfig.pegged`), never a guess from the symbol string.
 * - Otherwise — a figure priced at today's rate, in another currency (kr, €)
 *   or for a token that floats — totals and the detail panel carry it.
 *
 * An unknown chain or token is not pegged, so it keeps the mark: the safe
 * answer for a figure Haven cannot vouch for.
 */

import { tokenPeg } from './chains.js'

/** Where the figure renders: a list row, a total, or the detail panel. */
export type ApproxMarkKind = 'row' | 'total' | 'detail'

export interface ApproxMarkInput {
  /** True when the figure was priced at today's rate rather than booked. */
  repriced: boolean
  /** The token's chain; null/undefined when the caller does not know it. */
  chainId: number | null | undefined
  /** The token's registry symbol, e.g. `USDC`. */
  tokenSymbol: string | null | undefined
  /** The fiat currency the figure is shown in. */
  displayCurrency: 'SEK' | 'USD' | 'EUR'
  kind: ApproxMarkKind
}

export function shouldMarkApprox(input: ApproxMarkInput): boolean {
  if (input.kind === 'row') return false
  if (!input.repriced) return false
  return tokenPeg(input.chainId, input.tokenSymbol) !== input.displayCurrency
}
