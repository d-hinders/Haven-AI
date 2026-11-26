/**
 * Submission reconciliation (#3564): the leader-gated tick that resolves a
 * direct payment whose UserOp was SENT but whose receipt was never confirmed.
 *
 * ## The gap
 *
 * `POST /payments/:id/sign` submits the sponsored redemption UserOp and waits
 * for its receipt. When the send's answer is lost, or the wait throws — a
 * timeout, a bundler hiccup — the rail raises `SubmittedUserOpFailedError`
 * with outcome `receipt_unconfirmed` (#3564, widened by #4817 to cover the
 * lost send answer): the op MAY have landed, and the funds MAY have moved.
 * The route books such a row outcome-PENDING (`submitted`,
 * `machine_metadata.user_op_hash` recorded, `submission_outcome: 'unknown'`)
 * instead of `failed`, and this tick is what eventually gives the row its
 * true terminal state.
 *
 * #4818 closes the other half of that gap: a sign request that dies between
 * the claim and the route's booking (a deploy, a crash, an abandoned request)
 * used to leave a `submitted` row with no hash that no job selected. The claim
 * now records the operation hash and a `submission_claimed` marker, so such a
 * row is a candidate here too — and the age gate sits above the route's
 * longest wait, so a live request's row is never selected mid-flight.
 *
 * ## Attribution — one path, and it refuses to guess
 *
 * The lookup key is the userOpHash recorded at booking time, read back through
 * the SAME bundler credential the submit went through
 * (`delegationRailBundlerUrl`, the choke point) — the bundler's receipt index
 * is the only ERC-4337 authority for that hash. There is no transfer-shape
 * fallback and no explorer cross-check: a receipt the bundler does not name
 * for this hash is "not known yet", never evidence of anything.
 *
 * `readUserOperationReceipt` maps every failure — RPC error, unknown hash,
 * missing credential — to `not_found_yet`, and the tick treats it exactly
 * that way: the row stays unresolved and the NEXT tick is the retry, which is
 * what keeps a dead bundler from becoming a hot loop or a wrong failure.
 *
 * ## The bounded window
 *
 * An op that never landed would otherwise stay a candidate forever (the
 * bundler keeps answering "no such receipt"). After
 * {@link RECONCILE_MAX_AGE_SECONDS} past `signed_at` with still no receipt,
 * the row is resolved `failed` with that cause — the same verdict the
 * receipt-unconfirmed wait would have reached had it seen a bundler rejection,
 * and the honest terminal answer for a payment whose submission window has
 * closed. Before that bound, "not found yet" is left alone: inclusion can
 * lag the send by minutes.
 *
 * ## Booking — the same function the route uses (#4819)
 *
 * A confirmed receipt runs `bookConfirmedPayment`, the ONE booking the sign
 * route also calls: the fiat triple in the confirm write, the machine-payment
 * evidence hook, the accounting underlag feed and the first-payment event.
 * Before #4819 this tick wrote `status`/`tx_hash`/`confirmed_at` and emitted
 * the funnel event alone, so a reconciled payment had null fiat values, no
 * evidence row, no underlag (the feed's candidate SQL requires one fiat value)
 * and kept `submission_outcome: 'unknown'` on a CONFIRMED row. The shared
 * confirm write resolves that marker.
 *
 * The evidence hook is a caller-supplied dependency (`recordEvidence`), not an
 * import: it lives in the mpp module, whose barrel imports the payments barrel,
 * so importing it here would close a cycle `no-circular` refuses.
 *
 * ## Concurrency
 *
 * Leader-gated across replicas (`runIfLeader`) — the RPC read is the expensive
 * part. Correctness does not depend on the election: every terminal write is a
 * CAS (`status = 'submitted' AND tx_hash IS NULL`), so a concurrent settle (or
 * a second reconciler) can win a race and this tick's write is then the no-op
 * loser. Two replicas would also both write, sequentially and identically —
 * the loser's UPDATE matches zero rows. The booking's side effects run only
 * for the CAS winner, so a lost race books once: one evidence call, one feed
 * call, one funnel event.
 *
 * ## Cost, and what an outage does
 *
 * Candidates are the outcome-pending rows only — receipts-unconfirmed submits,
 * bounded by the age gate and the tick LIMIT. A bundler outage confirms
 * nothing and writes nothing; rows age past the window only when the reads
 * were actually answering "not found", which is the failure the window exists
 * to bound.
 */

