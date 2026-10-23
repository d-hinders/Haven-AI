/**
 * The expired-budget answer (#4352, epic #4349 slice 3).
 *
 * When the ONLY delegation row for a token has expired, the #3802 live reads
 * hide it and the refusal sites used to answer the generic
 * `delegation_budget_exceeded` prose — "exceeds the remaining budget for this
 * period … wait for the period to reset" — which is wrong on both counts:
 * nothing resets, and the row exists, dated. This module is the shared
 * expired-row lookup every refusal site consults on its ALREADY-REFUSING
 * path, so the answer becomes `delegation_expired` with the end date while
 * the decision (status, nothing created or signed) stays identical.
 *
 * The lookup goes through {@link findExpiredDelegationForToken} — the narrow
 * query in `infra/repositories/delegation-budgets.ts`, next to the #3919
 * liveness predicates it must never contradict: an expired row is returned
 * HERE and nowhere else, and a live row for the token keeps every caller on
 * its normal path before this is ever consulted.
 */

import { findExpiredDelegationForToken } from '../../infra/repositories/delegation-budgets.js'

export interface ExpiredBudget {
  /** The row's `expires_at`, unix seconds (BIGINT string from the reader). */
  endedAtSec: string
  /** Full ISO 8601 timestamp — the wire field's shape (cf. #4355's `next_refill_at`). */
  endedAtIso: string
  /** `YYYY-MM-DD` (UTC) — the prose's shape: "this budget ended on 2026-10-23". */
  endedOnDate: string
}

/** `MAX_SAFE_DATE_MS`-style clamp: an unrepresentable expiry is not an answer. */
const MAX_MS = 8.64e15

/**
 * The most recently ended budget row for `(agent, chain, token)`, or `null`
 * when there is none (or its expiry is not a representable timestamp —
 * degraded storage degrades to the generic refusal, never to garbage prose).
 * `tokenAddress: null` asks across ALL of the agent's tokens on the chain
 * (the allowances read's `budget_ended_at`).
 */
export async function findExpiredBudgetForToken(
  agentId: string,
  chainId: number,
  tokenAddress: string | null,
): Promise<ExpiredBudget | null> {
  const row = await findExpiredDelegationForToken(agentId, chainId, tokenAddress)
  if (!row) return null
  const sec = Number(row.expires_at)
  if (!Number.isFinite(sec) || sec <= 0 || sec * 1000 > MAX_MS) return null
  const date = new Date(sec * 1000)
  return {
    endedAtSec: row.expires_at,
    endedAtIso: date.toISOString(),
    endedOnDate: date.toISOString().slice(0, 10),
  }
}
