/**
 * Budget view for delegation-rail agents (#1090).
 *
 * On the delegation rail the authority IS the active `agent_delegations` row.
 * Every summary surface (agents list, agent detail, dashboard) derives its
 * `allowances` array from the ACTIVE delegations — and since #2020 this is
 * the ONLY source: the `agent_allowances` onboarding mirror this view was
 * built to bypass is retired outright (no reader, no writer; the table drop
 * lands with #1990's follow-through).
 *
 * The derived rows keep the historical `allowances` element shape so no
 * consumer changes: `token_symbol`/decimals come from the chain registry
 * (graceful fallback for unknown tokens — the budget must never disappear
 * because a token is unlisted), `allowance_amount` is the human-formatted
 * budget, `reset_period_min` is the period in minutes.
 *
 * ── This file is the SOLE producer of the human-decimal shape (#2295) ────────
 *
 * `allowance_amount` is one field name over two incompatible wire shapes.
 * `formatTokenValue` below emits the HUMAN-DECIMAL one — `'250.00'` for a
 * 250 USDC budget (it trims trailing zeroes to a two-digit minimum, so the
 * `'250.000000'` quoted in #2283/#2295 is the shape but not the digits), and
 * `'0'` for a zero budget. The connect-setup schemas emit the ATOMIC one,
 * `'250000000'` for the same budget. They are named apart in `openapi/spec.ts` as
 * `allowanceHumanAmount` / `allowanceAtomicAmount` — change the shape emitted
 * here and that schema, and every consumer reading it, is wrong.
 *
 * Everything downstream of this function carries the human shape, on five
 * emitters — the five production call sites of this file, and no others
 * (#2392 re-counted them; an earlier version of this list named a
 * `PATCH /agents/{id}` that has never existed): `GET /agents`,
 * `GET /agents/{id}` and `PUT /agents/{id}` (`routes/agents.ts`),
 * `GET /dashboard/overview` (`routes/dashboard.ts`, as `allowanceAmount`), and
 * `GET /machine-payments/allowances` (`modules/mpp/allowances.ts`, as
 * `configured_amount`). `POST /agents` is NOT a caller: it answers with a
 * literal `allowances: []` under the same `Agent` schema, so a change here
 * cannot reach it and it is pinned to the spec on its own. Note the last one
 * reports the SAME budget twice — `configured_amount` human, `onchain.amount`
 * atomic from `budget_atomic` — so a consumer that mixes them up is off by
 * `10 ** decimals`.
 *
 * `DerivedDelegationBudget.budget_atomic` is the atomic escape hatch: any
 * consumer doing ARITHMETIC on a budget should take that field, never parse
 * `allowance_amount` back.
 *
 * Read/reporting path ONLY: enforcement stays the on-chain delegation.
 */

import { getChainData } from '@haven_ai/core'
import { formatTokenValue } from '../domain/tokens.js'
import { listActiveDelegations } from '../infra/repositories/delegation-budgets.js'

export interface DerivedAllowance {
  id: string
  agent_id: string
  token_address: string
  token_symbol: string
  allowance_amount: string
  reset_period_min: number
}

/**
 * The same derived row plus the raw atomic budget (#1135): the agent-facing
 * `/machine-payments/allowances` endpoint reports remaining spend authority in
 * atomic units, so it needs the budget before formatting. ONE derivation —
 * {@link deriveDelegationAllowances} is a projection of this.
 */
export interface DerivedDelegationBudget extends DerivedAllowance {
  chain_id: number
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
 * The full budget view for a set of delegation-rail agents, derived from
 * their ACTIVE delegations. Agents with no active delegation map to an empty
 * array (post-revoke the views correctly say "no budget set").
 */
export async function deriveDelegationBudgets(
  agentIds: string[],
): Promise<Map<string, DerivedDelegationBudget[]>> {
  const derived = new Map<string, DerivedDelegationBudget[]>()
  if (agentIds.length === 0) return derived
  const rows = await listActiveDelegations(agentIds)
  for (const row of rows) {
    const { symbol, decimals } = tokenView(row.chain_id, row.token_address)
    const existing = derived.get(row.agent_id) ?? []
    existing.push({
      id: row.id,
      agent_id: row.agent_id,
      chain_id: row.chain_id,
      token_address: row.token_address,
      token_symbol: symbol,
      allowance_amount: formatTokenValue(row.budget_atomic, decimals),
      reset_period_min: Math.round(row.period_seconds / 60),
      budget_atomic: row.budget_atomic,
      period_seconds: row.period_seconds,
    })
    derived.set(row.agent_id, existing)
  }
  return derived
}

/**
 * The allowances-shaped projection the dashboard/agents surfaces consume —
 * kept byte-identical to the pre-#1135 shape (their responses spread these
 * rows straight into JSON, so extra fields here would leak into their wire
 * contract).
 */
export async function deriveDelegationAllowances(
  agentIds: string[],
): Promise<Map<string, DerivedAllowance[]>> {
  const rich = await deriveDelegationBudgets(agentIds)
  const narrow = new Map<string, DerivedAllowance[]>()
  for (const [agentId, rows] of rich) {
    narrow.set(
      agentId,
      rows.map(({ id, agent_id, token_address, token_symbol, allowance_amount, reset_period_min }) => ({
        id,
        agent_id,
        token_address,
        token_symbol,
        allowance_amount,
        reset_period_min,
      })),
    )
  }
  return narrow
}
