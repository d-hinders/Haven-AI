import type { Agent } from '@/hooks/useAgents'

/**
 * The ONE owner of "does this agent have a budget, and what does the line
 * say" (#3988). Every budget-authority DISPLAY surface reads it — the
 * dashboard row (`AgentsSection`, and through its `AgentBudget` the
 * `/agents` card since #4209), Needs-you (`dashboard-attention`), the Budget
 * facet and Largest-budget sort
 * (`agent-list-filters`), and the account detail page — so no surface keeps
 * its own `allowances.length` copy that drifts when the wire gains a second
 * kind of budget. The rule it encodes (#3802/#3897/#3983 lineage): a ZERO cap
 * is no authority, and an OPEN RECEIVED sub-budget is real authority.
 *
 * This file holds user-facing prose ("Spends from …") and is therefore in
 * SCAN_FILES of `scripts/frontend-copy-lint.mjs`.
 */

/**
 * A budget cap above zero (#3897). `budgetAtomic` is the ATOMIC integer —
 * `AgentsSection` and `dashboard-attention` carry it; an unparseable cap is
 * KEPT (true): the caption shows it as unknown rather than reading "No
 * budget" off a figure the client failed to parse. Zero is the only value
 * that means no authority.
 */
export function hasPositiveCap(budgetAtomic: string): boolean {
  try {
    return BigInt(budgetAtomic) > 0n
  } catch {
    return true
  }
}

/**
 * The same zero-cap rule for the human-decimal `allowances[].allowance_amount`
 * the `Agent` wire carries (`'250.00'`, `'0'`). Unparseable is kept, like
 * {@link hasPositiveCap}.
 */
export function hasPositiveAllowance(allowanceAmount: string): boolean {
  const n = Number(allowanceAmount)
  return Number.isFinite(n) ? n > 0 : true
}

/**
 * One received sub-budget grant, as both wire shapes spell it. The dashboard
 * overview (`DashboardAgent`) is camelCase; the `Agent` payload is
 * snake_case. The helper accepts either so the two wires cannot fork the
 * line.
 */
export interface ReceivedBudgetRef {
  open: boolean
  parentAgentName?: string
  parent_agent_name?: string
}

/**
 * The received-budget line: `"Spends from <parent>'s budget"`, or for
 * several parents `"<a> and <b>'s budgets"` — the dashboard's #3803 wording,
 * now the ONE copy. `null` when no qualifying grant is open: the caller
 * decides what no-authority reads (the card says "No budget"; the dashboard
 * row may have its own em-dash states).
 */
export function receivedBudgetLine(
  subs: readonly ReceivedBudgetRef[] | null | undefined,
): string | null {
  const open = (subs ?? []).filter((sub) => sub.open)
  if (open.length === 0) return null
  // Distinct parents; one reads "<parent>'s budget", several "<a> and
  // <b>'s budgets". The parent's own name carries the possessive's voice.
  const names = open
    .map((sub) => sub.parentAgentName ?? sub.parent_agent_name ?? '')
    .filter((name) => name.length > 0)
  if (names.length === 0) return null
  const subject = [...new Set(names)].join(' and ')
  return `Spends from ${subject}${names.length > 1 ? "'s budgets" : "'s budget"}`
}

/** Does the agent hold at least one budget with a positive cap? */
export function hasConfiguredAllowances(agent: Pick<Agent, 'allowances'>): boolean {
  return (agent.allowances ?? []).some((a) => hasPositiveAllowance(a.allowance_amount))
}

/**
 * The status wording a RECEIVED grant's row carries beside its amount and
 * end (#3988): a pending grant pays nothing yet (the sharing agent has not
 * signed it) and a closing one keeps working until its disable lands — both
 * still listed, because the owner can act on them, but they are not
 * presented as live authority. `null` for the statuses the end label already
 * words ("ends …" / "ended"). ONE copy: the budget-liveness ratchet (#3924)
 * counts status comparisons per file, so the wording lives beside the other
 * budget-authority copy instead of inline in the row component.
 */
export function receivedGrantStatusNote(grant: { status: string }): string | null {
  if (grant.status === 'pending') return 'waiting for the sharing agent to sign it'
  if (grant.status === 'closing') return 'closing'
  return null
}
