/**
 * Read side of the dashboard's cached budget-remaining route (#3804).
 *
 * Two statements, both USER-SCOPED (`userId` is a REQUIRED first parameter —
 * the same tenant rule `dashboard.ts` records):
 *
 * 1. The set of budgets to show: the user's ACTIVE `agent_delegations` rows.
 *    Read FRESH on every request — nothing here is cached — so issuing,
 *    revoking, replacing, re-keying or removing a budget needs no cache
 *    invalidation. Only the enforcer read in
 *    `modules/dashboard/budget-remaining-cache.ts` is cached, keyed by
 *    `(chain_id, delegation_hash)`.
 *
 * 2. Sub-budget attribution: per parent budget, the confirmed
 *    `payment_intents` spend routed through its sub-budget tree, grouped by
 *    the spending agent, for the parent's CURRENT period. The tree is the
 *    parent-child row (`parent_sub_budget_id IS NULL`,
 *    `parent_delegation_hash` = the budget delegation's hash — migration 100)
 *    plus its grants (`parent_sub_budget_id` = that row). Closed sub-budgets
 *    are INCLUDED — a closed grant's already-confirmed payments still
 *    happened. The figure is a floor: spend that wasn't recorded against a
 *    `sub_budget_id` cannot be attributed.
 *
 * NOT on the money path: nothing here feeds a spend decision — the only
 * caller is the display route (`routes/dashboard-budget-remaining.ts`), and
 * `readRemainingBudget` itself is untouched (it stays the fresh read behind
 * every pre-check, authorisation and payment).
 */

import { getChainData } from '@haven_ai/core'
import pool from '../../db.js'
import { delegationLiveWindowSql } from './delegation-budgets.js'
import type { Executor } from '../transaction.js'

export type { Executor }

// ── The user's budget delegations ────────────────────────────────────────────

export interface DashboardBudgetRow {
  id: string
  agent_id: string
  chain_id: number
  token_address: string
  token_symbol: string
  token_decimals: number
  delegation_hash: string
  budget_atomic: string
  period_seconds: number
  /** Unix-second BIGINTs (node-postgres decodes them as strings). */
  start_date: string
  expires_at: string
}

/**
 * `start_date` is deliberately NOT filtered — the future-dated steady row a
 * re-key writes must stay visible beside its live carry row (#3802 owner
 * decision 2026-10-09). The live-window predicate itself is the shared
 * fragment (#3833) so it cannot drift from the other readers.
 */

export const LIST_DASHBOARD_BUDGET_DELEGATIONS_SQL = `SELECT ad.id, ad.agent_id, ad.chain_id,
         ad.token_address, ad.delegation_hash, ad.budget_atomic, ad.period_seconds,
         ad.start_date::text AS start_date, ad.expires_at::text AS expires_at
       FROM agent_delegations ad
       JOIN agents a ON a.id = ad.agent_id
       JOIN smart_accounts sa ON sa.id = a.account_id AND sa.account_type = 'delegator_hybrid'
       WHERE a.user_id = $1
         AND ad.status = 'active'
         AND (${delegationLiveWindowSql('ad')})
       ORDER BY ad.created_at ASC`

/**
 * The budget rows the dashboard shows, freshest read every call. Token
 * symbol/decimals resolve from the chain registry like
 * `analytics.ts`'s `tokenSymbolFor`; an unknown token address degrades to a
 * truncated address symbol rather than dropping the row (a budget the
 * registry cannot name is still a budget the user owns).
 */
export async function listDashboardBudgetDelegations(
  userId: string,
  db: Executor = pool,
): Promise<DashboardBudgetRow[]> {
  const result = await db.query<Omit<DashboardBudgetRow, 'token_symbol' | 'token_decimals'>>(
    LIST_DASHBOARD_BUDGET_DELEGATIONS_SQL,
    [userId],
  )
  return result.rows.map((row) => {
    let symbol = `${row.token_address.slice(0, 6)}…`
    let decimals = 18
    try {
      const token = getChainData(row.chain_id).tokens.find(
        (t) => t.address !== null && t.address.toLowerCase() === row.token_address.toLowerCase(),
      )
      if (token) {
        symbol = token.symbol
        decimals = token.decimals
      }
    } catch {
      // Unknown chain — keep the degraded symbol.
    }
    return { ...row, token_symbol: symbol, token_decimals: decimals }
  })
}

// ── Sub-budget attribution ───────────────────────────────────────────────────

export interface SubBudgetSpendRow {
  agent_id: string
  spent_atomic: string
}

/**
 * Confirmed payment_intents spend through ONE parent budget's sub-budget
 * tree, grouped by spending agent, inside the half-open window
 * `[windowStartSec, windowEndSec)` — the caller passes the parent's CURRENT
 * period bounds (`currentPeriodBounds`), so the window logic lives in exactly
 * one place. `confirmed_at` is the instant the payment actually settled;
 * `created_at` would count intents that never landed.
 */
export const SUB_BUDGET_SPEND_FOR_BUDGET_SQL = `WITH tree AS (
         SELECT pc.id AS sub_budget_id, pc.agent_id
         FROM agent_sub_budgets pc
         WHERE pc.parent_sub_budget_id IS NULL AND pc.parent_delegation_hash = $1
         UNION ALL
         SELECT g.id, g.agent_id
         FROM agent_sub_budgets g
         JOIN agent_sub_budgets pc ON pc.id = g.parent_sub_budget_id
         WHERE pc.parent_sub_budget_id IS NULL AND pc.parent_delegation_hash = $1
       )
       SELECT t.agent_id, COALESCE(SUM(pi.amount_raw::numeric), 0)::text AS spent_atomic
       FROM tree t
       JOIN payment_intents pi ON pi.sub_budget_id = t.sub_budget_id
       WHERE pi.status = 'confirmed'
         AND pi.confirmed_at IS NOT NULL
         AND pi.confirmed_at >= to_timestamp($2)
         AND pi.confirmed_at < to_timestamp($3)
       GROUP BY t.agent_id
       ORDER BY t.agent_id ASC`

export async function listSubBudgetSpend(
  budgetDelegationHash: string,
  windowStartSec: number,
  windowEndSec: number,
  db: Executor = pool,
): Promise<SubBudgetSpendRow[]> {
  if (windowEndSec <= windowStartSec) return []
  const result = await db.query<SubBudgetSpendRow>(SUB_BUDGET_SPEND_FOR_BUDGET_SQL, [
    budgetDelegationHash,
    windowStartSec,
    windowEndSec,
  ])
  return result.rows
}
