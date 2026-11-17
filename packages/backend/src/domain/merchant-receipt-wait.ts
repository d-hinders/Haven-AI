/**
 * The merchant-receipt wait (#4876, owner decision 1 of 2026-11-17 on #4874).
 *
 * An x402 payment's merchant receipt — the document whose product lines and
 * VAT the accounting document shows — reaches Haven seconds AFTER the payment
 * settles: the SDK posts it right after the settlement evidence
 * (`packages/sdk/src/merchant-completion.ts`). A pushed supplier invoice is
 * never edited (#3767 decision 2), so the accounting feed holds an x402
 * payment that has no receipt yet for this window, and then sends it ONCE —
 * with the lines when the receipt arrived, with "VAT not stated by the
 * merchant" when it did not. A receipt arriving inside the window triggers the
 * feed itself (`modules/mpp/merchant-receipt.ts`); one that never arrives is
 * fed by the retry sweep once the window has passed.
 *
 * A DOMAIN LEAF like `merchant-report-grace.ts`: the feed's deferral and the
 * sweep's selection read the same value, so they cannot drift apart.
 */

/** Minutes an x402 payment with no merchant receipt waits before it is fed. */
export const MERCHANT_RECEIPT_WAIT_MIN = 2

/**
 * How far back the retry sweep takes a payment the receipt wait held (#4876).
 * The wait's own window is minutes; a row still unfed days later is one the
 * feed keeps declining for a reason the sweep's query does not mirror, and
 * re-selecting it every tick would spend the sweep's batch on it. Older
 * payments are fed by Sync now or the backfill.
 */
export const MERCHANT_RECEIPT_SWEEP_HORIZON_DAYS = 7

/** True once the receipt wait has passed for a payment settled at `settledAt`. */
export function merchantReceiptWaitElapsed(settledAt: string, now: number = Date.now()): boolean {
  const settled = new Date(settledAt).getTime()
  // An unreadable timestamp must not hold a payment forever: treat it as passed.
  if (!Number.isFinite(settled)) return true
  return now - settled >= MERCHANT_RECEIPT_WAIT_MIN * 60_000
}
