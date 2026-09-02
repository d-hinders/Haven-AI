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

// #2413: the same delegation-rail filter the account and agent lists carry.
// Missed in the first pass and caught in review, with a real consequence: the
// dashboard counted legacy accounts in "Active accounts" and rendered legacy
// agents in "Connected agents" LINKING to /agents/:id — a link that 404s,
// because the list AgentDetailClient reads from is filtered. An inconsistent
// funnel is worse than an unfiltered one.
export const LIST_DASHBOARD_SAFES_SQL = `SELECT id, safe_address, chain_id, name, is_default
         FROM user_safes
         WHERE user_id = $1 AND account_type = 'delegator_hybrid'
         ORDER BY created_at ASC`

export const LIST_DASHBOARD_AGENTS_SQL = `SELECT a.id, a.name, a.status, a.safe_id, us.name AS safe_name, us.chain_id AS safe_chain_id,
                us.account_type
         FROM agents a
         LEFT JOIN user_safes us ON us.id = a.safe_id
         WHERE a.user_id = $1 AND us.account_type = 'delegator_hybrid'
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

// #2055: the approval_requests EXISTS branch is gone with the table — a
// confirmed payment intent is the only payment record now.
export const HAS_FIRST_AGENT_PAYMENT_SQL = `SELECT EXISTS (
           SELECT 1
           FROM payment_intents
           WHERE user_id = $1
             AND status = 'confirmed'
             AND tx_hash IS NOT NULL
         ) AS has_first_agent_payment`

/**
 * `userId` is REQUIRED — tenant scope for the onboarding milestone.
 *
 * Authoritative on PAYMENT RECORDS: a confirmed intent with a tx_hash
 * (#2055 removed the executed-approval half with its table). Anything softer
 * (an agent existing, an allowance granted) would mark the milestone reached
 * before money ever moved.
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
// #2020: `LIST_DASHBOARD_ALLOWANCES_SQL` / `listDashboardAllowances` are gone —
// the dashboard shows the active delegation set for delegation-rail agents and
// nothing for the retired legacy rail; `agent_allowances` is never read. The
// `DashboardAllowanceRow` shape stays: it is the wire shape the derived
// delegation view fills.

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

/** `userId` is REQUIRED — month-to-date spend is per-tenant. */
export async function sumMonthlyPaymentSpend(
  userId: string,
  db: Executor = pool,
): Promise<MonthlySpendRow[]> {
  const result = await db.query<MonthlySpendRow>(SUM_MONTHLY_PAYMENT_SPEND_SQL, [userId])
  return result.rows
}

// #2055: `SUM_MONTHLY_APPROVAL_SPEND_SQL` / `sumMonthlyApprovalSpend` are
// gone with `approval_requests` — monthly spend is payment_intents alone.
