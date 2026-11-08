import type { ApiSchema } from '@haven_ai/core'
import { dayKeyInZone } from '@/lib/format'
import type { AggregatedTransaction } from '@/types/transactions'

/**
 * Live rows (#4708, epic #4701): which rows arrived while the page was open.
 *
 * A confirmed payment that lands during a poll plays `Milestone` Live once,
 * then it is an ordinary row. Nothing plays on load, on "load more", or when a
 * filter or search changes — those are the user asking for a different list,
 * not the list growing under them.
 *
 * ## One comparison, two shapes
 *
 * The two lists that opt in do not have the same shape, so the comparison is
 * generic over the item and each list supplies three answers:
 *
 * - `keyOf` — the item's identity across polls;
 * - `markOf` — the value the NEXT poll needs to compare against (a row's
 *   outcome, a group's `latestAt`);
 * - `plays` — whether this item is eligible, given its mark last time.
 *
 * The snapshot is `key → mark`, not a bare set of keys, because a row keeps
 * its identity when it confirms: an identity-only comparison could never see
 * a pending row become confirmed (the blocking review on #4708).
 *
 * ## Only confirmed outcomes play
 *
 * Decision 2 on #4701. A pending or failed row does not play; a pending row
 * that confirms plays then, once. On `/transactions` that is the outcome map
 * (`pending` → `confirmed`); on the dashboard the group key carries the
 * outcome, so the confirmed group is a new key.
 *
 * ## The cap
 *
 * At most `LIVE_ROW_CAP` rows play from one poll, the newest. A tab left
 * hidden for an hour comes back through the same fetcher as a tick
 * (`useVisiblePolling`), and the rows really did arrive since the user last
 * saw the list — but lighting up the whole list would read as a page load,
 * not as an arrival.
 */

/** At most this many rows play from one poll — the newest. */
export const LIVE_ROW_CAP = 3

/** The three outcomes `activityOutcome` derives on the backend. */
export type LiveOutcome = 'confirmed' | 'pending' | 'failed'

/** `key → the value the next poll compares against`. */
export type LiveRowSnapshot = Map<string, string | number>

export interface LiveRowOptions<T> {
  /** The item's identity across polls. */
  keyOf: (item: T) => string
  /** The value the next poll needs: a row's outcome, a group's `latestAt`. */
  markOf: (item: T) => string | number
  /** Whether this item is eligible to play, given its mark in the last snapshot. */
  plays: (item: T, previousMark: string | number | undefined) => boolean
  /** Newest-first ordering for the cap. */
  recencyOf: (item: T) => number
  /** Defaults to `LIVE_ROW_CAP`. */
  cap?: number
}

/**
 * Compare this poll's items against the last poll's snapshot.
 *
 * `previous === null` means "there is no last poll" — the first load, or a
 * list that has just been reset — and plays nothing while still returning the
 * snapshot the next poll compares against. That is the rule that keeps a page
 * load silent without every caller re-implementing it.
 */
export function liveRowKeys<T>(
  items: readonly T[],
  previous: ReadonlyMap<string, string | number> | null,
  options: LiveRowOptions<T>,
): { keys: Set<string>; snapshot: LiveRowSnapshot } {
  const snapshot: LiveRowSnapshot = new Map()
  for (const item of items) snapshot.set(options.keyOf(item), options.markOf(item))

  if (previous === null) return { keys: new Set(), snapshot }

  const cap = options.cap ?? LIVE_ROW_CAP
  const eligible = items.filter((item) => options.plays(item, previous.get(options.keyOf(item))))
  // Newest first, then the cap. `sort` is stable, so two items with the same
  // instant keep the caller's order rather than an arbitrary one.
  eligible.sort((a, b) => options.recencyOf(b) - options.recencyOf(a))
  return { keys: new Set(eligible.slice(0, cap).map(options.keyOf)), snapshot }
}

/** True when two live-key sets hold the same keys — avoids a needless re-render. */
export function sameLiveKeys(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const key of a) if (!b.has(key)) return false
  return true
}

// ── Transactions: rows with a stable identity ───────────────────────────────

/**
 * The proof statuses the backend treats as terminal (`TERMINAL_PROOF_STATUSES`
 * in `packages/backend/src/modules/transactions/activity.ts`). Anything else
 * that is present means the payment is still in flight.
 */
const TERMINAL_PROOF_STATUSES = new Set(['protocol_receipt_attached', 'merchant_response_observed'])

/**
 * The row's outcome, mirroring the backend's `activityOutcome`
 * (`modules/transactions/activity.ts:235`): `isError` → failed; a
 * `paymentFlowStatus` of `confirming_merchant`/`needs_attention`, or a
 * non-terminal `paymentProofStatus` → pending; else confirmed.
 *
 * All three wire fields reach `AggregatedTransaction` through the generated
 * `Transaction` schema (`packages/core/src/api-types.ts`), so this reads the
 * same values the server grouped on — no client-side guess.
 */
