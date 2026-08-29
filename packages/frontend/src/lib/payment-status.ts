import type { StatusTone } from '@/components/ui/StatusBadge'

export type AgentStatus = 'active' | 'paused' | 'pending_approval' | 'revoked'

/**
 * Payment statuses this app can actually be handed (#2120, epic #1440).
 *
 * ── Why there is no approval presentation here any more ────────────────────
 *
 * This module used to carry a second status family — `ApprovalStatus`
 * (`pending | approved | proposed | rejected | executed | expired`), an
 * `APPROVAL_STATUS` presentation map whose `pending` rendered **"Needs
 * approval"**, an `approvalStatusPresentation()`, an
 * `isActionableApprovalStatus()`, and a `'pending_approval'` member on
 * `PaymentStatus` that also rendered "Needs approval". #2106 deferred the
 * decision; #2120 makes it: **deleted**, because nothing can reach it and
 * what it rendered was a promise the product can no longer keep.
 *
 * The unreachability is a data-flow fact, not an assertion:
 *
 *  1. The only runtime entry point was `activityStatusPresentation()`, called
 *     from `AgentDetailClient`'s activity row.
 *  2. Its rows come from `GET /agent-activity/:id/activity` and
 *     `/agent-activity/feed`. Since #2055 both build their list from
 *     `payment_intents` rows and MCP tool invocations only — the
 *     `approval_requests` feed entries went with the table (migration 070),
 *     so no `type: 'approval'` row exists to carry an approval status.
 *  3. A row's `status` is `payment_intents.status`, and every write site in
 *     the backend sets exactly one of `pending_signature | submitted |
 *     confirmed | failed | expired` (`infra/repositories/payment-intents.ts`,
 *     `x402-authorizations.ts`, `agent-rekeys.ts`). `'pending_approval'` was
 *     never a `payment_intents` value at all — it was synthesised on the wire
 *     for an `approval_requests` row (`kind: 'approval_request'`), and that
 *     table is dropped, so not even a historical row can carry it.
 *  4. `isActionableApprovalStatus()` had zero call sites anywhere in the repo.
 *     It gated nothing.
 *
 * ── Consistency with PR #2113 ──────────────────────────────────────────────
 *
 * #2113 kept the SDK's `pending | pending_approval` branches
 * (`packages/sdk/src/payment-state.ts`) and rewrote their verdict from "wait
 * for approval" to **stop**. That retention is right there and wrong here,
 * and the difference is what the branch does. The SDK's branch **decides
 * agent behaviour** on an unrecognised status; keeping it fail-closed is
 * worth real money. Everything removed here was **presentation**, and the
 * presentation *was* the false promise: "Needs approval" tells a user a queue
 * exists and that somebody can act on it, on a rail where an out-of-budget
 * payment reverts on-chain and is never held for anyone. Deleting the map
 * does not remove a guard — it routes any unrecognised status to
 * `formatUnknownStatus()`, which echoes the backend's own word with a neutral
 * tone and claims nothing. That is the fail-closed direction, not away from
 * it.
 *
 * ── Deliberately left ──────────────────────────────────────────────────────
 *
 * `failedOrRejectedStatus()`'s `'rejected'` arm is approval-era residue by the
 * same argument, but it is a boolean arm rather than a rendered claim (it can
 * only ever tint a row that cannot arrive), and the function has a live caller
 * for its `'failed'` arm. Left alone rather than renamed; noted so the next
 * reader knows it was considered, not missed.
 */
export type PaymentStatus =
  | 'pending_signature'
  | 'submitted'
  | 'confirmed'
  | 'failed'
  | 'expired'

export interface StatusPresentation {
  label: string
  tone: StatusTone
}

const AGENT_STATUS: Record<AgentStatus, StatusPresentation> = {
  active: { label: 'Connected', tone: 'success' },
  paused: { label: 'Paused', tone: 'warning' },
  // #1069: setup started but no budget granted yet — the agent exists and is
  // reachable, it just cannot pay. Warning, not danger: the fix is one step.
  // Note this is the AGENT `pending_approval`, which is alive and produced by
  // `POST /agent-connection-setups/register`; it is unrelated to the retired
  // payment-approval queue and renders "Needs setup", never "Needs approval".
  pending_approval: { label: 'Needs setup', tone: 'warning' },
  revoked: { label: 'Revoked', tone: 'danger' },
}

const PAYMENT_STATUS: Record<PaymentStatus, StatusPresentation> = {
  pending_signature: { label: 'Awaiting signature', tone: 'brand' },
  submitted: { label: 'Submitted', tone: 'brand' },
  confirmed: { label: 'Sent', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  expired: { label: 'Expired', tone: 'neutral' },
}

export function formatUnknownStatus(status: string): string {
  const words = status
    .split('_')
    .filter(Boolean)
    .map((part) => part.toLowerCase())

  if (words.length === 0) return 'Unknown'
  const [first, ...rest] = words
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(' ')
}

export function agentStatusPresentation(status: string): StatusPresentation {
  return AGENT_STATUS[status as AgentStatus] ?? {
    label: formatUnknownStatus(status),
    tone: 'neutral',
  }
}

/**
 * The presentation for any status on a payment/activity row. Unrecognised
 * input echoes the backend's own word, neutrally — see the module note: that
 * fallback is the fail-closed path, and it is what a retired-rail status hits.
 */
export function paymentStatusPresentation(status: string): StatusPresentation {
  return PAYMENT_STATUS[status as PaymentStatus] ?? {
    label: formatUnknownStatus(status),
    tone: 'neutral',
  }
}

export function failedOrRejectedStatus(status: string): boolean {
  return status === 'failed' || status === 'rejected'
}
