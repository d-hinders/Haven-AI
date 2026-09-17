/**
 * The refusal choke point (#3053, slice 2 of epic #3056).
 *
 * `refuse()` is the one way a policy refusal in the two enumerated files
 * (modules/x402/delegation-authorize.ts, routes/payments.ts) becomes a
 * response: it records the refusal in the `payment_refusals` ledger
 * fire-and-forget and hands back the already-decided response untouched.
 *
 * ## The one rule (inherited from #2945, restated because it is the point)
 *
 * A ledger write must never be able to change, delay, or block the refusal
 * response it records. `refuse()` therefore never awaits the write: the
 * recorder (`recordRefusalFireAndForget`) returns synchronously and swallows
 * its own failures, and this wrapper returns the caller's response object
 * verbatim — byte-identical to what the handler returned before migrating
 * (characterization-pinned in the guard's sibling suites).
 *
 * ## The two response shapes this module's callers use
 *
 * - `{ code, body }` (X402HandlerResult): the x402 orchestration contract.
 *   `refuse()` takes the pair, records, and returns it unchanged.
 * - `reply`: a Fastify reply the handler has ALREADY sent inside its own
 *   argument expression (`refuse(reply.code(n).send(...), ledger)`) and is
 *   about to return. `refuse()` records and returns the reply verbatim; it
 *   never sends or touches the reply itself.
 *
 * ## The already-sent question
 *
 * In the reply form the send happens BEFORE refuse() runs — Fastify flips
 * `reply.sent` synchronously inside `.send()`, which is exactly how the
 * decided response is on its way to the caller before the ledger write is
 * even issued. There is no "not yet sent" reply state to detect at this
 * call shape, and refusing to record on `sent === true` would skip every
 * real writer. The genuine double-send hazard lives in the CALLER's own
 * expression (a second `.send()` throws there, inside Fastify) and never
 * reaches this function — so refuse() records unconditionally and stays out
 * of Fastify's send-lifecycle errors entirely. (The issue's "what it does
 * if the reply was already sent": by the time refuse() sees a reply, the
 * send is the mechanism that produced it; the write rides along, detached,
 * and cannot alter what was sent.)
 *
 * ## Scope boundary (#994)
 *
 * modules/payments must not import the route layer. The reply overload
 * therefore accepts a structural minimum — `{ code(n), send, sent }` — and
 * the test suite pins the structural type's assignability from the real
 * FastifyReply instead of importing fastify here.
 *
 * ## Why one payment can legitimately land TWO ledger rows
 *
 * The 60-second dedupe window in RECORD_REFUSAL_SQL keys on
 * `(agent_id, reason, resource_url)`; `source` and amount are NOT in the
 * key. On the degraded-read path one payment can therefore produce a
 * fail-fast pre-check row (`delegation_budget_exceeded`) AND a prepare-catch
 * row (`delegation_expired` / `onchain_revert`) for the same resource — they
 * never collide because the window is partitioned by reason, and that is the
 * RIGHT outcome: two observations, two rows, the first with full precision.
 * Do NOT narrow the dedupe key to `(agent, resource_url)` to "fix" the
 * double row — that partitions the audit trail on the wrong column.
 */

import { recordRefusalFireAndForget, type RefusalLedgerInput } from './refusal-ledger.js'

/** A decided `{ code, body }` response (the x402 orchestration shape). */
export interface DecidedResponse {
  code: number
  body: unknown
}

/**
 * Structural minimum of a Fastify reply at the refusal decision point:
 * coded but not yet sent. `sent` is how the choke point detects the
 * already-sent case without importing the route layer (#994).
 */
export interface RefusalReplyLike {
  code(statusCode: number): unknown
  send(payload?: unknown): unknown
  readonly sent: boolean
}

/** The ledger input minus the fields `refuse()` derives per call site. */
export type RefuseLedgerInput = Omit<RefusalLedgerInput, 'amountHuman'>

/**
 * Record a policy refusal in the payment_refusals ledger WITHOUT any
 * possibility of the write changing the response, and return the response.
 *
 * A `null` ledger records nothing and returns the response unchanged — the
 * allowlisted no-writer policy-status sites (build/deploy infrastructure,
 * capacity) go through the same choke point so the census sees them, while
 * the ledger stays exclusively a record of policy refusals.
 *
 * Overload 1 — the decided `{ code, body }` pair: returned verbatim.
 * Overload 2 — a Fastify reply, coded but not yet sent: returned for the
 * handler to return. See the module header for the already-sent case.
 */
export function refuse(response: DecidedResponse, ledger: RefuseLedgerInput | null): DecidedResponse
export function refuse<T extends RefusalReplyLike>(reply: T, ledger: RefuseLedgerInput | null): T
export function refuse(
  response: DecidedResponse | RefusalReplyLike,
  ledger: RefuseLedgerInput | null,
): DecidedResponse | RefusalReplyLike {
  if (isReply(response)) {
    // The reply form: the send already happened in the caller's own argument
    // expression (that is what makes the response "decided"). Record and
    // hand the reply back verbatim — never send, never await, never touch
    // Fastify's send lifecycle. See "The already-sent question" above.
    if (ledger) {
      recordSafely(ledger)
    }
    return response
  }
  if (ledger) {
    recordSafely(ledger)
  }
  return response
}

/**
 * Belt and braces at the seam: the recorder already detaches its write and
 * swallows failures, but if that detach ever regresses and something throws
 * synchronously out of the recorder, the failure dies HERE — never in the
 * handler that is holding a decided refusal.
 */
function recordSafely(ledger: RefuseLedgerInput): void {
  try {
    recordRefusalFireAndForget(ledger)
  } catch (err: unknown) {
    console.error(
      'refuse(): the refusal recorder threw synchronously — swallowed so the decided refusal response is unchanged:',
      err instanceof Error ? err.message : String(err),
    )
  }
}

function isReply(value: DecidedResponse | RefusalReplyLike): value is RefusalReplyLike {
  // A DecidedResponse has exactly `code` (number) + `body`; a reply has
  // callable `code`/`send`. Checking the callable first keeps a body object
  // that happens to carry a `code` number from being misread as a reply.
  return typeof (value as RefusalReplyLike).code === 'function' && typeof (value as RefusalReplyLike).send === 'function'
}