export function transactionOutcome(
  tx: Pick<AggregatedTransaction, 'isError' | 'paymentFlowStatus' | 'paymentProofStatus'>,
): LiveOutcome {
  if (tx.isError) return 'failed'
  if (tx.paymentFlowStatus === 'confirming_merchant' || tx.paymentFlowStatus === 'needs_attention') {
    return 'pending'
  }
  if (tx.paymentProofStatus != null && !TERMINAL_PROOF_STATUSES.has(tx.paymentProofStatus)) {
    return 'pending'
  }
  return 'confirmed'
}

/**
 * The row's identity across polls: `accountId:hash:type` — the client key at
 * `TransactionsClient.tsx:508` without its `index`.
 *
 * The `index` is a React-key tiebreaker for two rows that share an identity
 * (an `ownTransfer` fold can put both legs under one hash, #4265); it is not
 * part of the row's identity, and including it would make a row look new every
 * time the list re-ordered.
 */
export function transactionLiveKey(
  tx: Pick<AggregatedTransaction, 'accountId' | 'hash' | 'type'>,
): string {
  return `${tx.accountId}:${tx.hash}:${tx.type}`
}

/**
 * A `/transactions` row plays when it is confirmed AND either it is new or it
 * was pending in the last snapshot. A newly arrived pending or failed row does
 * not play; a pending row that confirms plays then, once.
 */
export const TRANSACTION_LIVE_OPTIONS: LiveRowOptions<AggregatedTransaction> = {
  keyOf: transactionLiveKey,
  markOf: transactionOutcome,
  plays: (tx, previousMark) =>
    transactionOutcome(tx) === 'confirmed' &&
    (previousMark === undefined || previousMark === 'pending'),
  recencyOf: (tx) => tx.timestamp,
}

// ── Dashboard: groups, not rows ─────────────────────────────────────────────

/** One grouped-activity row from `GET /dashboard/overview` (#3824). */
export type DashboardActivityGroup = ApiSchema<'DashboardActivityGroup'>

/**
 * The group's comparison key, built from the fields the wire carries.
 *
 * The backend keys a group on agent, chain, token, counterparty, local day,
 * outcome and activity type (`modules/transactions/activity.ts:425-433`); the
 * wire has no group id, and the React key at `ActivitySection.tsx:242` carries
 * an `index`, so neither can be the comparison key. This projects the
 * backend's key onto what the group actually serves:
 *
 * - `agentId`, `tokenSymbol`, `activityType`, `direction` — carried verbatim;
 * - `to` + `x402ResourceUrl` — the counterparty half (the resource URL is the
 *   sharper identity for an x402 payment, the far-side address otherwise);
 * - `dayKeyInZone(latestAt)` — the group's local day. `latestAt` is the newest
 *   member's instant, and every member is in the group's day, so the key is
 *   stable for the life of the group;
 * - `status` — the outcome. It is IN the key on purpose: a pending group that
 *   confirms becomes a new key, which is how the dashboard sees the
 *   pending → confirmed transition without an outcome map.
 *
 * `merchantName` is deliberately absent: it is a display name the backend
 * resolves, not identity, and a contact renamed mid-session would otherwise
 * make an existing group look new.
 */
export function activityGroupLiveKey(
  group: Pick<
    DashboardActivityGroup,
    'agentId' | 'tokenSymbol' | 'to' | 'x402ResourceUrl' | 'activityType' | 'direction' | 'status' | 'latestAt'
  >,
): string {
  return [
    group.agentId ?? '',
    group.tokenSymbol,
    group.to.toLowerCase(),
    group.x402ResourceUrl ?? '',
    group.activityType ?? '',
    group.direction,
    dayKeyInZone(group.latestAt),
    group.status,
  ].join(':')
}

/**
 * A dashboard group plays when it is confirmed AND either it is new or its
 * `latestAt` advanced.
 *
 * The second half is the whole point of the group shape: a second payment to
 * the same merchant on the same day raises `count` and adds no row, so the
 * group's key does not change — only its newest member's instant does.
 */
export const ACTIVITY_GROUP_LIVE_OPTIONS: LiveRowOptions<DashboardActivityGroup> = {
  keyOf: activityGroupLiveKey,
  markOf: (group) => Date.parse(group.latestAt),
  plays: (group, previousMark) =>
    group.status === 'confirmed' &&
    (previousMark === undefined ||
      (typeof previousMark === 'number' && previousMark < Date.parse(group.latestAt))),
  recencyOf: (group) => Date.parse(group.latestAt),
}
