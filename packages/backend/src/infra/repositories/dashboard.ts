/**
 * Data access for the dashboard overview aggregate — the nine reads (and one
 * write) behind `GET /dashboard/overview`.
 *
 * Extracted verbatim from `routes/dashboard.ts` (#1167) so
 * `scripts/db-schema-smoke.ts` can PREPARE every statement against the real
 * schema. Convention: `README.md` in this directory.
 *
 * Why its own file rather than spread across `user-safes.ts` / `agents.ts`:
 * these are dashboard PROJECTIONS, not the canonical shape of those
 * aggregates. The Safe list here drops `created_at` and the agent list is a
 * preview join carrying `safe_name`/`safe_chain_id` — folding them into the
 * owning repositories would either widen those statements for every caller or
 * leave near-duplicates sitting next to each other. #999 recorded the specific
 * version of that trap: `agents.test.ts` pins every `user_safes` JOIN in
 * `agents.ts` to select `account_type`, so a non-payload join added there
 * acquires a test contract it was never meant to answer to.
 *
 * Invariants a reader must not break:
 *
 * - Every statement here is tenant-scoped, and `userId` is a REQUIRED first
 *   parameter — except `listAllowancesForAgents`, which is scoped by the agent
 *   ids the CALLER has already read under its own `user_id` filter. Passing it
 *   ids from anywhere else would read another tenant's budgets.
 * - The snapshot write is `DO NOTHING`: today's row is written once and never
 *   revised, so the day-over-day change compares two settled figures rather
 *   than a moving one.
 *
 * **The SQL here is verbatim from the route.** Anything that looked improvable
 * was left alone and reported in the pull request instead.
 */

import pool from '../../db.js'
import type { Executor } from '../transaction.js'

export type { Executor }

// ── Row shapes ───────────────────────────────────────────────────────────────

export interface DashboardSafeRow {
  id: string
  safe_address: string
  chain_id: number
  name: string
  is_default: boolean
}

export interface DashboardAgentRow {
  id: string
  name: string
  status: string
  safe_id: string | null
  safe_name: string | null
  safe_chain_id: number | null
  account_type: string | null
}

export interface DashboardAllowanceRow {
  agent_id: string
  token_symbol: string
  allowance_amount: string
  reset_period_min: number
}

export interface PortfolioSnapshotRow {
  snapshot_date: string
  total_usd: string
  total_eur: string
}

export interface MonthlySpendRow {
  token_symbol: string
  usd_sum: string | null
  eur_sum: string | null
  fallback_amount: string | null
}

// ── Accounts + agents ────────────────────────────────────────────────────────

export const LIST_DASHBOARD_SAFES_SQL = `SELECT id, safe_address, chain_id, name, is_default
         FROM user_safes
         WHERE user_id = $1
         ORDER BY created_at ASC`

export const LIST_DASHBOARD_AGENTS_SQL = `SELECT a.id, a.name, a.status, a.safe_id, us.name AS safe_name, us.chain_id AS safe_chain_id,
                us.account_type
         FROM agents a
         LEFT JOIN user_safes us ON us.id = a.safe_id
         WHERE a.user_id = $1
           AND a.status IN ('active', 'paused')
         ORDER BY
           CASE a.status
             WHEN 'active' THEN 0
             WHEN 'paused' THEN 1
             ELSE 2
           END,
           a.created_at DESC`

/** `userId` is REQUIRED — tenant scope for the account list. */
export async function listDashboardSafes(
  userId: string,
  db: Executor = pool,
): Promise<DashboardSafeRow[]> {
  const result = await db.query<DashboardSafeRow>(LIST_DASHBOARD_SAFES_SQL, [userId])
  return result.rows
}

/**
 * `userId` is REQUIRED — tenant scope for the agent preview.
 *
 * Returns active before paused, newest first within each, and only those two
 * statuses: a revoked agent is absent from the dashboard entirely.
 */
export async function listDashboardAgents(
  userId: string,
  db: Executor = pool,
): Promise<DashboardAgentRow[]> {
  const result = await db.query<DashboardAgentRow>(LIST_DASHBOARD_AGENTS_SQL, [userId])
  return result.rows
}

