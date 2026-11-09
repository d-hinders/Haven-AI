/**
 * The first-agent-payment card's rules (#4707, epic #4701).
 *
 * Three decisions live here, each with its own reason, so the card component
 * stays a rendering of them:
 *
 * 1. **The amount.** The card names a real payment, so it must never print a
 *    figure that is not the payment's. A sub-cent payment rendered through
 *    `formatFiat` reads `$0.00` — the #3897 rule 3 failure — so a sub-cent (or
 *    unbooked) fiat figure falls back to the TOKEN amount, which is the fact
 *    the row actually carries. The fiat currency is the viewer's preference,
 *    the same rule the Activity row beneath the card follows.
 * 2. **The time.** "just now" comes from the row's own `confirmedAt`, never
 *    from when the card happened to mount. A payment older than the window
 *    says its date, so a card that stayed undismissed for weeks does not claim
 *    the payment just happened.
 * 3. **The Peak.** Once per device, per user, in browser storage — the same
 *    posture as the dismissal key it shares a card with (owner decision 2 on
 *    #4701: "once" is per device). It plays even when the payment happened
 *    while the owner was away, but never for a payment more than seven days
 *    old (owner decision 1): an existing owner who never dismissed the old
 *    line is not met with a celebration of something months old.
 *
 * Unreadable storage reads as "already played": Peak is the stronger claim, so
 * a device that cannot remember says the weaker one (the `lib/first-money.ts`
 * posture).
 */

import { formatFiatDisplay, formatLongDate, isSubCent } from '@/lib/format'

/** How recent a payment must be for the card to say "just now". */
export const FIRST_AGENT_PAYMENT_JUST_NOW_MS = 60 * 60 * 1000

/** Owner decision 1 (#4701): no Peak for a first payment older than this. */
export const FIRST_AGENT_PAYMENT_PEAK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

const PEAK_PREFIX = 'haven-first-agent-payment-peak:'

export type FirstAgentPaymentCurrency = 'USD' | 'EUR' | 'SEK'

/** The fields the amount rule reads — a subset of the wire shape. */
export interface FirstAgentPaymentAmountInput {
  amountHuman: string
  tokenSymbol: string
  usdValue: number | null
  eurValue: number | null
  sekValue: number | null
}

/**
 * The card's figure: the booked fiat in the viewer's currency, or the token
 * amount when that fiat would read `0.00` (or was never booked).
 *
 * `formatFiatDisplay` is deliberately NOT used for the sub-cent case: it would
 * print four decimals (`$0.0010`), and the issue's rule for this card is the
 * token amount — the figure the payment row itself carries.
 */
export function firstAgentPaymentAmount(
  payment: FirstAgentPaymentAmountInput,
  currency: FirstAgentPaymentCurrency,
): string {
  const fiat =
    currency === 'EUR'
      ? payment.eurValue
      : currency === 'SEK'
        ? payment.sekValue
        : payment.usdValue
  if (fiat !== null && fiat !== 0 && !isSubCent(fiat)) {
    return formatFiatDisplay(fiat, currency)
  }
  return `${payment.amountHuman} ${payment.tokenSymbol}`
}

/**
 * "just now" for a recent payment, the long date for an older one. An
 * unparseable instant says nothing rather than a wrong date.
 */
export function firstAgentPaymentWhen(confirmedAt: string, now: number = Date.now()): string {
  const ms = new Date(confirmedAt).getTime()
  if (!Number.isFinite(ms)) return ''
  return now - ms < FIRST_AGENT_PAYMENT_JUST_NOW_MS ? 'just now' : formatLongDate(confirmedAt)
}

/** True when this device has already played Peak for this user's first payment. */
export function hasPlayedFirstAgentPaymentPeak(userId: string): boolean {
  if (typeof window === 'undefined') return true
  try {
    return window.localStorage.getItem(`${PEAK_PREFIX}${userId}`) === '1'
  } catch {
    return true
  }
}

/** Record that this device has played Peak for this user's first payment. */
export function markFirstAgentPaymentPeakPlayed(userId: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(`${PEAK_PREFIX}${userId}`, '1')
  } catch {
    // Unwritable storage already reads as "played".
  }
}

/**
 * Whether Peak plays for this row on this device: not played before, and the
 * payment is no more than seven days old.
 *
 * Reduced motion is NOT decided here — `ui/Milestone` owns that, and it
 * withholds the animation class while the moment (and its `role="status"`
 * announcement) still happens.
 */
export function shouldPlayFirstAgentPaymentPeak(input: {
  userId: string
  confirmedAt: string
  now?: number
}): boolean {
  if (hasPlayedFirstAgentPaymentPeak(input.userId)) return false
  const ms = new Date(input.confirmedAt).getTime()
  if (!Number.isFinite(ms)) return false
  return (input.now ?? Date.now()) - ms <= FIRST_AGENT_PAYMENT_PEAK_MAX_AGE_MS
}
