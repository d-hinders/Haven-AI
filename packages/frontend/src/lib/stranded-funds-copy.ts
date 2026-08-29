/**
 * One sentence for one reconciliation event, shared by every surface that
 * announces it (#2195).
 *
 * `/agents` (`AgentCard`) and `/agents/[agentId]` (`AgentDetailClient`) both
 * warn about the same thing: an open `merchant_retry_rejected_after_payment`
 * reconciliation event, i.e. an x402 payment whose funding leg settled
 * on-chain while the merchant never pulled the funds, leaving them on the
 * agent's delegate EOA. They are one click apart — the card's own link is the
 * navigation — and they used to say it in two different sentences:
 *
 *   AgentCard        "A payment was funded on-chain but not settled."
 *   AgentDetailClient "A payment was funded on-chain but didn’t reach the
 *                      merchant, leaving money in your agent’s wallet."
 *
 * Read back to back that divergence is an inconsistency, not a difference in
 * detail level. The core clause now lives here once.
 *
 * **The two surfaces are NOT equally informed, and this module encodes that
 * rather than hiding it.** The difference is structural, not editorial:
 *
 * - `AgentCard` reads `agent.has_stranded_funds`, which both agent-row reads
 *   compute as a bare SQL `EXISTS(...)` over the agent's open events
 *   (`packages/backend/src/infra/repositories/agents.ts` —
 *   `LIST_AGENTS_FOR_USER_ALL_STATUSES_SQL` and
 *   `FIND_AGENT_FOR_USER_ALL_STATUSES_SQL`). An `EXISTS` is a boolean: the
 *   card cannot know how many events there are, and cannot know an amount.
 * - `AgentDetailClient` filters the agent's activity feed for the same event
 *   type, so it holds the actual list — and it separately reads the delegate
 *   EOA's balance from `/agents/:id/delegate-balance`, so it can name a figure.
 *
 * Hence the parameter: pass the count when the surface has one, and `null`
 * when all it holds is existence. Nothing bounds that count at one — the
 * reconciliation upsert is unique per `(payment_intent_id, event_type)`
 * (`infra/repositories/machine-payments.ts`), so N intents with open events
 * produce N rows for one agent, and the old unconditional singular was
 * accidentally rather than provably right.
 */

/**
 * The title every surface gives this state. Was "Stranded funds on delegate"
 * on `AgentCard` and "Recoverable funds in agent wallet" on the detail banner:
 * two names for one thing, one of them ("delegate") the internal name for the
 * agent's EOA rather than a word the product uses with users anywhere else.
 */
export const STRANDED_FUNDS_TITLE = 'Recoverable funds in agent wallet'

/**
 * The cause clause, count-aware.
 *
 * `null` means "this surface knows the state exists and nothing more" — it
 * gets "At least one payment", which is exactly as strong a claim as the
 * `EXISTS` behind it and no stronger.
 */
export function strandedFundsCause(count: number | null): string {
  if (count === null) {
    return 'At least one payment was funded on-chain but didn’t reach the merchant, leaving money in your agent’s wallet.'
  }
  if (count === 1) {
    return 'A payment was funded on-chain but didn’t reach the merchant, leaving money in your agent’s wallet.'
  }
  return `${count} payments were funded on-chain but didn’t reach the merchant, leaving money in your agent’s wallet.`
}

/**
 * The label on the affordance that takes the reader from the warning to the
 * rows that caused it (#2196), count-aware for the same reason.
 *
 * Only ever rendered where the count is known, so there is no `null` branch:
 * a surface that cannot count the events cannot honestly promise how many
 * rows the reader is about to find.
 */
export function reviewStrandedPaymentsLabel(count: number): string {
  return count === 1 ? 'Review the payment' : `Review the ${count} payments`
}