// ── Counters ─────────────────────────────────────────────────────────────────

export const COUNT_ACTIONABLE_APPROVALS_SQL = `SELECT COUNT(*) AS count
         FROM approval_requests
         WHERE user_id = $1 AND status IN ('pending', 'approved')`

export const HAS_FIRST_AGENT_PAYMENT_SQL = `SELECT (
           EXISTS (
             SELECT 1
             FROM payment_intents
             WHERE user_id = $1
               AND status = 'confirmed'
               AND tx_hash IS NOT NULL
           )
           OR EXISTS (
             SELECT 1
             FROM approval_requests
             WHERE user_id = $1
               AND status = 'executed'
               AND tx_hash IS NOT NULL
           )
         ) AS has_first_agent_payment`

/** `userId` is REQUIRED — tenant scope for the approval queue count. */
export async function countActionableApprovals(
  userId: string,
  db: Executor = pool,
): Promise<number> {
  const result = await db.query<{ count: string }>(COUNT_ACTIONABLE_APPROVALS_SQL, [userId])
  return Number(result.rows[0]?.count ?? '0')
}

/**
 * `userId` is REQUIRED — tenant scope for the onboarding milestone.
 *
 * Authoritative on PAYMENT RECORDS, both rails: a confirmed intent with a
 * tx_hash, or an executed approval with one. Anything softer (an agent
 * existing, an allowance granted) would mark the milestone reached before
 * money ever moved.
 */
export async function hasFirstAgentPayment(
  userId: string,
  db: Executor = pool,
): Promise<boolean> {
  const result = await db.query<{ has_first_agent_payment: boolean }>(
    HAS_FIRST_AGENT_PAYMENT_SQL,
    [userId],
  )
  return Boolean(result.rows[0]?.has_first_agent_payment)
}

// ── Allowances ───────────────────────────────────────────────────────────────

export const LIST_DASHBOARD_ALLOWANCES_SQL = `SELECT agent_id, token_symbol, allowance_amount, reset_period_min
             FROM agent_allowances
             WHERE agent_id = ANY($1)
             ORDER BY created_at ASC`

/**
 * The legacy-rail allowance mirror for a set of agents.
 *
 * NOT tenant-scoped in SQL: `agentIds` comes from `listDashboardAgents`, which
 * is already filtered by `user_id`. The empty-list short-circuit travels with
 * the query — `= ANY('{}')` matches nothing, so issuing it would be a
 * round-trip for a guaranteed-empty result.
 *
 * On the delegation rail this table is a FROZEN onboarding mirror and is not
 * what the dashboard shows; the caller overwrites those agents' entries from
 * the active delegation set (#1090).
 */
export async function listDashboardAllowances(
  agentIds: string[],
  db: Executor = pool,
): Promise<DashboardAllowanceRow[]> {
  if (agentIds.length === 0) return []
  const result = await db.query<DashboardAllowanceRow>(LIST_DASHBOARD_ALLOWANCES_SQL, [agentIds])
  return result.rows
}

// ── Daily portfolio snapshots ────────────────────────────────────────────────

export const FIND_PORTFOLIO_SNAPSHOTS_SQL = `SELECT snapshot_date, total_usd, total_eur
       FROM user_daily_portfolio_snapshots
       WHERE user_id = $1 AND snapshot_date = ANY($2)`

export const INSERT_PORTFOLIO_SNAPSHOT_SQL = `INSERT INTO user_daily_portfolio_snapshots (
           user_id, snapshot_date, total_usd, total_eur, updated_at
         ) VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (user_id, snapshot_date) DO NOTHING`

/** `userId` is REQUIRED — snapshots are per-user. */
export async function findPortfolioSnapshots(
  userId: string,
  snapshotDates: string[],
  db: Executor = pool,
): Promise<PortfolioSnapshotRow[]> {
  const result = await db.query<PortfolioSnapshotRow>(FIND_PORTFOLIO_SNAPSHOTS_SQL, [
    userId,
    snapshotDates,
  ])
  return result.rows
}

