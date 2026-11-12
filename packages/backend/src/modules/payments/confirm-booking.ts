/**
 * The ONE booking a confirmed payment gets (#4819, slice 3 of epic #4816).
 *
 * ## Why this exists
 *
 * A payment can be confirmed by two writers: the sign route, when its submit
 * returns a receipt, and the submission reconciler, when the bundler's receipt
 * index later answers for a UserOp whose answer was lost. Before this slice the
 * route booked the full record — the three fiat values in the confirm write,
 * the machine-payment evidence, the accounting underlag and the first-payment
 * event — while the reconciler's confirm set `status`, `tx_hash` and
 * `confirmed_at` only and emitted the funnel event alone. A payment the
 * reconciler confirmed therefore had null fiat values, no evidence row, no
 * underlag (the feed's candidate SQL requires one fiat value) and kept
 * `submission_outcome: 'unknown'` on a CONFIRMED row.
 *
 * The rule the epic states is "booked by one function whichever path confirms
 * it". This is that function. Both writers call it; neither owns a second copy
 * of the sequence.
 *
 * ## The sequence, and why the order is the contract
 *
 * 1. Price the payment (`getFiatValuesForTokenAmount`). A price-source failure
 *    yields nulls — it never fails the booking, because the funds already
 *    moved. No later pass completes them (out of scope for this slice).
 * 2. Confirm the row with the fiat triple in the SAME write. The write is a
 *    compare-and-set on `status = 'submitted' AND tx_hash IS NULL`, so exactly
 *    one of the two writers wins and the loser books nothing.
 * 3. Only the winner runs the side effects: the evidence hook (awaited, and
 *    swallowing by its own contract), the accounting feed (fire-and-forget)
 *    and the first-payment event.
 *
 * Step 3 is inside the `if (confirmed)` on purpose. A loser that still fired
 * the feed would push a second underlag for one payment; a loser that still
 * emitted the funnel event would double-count the user's first payment.
 *
 * ## What stays different by design
 *
 * The sponsored-gas row is written on the SUBMIT seam, not here (#3837), so a
 * reconciled payment keeps its `receipt_unconfirmed` cost-NULL row — the
 * reconciler reads a receipt shape that carries no gas cost, and widening that
 * is a deliberate non-goal (`docs/operations/sponsored-gas.md`).
 *
 * ## The evidence hook is an argument, not an import
 *
 * The hook lives in the mpp module, whose barrel re-exports `sweep.ts` and
 * `budget-precheck.ts`; both import the payments barrel, so a payments module
 * importing the mpp barrel closes a payments → mpp → payments cycle that
 * `no-circular` refuses. The sign route already hands the hook in for exactly
 * this reason (#4761); the reconciler's caller does the same.
 */
import { getFiatValuesForTokenAmount } from '../../infra/fiat-values.js'
import { confirmSubmittedIntent } from '../../infra/repositories/payment-intents.js'
import { emitFirstPaymentSettled } from '../../infra/repositories/onboarding-funnel.js'
import { feedSettledPaymentBestEffort } from '../accounting/index.js'

/**
 * The subset of a Fastify-style logger the booking passes to the evidence
 * hook. Structural, and identical to the mpp module's `EvidenceLogger`, so
 * both callers' loggers fit without a cast.
 */
export interface ConfirmBookingLogger {
  warn: (payload: Record<string, unknown>, message: string) => void
}

/**
 * The machine-payment evidence hook. Generic in the logger so each caller
 * keeps its own logger type: the sign route's `SignPaymentLog` and the
 * reconciler's `ReconcileLogger` are structurally different, and neither
 * should be widened to satisfy the other.
 */
export type ConfirmBookingEvidenceHook<L> = (
  intentId: string,
  agentId: string,
  log: L,
) => Promise<unknown>

export interface ConfirmBookingInput<L> {
  intentId: string
  /** The transaction hash the confirming writer observed. */
  txHash: string
  agentId: string
  /** The payment's owner — the accounting feed is scoped to them. */
  userId: string
  /** The intent's own token and amount, for the fiat capture. */
  tokenSymbol: string
  amountHuman: string
  log: L
  recordEvidence: ConfirmBookingEvidenceHook<L>
}

/**
 * Book a confirmed payment: fiat values, evidence, accounting feed and the
 * first-payment event, in that order.
 *
 * Returns `true` when THIS call won the confirm compare-and-set and ran the
 * side effects, `false` when another writer had already confirmed the row —
 * in which case nothing was written and nothing was emitted.
 */
export async function bookConfirmedPayment<L>(input: ConfirmBookingInput<L>): Promise<boolean> {
  const fiatValues = await getFiatValuesForTokenAmount(input.tokenSymbol, input.amountHuman)

  const confirmed = await confirmSubmittedIntent({
    txHash: input.txHash,
    intentId: input.intentId,
    usdValue: fiatValues.usd,
    eurValue: fiatValues.eur,
    sekValue: fiatValues.sek,
    agentId: input.agentId,
  })

  if (!confirmed) return false

  await input.recordEvidence(input.intentId, input.agentId, input.log)
  // #4533: the evidence hook is a no-op for a direct payment (the rail gate
  // refuses it), so the underlag is fed from here instead. The entry is built
  // from `payment_intents` itself; the outside-address filter lives in that
  // SQL, so an internal transfer is simply not fed. Fire-and-forget:
  // settlement never waits on an accounting push.
  feedSettledPaymentBestEffort(input.userId, input.intentId)
  emitFirstPaymentSettled(input.intentId)

  return true
}
