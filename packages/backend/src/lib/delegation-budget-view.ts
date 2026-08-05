/**
 * Budget view for delegation-rail agents (#1090).
 *
 * On the delegation rail the authority IS the active `agent_delegations` row;
 * `agent_allowances` is written once at connection setup and never updated —
 * a frozen onboarding mirror. Every summary surface (agents list, agent
 * detail, dashboard) must therefore derive its `allowances` array from the
 * ACTIVE delegations, or it renders the budget the user granted at onboarding
 * forever, whatever they changed it to since.
 *
 * The derived rows keep the exact `agent_allowances` element shape so no
 * consumer changes: `token_symbol`/decimals come from the chain registry
 * (graceful fallback for unknown tokens — the budget must never disappear
 * because a token is unlisted), `allowance_amount` is the human-formatted
 * budget, `reset_period_min` is the period in minutes.
 *
 * Read/reporting path ONLY: enforcement stays the on-chain delegation
 * (`routes/payments.ts` never consults `agent_allowances` on this rail).
 */

import pool from '../db.js'
import { getChainData } from '@haven_ai/core'
import { formatTokenValue } from './tokens.js'

export interface DerivedAllowance {
  id: string
  agent_id: string
  token_address: string
  token_symbol: string
  allowance_amount: string
  reset_period_min: number
}

interface ActiveDelegationRow {
  id: string
  agent_id: string
  chain_id: number
  token_address: string
  budget_atomic: string
  period_seconds: number
}

function tokenView(chainId: number, tokenAddress: string): { symbol: string; decimals: number } {
  try {
    const token = getChainData(chainId).tokens.find(
      (t) => t.address !== null && t.address.toLowerCase() === tokenAddress.toLowerCase(),
    )
    if (token) return { symbol: token.symbol, decimals: token.decimals }
  } catch {
    // Unknown chain — fall through to the generic view.
  }
  // Unlisted token: still show the budget. 18 decimals is the ERC-20 default;
  // a wrong scale beats a silently missing budget row.
  return { symbol: 'TOKEN', decimals: 18 }
}

/**
 * The allowances-shaped budget view for a set of delegation-rail agents,
 * derived from their ACTIVE delegations. Agents with no active delegation map
 * to an empty array (post-revoke the views correctly say "no budget set").
 */
export async function deriveDelegationAllowances(
  agentIds: string[],
): Promise<Map<string, DerivedAllowance[]>> {
  const derived = new Map<string, DerivedAllowance[]>()
  if (agentIds.length === 0) return derived
  const result = await pool.query<ActiveDelegationRow>(
    `SELECT id, agent_id, chain_id, token_address, budget_atomic, period_seconds
     FROM agent_delegations
     WHERE agent_id = ANY($1) AND status = 'active'
     ORDER BY created_at ASC`,
    [agentIds],
  )
  for (const row of result.rows) {
    const { symbol, decimals } = tokenView(row.chain_id, row.token_address)
    const existing = derived.get(row.agent_id) ?? []
    existing.push({
      id: row.id,
      agent_id: row.agent_id,
      token_address: row.token_address,
      token_symbol: symbol,
      allowance_amount: formatTokenValue(row.budget_atomic, decimals),
      reset_period_min: Math.round(row.period_seconds / 60),
    })
    derived.set(row.agent_id, existing)
  }
  return derived
}