import {
  findOutcomePendingIntents,
  reconcileOutcomeFailed,
} from '../../infra/repositories/payment-intents.js'
import { readUserOperationReceipt } from '../../rails/delegation-rail.js'
import {
  bookConfirmedPayment,
  type ConfirmBookingEvidenceHook,
  type ConfirmBookingInput,
} from './confirm-booking.js'

/** Structural logger — Fastify's and vitest's loggers both satisfy it. */
export interface ReconcileLogger {
  info: (obj: Record<string, unknown>, msg?: string) => void
  warn: (obj: Record<string, unknown>, msg?: string) => void
}

/**
 * Grace before a `submitted` row becomes a reconciler candidate.
 *
 * #4818: the claim now records the operation hash, so a candidate can be a row
 * whose sign request is STILL RUNNING — the route claims, sends, and waits for
 * a receipt before it books anything. The route's longest wait is the 10 s send
 * timeout plus the 120 s receipt-wait timeout (130 s), plus the booking that
 * follows it. The gate must sit above that whole window: a row selected
 * mid-flight would be read from the bundler while the route is still waiting,
 * and the window arm could book it `failed` under a live request.
 *
 * 300 s leaves ~170 s of margin over the route's 130 s worst case. The cost is
 * that a route-booked outcome-pending row (which is already ≥130 s old when it
 * is booked) waits ~170 s more before its first tick — the row is non-terminal
 * and the agent is told to poll, so that delay changes nothing it can observe.
 */
export const RECONCILE_MIN_AGE_SECONDS = 300

/**
 * How long an op may stay "not found yet" before the row is resolved `failed`.
 * Sized beyond any ordinary inclusion lag (the settlement sweeper's own window
 * arithmetic treats tens of minutes as generous on Base), so the bound only
 * fires on an op that is genuinely never going to appear.
 */
export const RECONCILE_MAX_AGE_SECONDS = 24 * 60 * 60

/** Candidates considered per tick, across all chains. */
export const RECONCILE_MAX_CANDIDATES_PER_TICK = 100

export type ReconcileOutcome = 'confirmed' | 'failed_reverted' | 'failed_window_elapsed' | 'unresolved'

export interface SubmissionReconcileTickResult {
  candidates: number
  confirmed: number
  failedReverted: number
  failedWindowElapsed: number
  unresolved: number
}

/** The result key each decision increments. */
const RESULT_KEY: Record<Exclude<ReconcileOutcome, 'unresolved'> | 'unresolved', keyof Omit<SubmissionReconcileTickResult, 'candidates'>> = {
  confirmed: 'confirmed',
  failed_reverted: 'failedReverted',
  failed_window_elapsed: 'failedWindowElapsed',
  unresolved: 'unresolved',
}

/**
 * The booking the tick runs on a confirmed receipt (#4819). Injected like the
 * tick's other seams so the decision layer can be tested without a database;
 * the default is the shared `bookConfirmedPayment`.
 */
export type ConfirmBooking = (input: ConfirmBookingInput<ReconcileLogger>) => Promise<boolean>

export interface SubmissionReconcileDeps {
  findCandidates?: typeof findOutcomePendingIntents
  readReceipt?: typeof readUserOperationReceipt
  /** The shared booking (#4819). Defaults to `bookConfirmedPayment`. */
  bookConfirmed?: ConfirmBooking
  failOutcome?: typeof reconcileOutcomeFailed
  /**
   * The machine-payment evidence hook the booking calls. REQUIRED: a confirmed
   * payment must record its evidence, and a silent no-op here would book a
   * confirmed payment with no evidence row — the thin booking this slice
   * removes. The caller supplies it because the hook lives in the mpp module,
   * whose barrel imports the payments barrel (see `confirm-booking.ts`).
   */
  recordEvidence: ConfirmBookingEvidenceHook<ReconcileLogger>
}