/**
 * Record today's portfolio totals. `userId` is REQUIRED.
 *
 * `DO NOTHING` on conflict makes this a first-write-wins baseline rather than
 * a running total: whichever request first loads the dashboard on a given day
 * sets that day's figure, and later loads leave it alone. That is what the
 * day-over-day change depends on — a snapshot that kept being revised would
 * make yesterday's comparison drift.
 */
export async function insertPortfolioSnapshot(
  userId: string,
  snapshotDate: string,
  totalUsd: number,
  totalEur: number,
  db: Executor = pool,
): Promise<void> {
  await db.query(INSERT_PORTFOLIO_SNAPSHOT_SQL, [userId, snapshotDate, totalUsd, totalEur])
}

// ── Month-to-date agent spend ────────────────────────────────────────────────

/**
 * The two month-to-date aggregates are deliberately kept as SEPARATE verbatim
 * statements rather than one parameterised template. They differ in table,
 * status value AND timestamp column (`confirmed_at` vs `executed_at`), so a
 * shared builder would assemble its FROM/WHERE at runtime — and a statement
 * assembled at runtime is one `db-schema-smoke` cannot PREPARE, which is the
 * whole reason this directory exists. `accounting-entry.ts` is already waived
 * for exactly that shape.
 *
 * `fallback_amount` sums the token amount for rows with no usable fiat value,
 * so the caller can price them through the fiat lookup instead of silently
 * counting them as zero.
 */
export const SUM_MONTHLY_PAYMENT_SPEND_SQL = `SELECT token_symbol,
                COALESCE(SUM(usd_value), 0)::TEXT AS usd_sum,
                COALESCE(SUM(eur_value), 0)::TEXT AS eur_sum,
                COALESCE(
                  SUM(
                    CASE
                      WHEN usd_value IS NULL OR eur_value IS NULL
                        OR (
                          COALESCE(usd_value, 0) = 0
                          AND COALESCE(eur_value, 0) = 0
                          AND amount_human::NUMERIC > 0
                        )
                        THEN amount_human::NUMERIC
                      ELSE 0
                    END
                  ),
                  0
                )::TEXT AS fallback_amount
         FROM payment_intents
         WHERE user_id = $1
           AND status = 'confirmed'
           AND confirmed_at >= DATE_TRUNC('month', NOW())
         GROUP BY token_symbol`

export const SUM_MONTHLY_APPROVAL_SPEND_SQL = `SELECT token_symbol,
                COALESCE(SUM(usd_value), 0)::TEXT AS usd_sum,
                COALESCE(SUM(eur_value), 0)::TEXT AS eur_sum,
                COALESCE(
                  SUM(
                    CASE
                      WHEN usd_value IS NULL OR eur_value IS NULL
                        OR (
                          COALESCE(usd_value, 0) = 0
                          AND COALESCE(eur_value, 0) = 0
                          AND amount_human::NUMERIC > 0
                        )
                        THEN amount_human::NUMERIC
                      ELSE 0
                    END
                  ),
                  0
                )::TEXT AS fallback_amount
         FROM approval_requests
         WHERE user_id = $1
           AND status = 'executed'
           AND executed_at >= DATE_TRUNC('month', NOW())
         GROUP BY token_symbol`

/** `userId` is REQUIRED — month-to-date spend is per-tenant. */
export async function sumMonthlyPaymentSpend(
  userId: string,
  db: Executor = pool,
): Promise<MonthlySpendRow[]> {
  const result = await db.query<MonthlySpendRow>(SUM_MONTHLY_PAYMENT_SPEND_SQL, [userId])
  return result.rows
}

/** `userId` is REQUIRED — month-to-date spend is per-tenant. */
export async function sumMonthlyApprovalSpend(
  userId: string,
  db: Executor = pool,
): Promise<MonthlySpendRow[]> {
  const result = await db.query<MonthlySpendRow>(SUM_MONTHLY_APPROVAL_SPEND_SQL, [userId])
  return result.rows
}
