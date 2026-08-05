/**
 * Read side of the delegation budget view (#1090): the ACTIVE
 * `agent_delegations` rows a delegation-rail agent's displayed budget is
 * derived from. Storage access only — the shaping lives in
 * `lib/delegation-budget-view.ts`.
 */

import pool from '../../db.js'

export interface ActiveDelegationRow {
  id: string
  agent_id: string
  chain_id: number
  token_address: string
  budget_atomic: string
  period_seconds: number
}

export async function listActiveDelegations(
  agentIds: string[],
): Promise<ActiveDelegationRow[]> {
  if (agentIds.length === 0) return []
  const result = await pool.query<ActiveDelegationRow>(
    `SELECT id, agent_id, chain_id, token_address, budget_atomic, period_seconds
     FROM agent_delegations
     WHERE agent_id = ANY($1) AND status = 'active'
     ORDER BY created_at ASC`,
    [agentIds],
  )
  return result.rows
}
