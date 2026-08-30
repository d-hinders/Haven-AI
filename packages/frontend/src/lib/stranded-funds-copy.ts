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
 * The count-bearing subject.
 *
 * `null` means "this surface knows the state exists and nothing more" — it
 * gets "At least one payment", which is exactly as strong a claim as the
 * `EXISTS` behind it and no stronger.
 */
function strandedSubject(count: number | null): string {
  if (count === null) return 'At least one payment was'
  if (count === 1) return 'A payment was'
  return `${count} payments were`
}

/** What happened. The clause every surface shares, verbatim. */
export function strandedFundsCause(count: number | null): string {
  return `${strandedSubject(count)} funded on-chain but didn’t reach the merchant.`
}

/**
 * The same clause plus where the money ended up — the detail banner's variant.
 *
 * This is the detail-level difference #2195 asked for: carried by what is
 * ADDED around the shared core rather than by a reworded core. Two reasons the
 * location clause lives here and not on `AgentCard`:
 *
 * 1. The detail banner has a degraded branch that says *"Recover **it** to
 *    your Haven wallet."* — `strandedSummary` null, the #1098 partial-response
 *    guard — and "it" needs "money in your agent's wallet" as its antecedent.
 *
 *    **Be precise about what that argument is worth.** `haven-reviewer` traced
 *    the contract and found **no path a well-formed response can take to reach
 *    it today**: `DelegateBalance.usdc` is non-optional (`api-types.ts:2844`),
 *    the handler computes `usdc` and `usdc_atomic` together in one
 *    `formatTokenValue` call (`routes/agents.ts:127-168`), `formatTokenValue`
 *    never returns empty for a nonzero atomic value (`domain/tokens.ts:33-49`),
 *    and `useDelegateBalance` sets `balance` atomically. #1098's guard is
 *    defensive code surviving an earlier response shape (`dda3c1ce`), and no
 *    test anywhere exercises the branch.
 *
 *    So this is NOT "the dangling pronoun is reachable". It is: while that
 *    defensive branch exists and renders "it", the sentence it depends on
 *    should keep supplying the antecedent — cheap insurance on copy that is
 *    good either way, not a demonstrated state. Reason 2 is the load-bearing
 *    one.
 * 2. On `AgentCard` there is no such pronoun, the shared title already says
 *    "in agent wallet", and the link says "recover these funds" — so the
 *    clause was pure repetition that pushed the notice from three rendered
 *    lines to four at 390px, stranding the link alone on the last one
 *    (`haven-design-reviewer` on this change, measured off the 390 capture).
 */
export function strandedFundsCauseWithLocation(count: number | null): string {
  return `${strandedSubject(count)} funded on-chain but didn’t reach the merchant, leaving money in your agent’s wallet.`
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
