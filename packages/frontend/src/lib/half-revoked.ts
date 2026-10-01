import type { Agent } from '@/hooks/useAgents'

/**
 * #3542: a "half-revoked" agent has had its Haven credential ended (revoked) or
 * been filed under Removed (archived), but a budget delegation of its is still
 * redeemable on-chain. `POST /agents/:id/revoke` only flips `agents.status`; the
 * budget stays spendable until the owner signs `revoke-all`.
 *
 * `live_delegation_count` is the backend's own count of pending/active/replaced
 * delegation rows — the exact set `revoke-all` targets. `allowances.length` is
 * NOT a substitute: it is projected from ACTIVE rows only and misses `replaced`.
 *
 * One predicate for every surface (list card, detail page, account page, the
 * Removed toggle), so they cannot disagree about which agents qualify.
 */
export function isHalfRevoked(agent: Agent): boolean {
  const ended = agent.status === 'revoked' || agent.archived_at != null
  return ended && (agent.live_delegation_count ?? 0) > 0
}

/**
 * Whether the owner can finish the job from here. `revoke-all` refuses an agent
 * with no linked account (the account was removed), so an unlinked half-revoked
 * agent is marked but offers no action.
 */
export function canFinishRevoking(agent: Agent): boolean {
  return isHalfRevoked(agent) && agent.account_id != null
}

/** Shared copy: every surface says the same thing about the same state. */
export const HALF_REVOKED_TITLE = 'Revoked in Haven — its budget is still active on-chain'
export const HALF_REVOKED_BODY =
  'Haven stopped this agent’s credential, but its budget has not been ended on-chain yet. Sign once to end it.'
export const HALF_REVOKED_UNLINKED_BODY =
  'Its budget may still be active on the account it was removed from, and Haven cannot end it from here.'
export const FINISH_REVOKING_LABEL = 'Finish revoking'
