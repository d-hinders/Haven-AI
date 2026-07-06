/**
 * Agent recipient allowlist accessor (#784 decision: alternative A).
 *
 * One row per (agent, token, recipient) in `agent_recipients` — the stored
 * policy input the session rail needs to recompute its deterministic session
 * matrix (N recipients × M periods, #769) statelessly. This module is the ONE
 * place that resolves the budget-inheritance rule: a row with a NULL
 * `budget_amount` inherits the agent's full token allowance
 * (`agent_allowances.allowance_amount`), so the common single-recipient case
 * needs no per-row budget. The on-chain truth is always the per-row figure —
 * budgets never aggregate across recipient-sessions (the #784 sharp edge).
 *
 * Default-empty: an agent with no rows gets `[]` — callers treat that as
 * "no stored recipient policy" and keep their current behavior.
 */

import pool from '../db.js'

export interface AgentRecipient {
  recipientAddress: string
  tokenAddress: string
  label: string | null
  /** Resolved per-recipient budget in atomic units (inheritance applied). */
  budgetAtomic: bigint
}

/**
 * The agent's stored recipients for one token, budgets resolved. Ordered by
 * creation so the session matrix is stable across calls (determinism matters:
 * the schedule recomputes sessions from this list).
 */
export async function loadAgentRecipients(
  agentId: string,
  tokenAddress: string,
): Promise<AgentRecipient[]> {
  const result = await pool.query<{
    recipient_address: string
    token_address: string
    label: string | null
    budget_amount: string | null
    allowance_amount: string | null
  }>(
    `SELECT r.recipient_address, r.token_address, r.label, r.budget_amount,
            a.allowance_amount
     FROM agent_recipients r
     LEFT JOIN agent_allowances a
       ON a.agent_id = r.agent_id AND a.token_address = r.token_address
     WHERE r.agent_id = $1 AND LOWER(r.token_address) = LOWER($2)
     ORDER BY r.created_at, r.id`,
    [agentId, tokenAddress],
  )

  return result.rows.map((row) => ({
    recipientAddress: row.recipient_address,
    tokenAddress: row.token_address,
    label: row.label,
    budgetAtomic: BigInt(row.budget_amount ?? row.allowance_amount ?? '0'),
  }))
}
