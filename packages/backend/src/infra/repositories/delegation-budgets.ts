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

/**
 * The signed delegations for a set of delegation ids (#1145).
 *
 * Deliberately NOT folded into `listActiveDelegations` or the derived budget
 * view: a signed delegation is a capability, and those rows are spread
 * straight into JSON responses — carrying it there would put a redeemable
 * grant one careless spread away from the wire. Callers that genuinely need
 * it (the on-chain remaining-budget read) ask for it explicitly.
 */
export const LIST_DELEGATION_JSON_BY_IDS_SQL = `SELECT id, delegation_json
     FROM agent_delegations
     WHERE id = ANY($1)`

export async function listDelegationJsonByIds(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const result = await pool.query<{ id: string; delegation_json: string }>(
    LIST_DELEGATION_JSON_BY_IDS_SQL,
    [ids],
  )
  return new Map(result.rows.map((r) => [r.id, r.delegation_json]))
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

// ── Payment authorization selection (moved from rails/delegation-authorization.ts, #999)

/**
 * The delegation that authorizes a payment: the ACTIVE row for (agent, token)
 * whose recipient matches, else the agent's ACTIVE open-budget row for that
 * token. A pinned delegation always wins over the open one — the tighter
 * grant is the one the owner meant for that recipient (#829).
 */
export const SELECT_DELEGATION_FOR_PAYMENT_SQL = `SELECT delegation_hash, delegation_json, recipient_address
     FROM agent_delegations
     WHERE agent_id = $1
       AND token_address = LOWER($2)
       AND status = 'active'
       AND (recipient_address = LOWER($3) OR recipient_address IS NULL)
     ORDER BY (recipient_address IS NULL), created_at DESC`

export interface DelegationForPaymentRow {
  delegation_hash: string
  delegation_json: string
  recipient_address: string | null
}

/** `agentId` is the scope: delegations belong to exactly one agent. */
export async function selectDelegationForPayment(
  agentId: string,
  tokenAddress: string,
  toAddress: string,
): Promise<DelegationForPaymentRow | null> {
  const result = await pool.query<DelegationForPaymentRow>(SELECT_DELEGATION_FOR_PAYMENT_SQL, [
    agentId,
    tokenAddress,
    toAddress,
  ])
  return result.rows[0] ?? null
}
