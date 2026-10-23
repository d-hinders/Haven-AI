/**
 * The ONE plain-word map for refused payment attempts (#4323).
 *
 * Imported by the agent Activity tab's refusal rows and, from #4324, by the
 * Needs-attention card items — one map, or the two surfaces would disagree on
 * what "delegation_budget_exceeded" says. The words are a FRONTEND contract:
 * the wire carries the raw `reason` enum (mirroring the payment_refusals
 * CHECK), never a `reason_label`.
 *
 * Words are about the AGENT, in the product's plain register — what the agent
 * tried, what stopped it, no protocol vocabulary ("delegation", "relayer",
 * "revert") per docs/product/copy-guidelines.md. The user-facing sublines are
 * built here too, so the Activity row and #4324's card cannot drift.
 */

import type { ApiSchema } from '@haven_ai/core'

/** One refused-attempt row from `GET /agent-activity/:id/activity?kind=refusals`. */
export type RefusalActivityItem = ApiSchema<'RefusalActivityEntry'>

export type PaymentRefusalReason = NonNullable<RefusalActivityItem['reason']>

/**
 * `delegation_budget_exceeded` covers ALL the budget caps the guardrails
 * enforce — the period budget, the task budget and the sub-budget caps (the
 * enforcer error codes share the classification) — so "Over its budget" is
 * the one word for all of them.
 */
const REASON_WORDS: Record<PaymentRefusalReason, string> = {
  delegation_budget_exceeded: 'Over its budget',
  delegation_expired: 'Its budget had expired',
  no_delegation_for_target: 'Recipient outside its rules',
  relayer_budget: "Haven's sponsorship limit",
  onchain_revert: 'Refused by the network',
}

/** The plain words for one refusal reason. */
export function refusalReasonWords(reason: string): string {
  return (REASON_WORDS as Record<string, string>)[reason] ?? 'Refused by a guardrail'
}

/** The defensive `type` filter the kinded readers apply (#4229's rule). */
export function isRefusalActivityItem(item: unknown): item is RefusalActivityItem {
  return typeof item === 'object' && item !== null && (item as { type?: string }).type === 'refusal'
}

/**
 * The refusal row's subline (#4323): "<reason words> · No money moved" —
 * no money moved is the fact every refusal shares. The one exception is
 * `relayer_budget`: that refusal is written at redeem, AFTER the intent
 * exists, and the claim is released to `pending_signature` — the same
 * attempt shows as a pending payment AND a refusal (they cannot be linked;
 * the refusal carries no payment id). Its subline says so, instead of the
 * false "No money moved" for an attempt that may still settle.
 */
export function refusalRowSubline(reason: string): string {
  if (reason === 'relayer_budget') {
    return `${REASON_WORDS.relayer_budget} · The payment stayed pending and can be retried`
  }
  return `${refusalReasonWords(reason)} · No money moved`
}