/**
 * One reconcile tick. Never throws for an individual candidate — one poison
 * row must not silence the rest, and the queue is oldest-first, so a row that
 * threw on every tick would otherwise be first in line every time.
 */
export async function runSubmissionReconcileTick(
  log: ReconcileLogger,
  deps: SubmissionReconcileDeps,
): Promise<SubmissionReconcileTickResult> {
  const findCandidates = deps.findCandidates ?? findOutcomePendingIntents
  const readReceipt = deps.readReceipt ?? readUserOperationReceipt
  const bookConfirmed = deps.bookConfirmed ?? bookConfirmedPayment
  const failOutcome = deps.failOutcome ?? reconcileOutcomeFailed
  const recordEvidence = deps.recordEvidence

  const rows = await findCandidates(RECONCILE_MIN_AGE_SECONDS, RECONCILE_MAX_CANDIDATES_PER_TICK)
  const result: SubmissionReconcileTickResult = {
    candidates: rows.length,
    confirmed: 0,
    failedReverted: 0,
    failedWindowElapsed: 0,
    unresolved: 0,
  }
  if (rows.length === 0) return result

  for (const row of rows) {
    let outcome: ReconcileOutcome = 'unresolved'
    try {
      const receipt = await readReceipt(row.chain_id, row.user_op_hash as `0x${string}`)
      if (receipt.state === 'included') {
        if (receipt.success) {
          // Landed and succeeded → the ONE booking (#4819), with the receipt's
          // own tx hash: fiat values, evidence, accounting feed and the
          // first-payment event, exactly as the sign route books its own
          // confirm. The booking's CAS makes a concurrent settle the clean
          // winner; a lost write is still "resolved", just by the other
          // writer, so `unresolved` would miscount — but it also cannot be
          // distinguished from a genuinely still-open row without a second
          // read, so it is counted unresolved and left to the next tick to
          // re-derive from state.
          const booked = await bookConfirmed({
            intentId: row.id,
            txHash: receipt.txHash,
            agentId: row.agent_id,
            userId: row.user_id,
            tokenSymbol: row.token_symbol,
            amountHuman: row.amount_human,
            log,
            recordEvidence,
          })
          if (booked) {
            log.info({ payment_id: row.id, user_op_hash: row.user_op_hash, tx_hash: receipt.txHash }, 'Submission reconciled: receipt confirmed')
            outcome = 'confirmed'
          }
        } else {
          if (await failOutcome(row.id, ' was included but reverted')) {
            log.info({ payment_id: row.id, user_op_hash: row.user_op_hash }, 'Submission reconciled: receipt shows revert')
            outcome = 'failed_reverted'
          }
        }
      } else {
        // Not found yet. Inside the window that means nothing.
        const ageSeconds = Math.floor((Date.now() - new Date(row.signed_at).getTime()) / 1000)
        if (ageSeconds >= RECONCILE_MAX_AGE_SECONDS) {
          if (await failOutcome(row.id, ' was never seen on chain after the bounded reconciliation window')) {
            log.info({ payment_id: row.id, user_op_hash: row.user_op_hash, age_seconds: ageSeconds }, 'Submission reconciled: window elapsed with no receipt')
            outcome = 'failed_window_elapsed'
          }
        }
      }
    } catch (err) {
      // readUserOperationReceipt maps read failures to not_found_yet itself; a
      // throw here is unexpected. "Not known yet" is the only safe reading of
      // any failure on this path — never a terminal booking.
      log.warn({ payment_id: row.id, user_op_hash: row.user_op_hash, err }, 'Submission reconcile attempt threw — row left unresolved')
    }
    result[RESULT_KEY[outcome]] += 1
    if (outcome === 'unresolved') {
      log.info({ payment_id: row.id, user_op_hash: row.user_op_hash }, 'Submission outcome still unresolved')
    }
  }
  return result
}
