/**
 * Data access for the dashboard overview aggregate — the nine reads (and one
 * write) behind `GET /dashboard/overview`.
 *
 * Extracted verbatim from `routes/dashboard.ts` (#1167) so
 * `scripts/db-schema-smoke.ts` can PREPARE every statement against the real
 * schema. Convention: `README.md` in this directory.
 *
 * Why its own file rather than spread across `smart-accounts.ts` / `agents.ts`:
 * these are dashboard PROJECTIONS, not the canonical shape of those
 * aggregates. The Safe list here drops `created_at` and the agent list is a
 * preview join carrying `account_name`/`account_chain_id` — folding them into the
 * owning repositories would either widen those statements for every caller or
 * leave near-duplicates sitting next to each other. #999 recorded the specific
 * version of that trap: `agents.test.ts` pins every `smart_accounts` JOIN in
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
import { DELEGATION_RAIL_JOIN, spendNetFactorSql } from './analytics.js'

export type { Executor }

// ── Row shapes ───────────────────────────────────────────────────────────────

export interface DashboardAccountRow {
  id: string
  account_address: string
  chain_id: number
  name: string
  is_default: boolean
  /** #3803: raw signer-set input for `needsBackupSignerRecommendation`. */
  owner_address: string | null
  passkey_count: number
}

export interface DashboardAgentRow {
  id: string
  name: string
  status: string
  account_id: string | null
  account_name: string | null
  account_chain_id: number | null
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
  /**
   * NULL on days snapshotted before migration 090 (the column was added
   * NULLABLE, deliberately without a 0 default): a COALESCE'd zero would read
   * that absence as a real SEK total and fabricate a -100% day-over-day
   * change. The dashboard reports "change unavailable" for such days instead.
   */
  total_sek: string | null
}

export interface MonthlySpendRow {
  token_symbol: string
  usd_sum: string | null
  eur_sum: string | null
  sek_sum: string | null
  fallback_amount: string | null
  /**
   * Rows with no usable booked SEK — `sek_value` NULL, or a booked zero
   * beside a real token amount (#3195). The same shapes `fallback_amount`
   * collects for USD/EUR; a backfilled row is priced and never collected.
   */
  fallback_amount_sek: string | null
}

// ── Accounts + agents ────────────────────────────────────────────────────────

// #2413: the same delegation-rail filter the account and agent lists carry.
// Missed in the first pass and caught in review, with a real consequence: the
// dashboard counted legacy accounts in "Active accounts" and rendered legacy
// agents in "Connected agents" LINKING to /agents/:id — a link that 404s,
// because the list AgentDetailClient reads from is filtered. An inconsistent
// funnel is worse than an unfiltered one.
// #3803: `owner_address` + the hybrid passkey COUNT join the select so the
// route can answer `needs_backup_recommendation` PER ACCOUNT (today the
// client reads it only off `accounts[0]` of the session payload). Same
// LEFT JOIN + GROUP BY shape as `LIST_SESSION_ACCOUNTS_FOR_USER_SQL` — a
// GROUP BY derived table would hash-aggregate the whole passkey table.
export const LIST_DASHBOARD_ACCOUNTS_SQL = `SELECT us.id, us.account_address, us.chain_id, us.name, us.is_default,
                us.owner_address,
                COUNT(hap.id)::int AS passkey_count
         FROM smart_accounts us
         LEFT JOIN hybrid_account_passkeys hap ON hap.account_id = us.id
         WHERE us.user_id = $1 AND us.account_type = 'delegator_hybrid'
         GROUP BY us.id
         ORDER BY us.created_at ASC`

export const LIST_DASHBOARD_AGENTS_SQL = `SELECT a.id, a.name, a.status, a.account_id, us.name AS account_name, us.chain_id AS account_chain_id,
                us.account_type
         FROM agents a
         LEFT JOIN smart_accounts us ON us.id = a.account_id
         WHERE a.user_id = $1 AND us.account_type = 'delegator_hybrid'
           AND a.status IN ('active', 'paused', 'pending_approval')
         ORDER BY
           CASE a.status
             WHEN 'active' THEN 0
             WHEN 'paused' THEN 1
             ELSE 2
           END,
           a.created_at DESC`

/** `userId` is REQUIRED — tenant scope for the account list. */
export async function listDashboardAccounts(
  userId: string,
  db: Executor = pool,
): Promise<DashboardAccountRow[]> {
  const result = await db.query<DashboardAccountRow>(LIST_DASHBOARD_ACCOUNTS_SQL, [userId])
  return result.rows
}

/**
 * `userId` is REQUIRED — tenant scope for the agent preview.
 *
 * #3803: returns EVERY delegation-rail agent in `active`, `paused` or
 * `pending_approval` — the preview cap moved to the client, and a
 * `pending_approval` agent is exactly the one the redesigned overview must
 * show (with its connection-setup state). Ordering stays active, paused,
 * then the rest, newest first within each. Revoked agents remain absent:
 * #3805's client slice owns how history is reached.
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

export const FIND_PORTFOLIO_SNAPSHOTS_SQL = `SELECT snapshot_date, total_usd, total_eur, total_sek
       FROM user_daily_portfolio_snapshots
       WHERE user_id = $1 AND snapshot_date = ANY($2)`

export const INSERT_PORTFOLIO_SNAPSHOT_SQL = `INSERT INTO user_daily_portfolio_snapshots (
           user_id, snapshot_date, total_usd, total_eur, total_sek, updated_at
         ) VALUES ($1, $2, $3, $4, $5, NOW())
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
 * a running total: the first CLEAN dashboard load on a given day sets that
 * day's figure (#3296 — a load whose portfolio read is unpriceable skips the
 * insert instead of pinning a degraded figure on the day), and later loads
 * leave it alone. That is what the
 * day-over-day change depends on — a snapshot that kept being revised would
 * make yesterday's comparison drift.
 */
export async function insertPortfolioSnapshot(
  userId: string,
  snapshotDate: string,
  totalUsd: number,
  totalEur: number,
  totalSek: number,
  db: Executor = pool,
): Promise<void> {
  await db.query(INSERT_PORTFOLIO_SNAPSHOT_SQL, [userId, snapshotDate, totalUsd, totalEur, totalSek])
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
 * `fallback_amount` sums the token amount for rows with no usable USD/EUR
 * value, so the caller can price them through the fiat lookup instead of
 * silently counting them as zero. `fallback_amount_sek` is the SEK twin with
 * the SAME two-pronged predicate (#3195 — narrowed per row, never per
 * bucket): a row is collected when its `sek_value` is NULL, or when it is a
 * booked zero beside a real token amount. Migration 090 backfills
 * `sek_value` from the book-time evidence, so a backfilled row is already
 * priced — a predicate that cannot see `sek_value` would hand that row to
 * the fiat lookup AGAIN, double-counting every backfilled row (measured 21
 * where the truth was 10.5). The zero prong is the #3195 mirror: the confirm
 * path books `0` for an unquoted token (`prices.ts` `zeroPrice()`), so a
 * 0/0/0 row must be re-priced into SEK exactly as the USD/EUR predicate
 * already re-prices it — a NULL-only SEK bucket read "Monthly agent spend"
 * lower under SEK than under USD for the same rows. The row shapes are
 * still independent: a backfilled row needs the USD/EUR re-price but not the
 * SEK one, so neither bucket subsumes the other.
 */
export const SUM_MONTHLY_PAYMENT_SPEND_SQL = `SELECT token_symbol,
                COALESCE(SUM(usd_value), 0)::TEXT AS usd_sum,
                COALESCE(SUM(eur_value), 0)::TEXT AS eur_sum,
                COALESCE(SUM(sek_value), 0)::TEXT AS sek_sum,
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
                )::TEXT AS fallback_amount,
                COALESCE(
                  SUM(
                    CASE
                      WHEN sek_value IS NULL
                        OR (sek_value = 0 AND amount_human::NUMERIC > 0)
                        THEN amount_human::NUMERIC
                      ELSE 0
                    END
                  ),
                  0
                )::TEXT AS fallback_amount_sek
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

// ── #3803: the redesigned dashboard's data ───────────────────────────────────
//
// One grouped statement per section, never a per-agent loop — the same
// performance posture `analytics.ts` commits to. Every statement is
// tenant-scoped (`userId` required first parameter) and rail-scoped via the
// shared `DELEGATION_RAIL_JOIN`, and every new netting consumer takes
// `spendNetFactorSql` rather than a fourth verbatim copy of the ratio.

/** The newest connection setup per agent — the `setupStatus` a pending agent carries (#3803 owner decision 2). */
export const PENDING_AGENT_SETUP_STATUSES_SQL = `SELECT DISTINCT ON (s.agent_id)
         s.agent_id, s.status
  FROM agent_connection_setups s
  JOIN agents a ON a.id = s.agent_id
  WHERE a.user_id = $1 AND s.agent_id = ANY($2)
  ORDER BY s.agent_id, s.created_at DESC`

export interface PendingAgentSetupStatusRow {
  agent_id: string
  status: string
}

/** `userId` is REQUIRED; `agentIds` must have been read under the same tenant. */
export async function listPendingAgentSetupStatuses(
  userId: string,
  agentIds: string[],
  db: Executor = pool,
): Promise<Map<string, string>> {
  if (agentIds.length === 0) return new Map()
  const result = await db.query<PendingAgentSetupStatusRow>(
    PENDING_AGENT_SETUP_STATUSES_SQL,
    [userId, agentIds],
  )
  return new Map(result.rows.map((r) => [r.agent_id, r.status]))
}

/**
 * Sub-budget grants an agent RECEIVED — `{ parentAgentId, parentAgentName,
 * open }` per row (#3803), so an agent whose only authority is a received
 * sub-budget does not read "No budget". `open` is the stored `status =
 * 'open'`; `pending`/`closing`/`closed` grant rows report `open = false`
 * rather than being dropped, because a pending grant is still authority the
 * owner can act on.
 */
export const RECEIVED_SUB_BUDGETS_FOR_AGENTS_SQL = `SELECT asb.agent_id,
         asb.parent_agent_id,
         pa.name AS parent_agent_name,
         (asb.status = 'open') AS open
  FROM agent_sub_budgets asb
  JOIN agents pa ON pa.id = asb.parent_agent_id
  JOIN agents a ON a.id = asb.agent_id
  WHERE a.user_id = $1
    AND asb.agent_id = ANY($2)`

export interface ReceivedSubBudgetRow {
  agent_id: string
  parent_agent_id: string
  parent_agent_name: string
  open: boolean
}

/** `userId` is REQUIRED; `agentIds` must have been read under the same tenant. */
export async function listReceivedSubBudgetsForAgents(
  userId: string,
  agentIds: string[],
  db: Executor = pool,
): Promise<ReceivedSubBudgetRow[]> {
  if (agentIds.length === 0) return []
  const result = await db.query<ReceivedSubBudgetRow>(
    RECEIVED_SUB_BUDGETS_FOR_AGENTS_SQL,
    [userId, agentIds],
  )
  return result.rows
}

/**
 * The 7/30-day spend block, per (agent, token, chain) GROUP — one statement
 * for the whole section (#3803). The route aggregates the groups per agent
 * and user-level in application code, because owner decision 1 prices
 * NULL-booked-fiat rows at TODAY's rate (`infra/prices.ts`, app-side) and the
 * per-token rate must be applied before groups collapse: a SQL
 * `GROUPING SETS` rollup would fold the token identity away and force a
 * fourth netting copy to price the fallback.
 *
 * Windows are `[now − N×24h, now)` on `confirmed_at` — $2 = 30-day start,
 * $3 = 7-day start, $4 = now — the same half-open shape `/analytics/overview`
 * uses. Rows are `status = 'confirmed'`, delegation-rail agents only,
 * chain-scoped to $5 (the testnet-scope decision: the chains the figures
 * cover). `fb_*` collects the token amount of rows whose booked fiat is NULL
 * per currency, so the caller can price them at today's rate and mark the
 * total "≈". `payments_*` stay gross — activity, not money kept.
 *
 * `pace_atomic` is the per-(agent, token, chain) USDC pace:
 * `confirmed_7d − min(swept_all, confirmed_7d)`. The sweep leg carries NO
 * window (the issue's pace definition is literal: `status = 'submitted' AND
 * tx_hash IS NOT NULL`), so a clawback anywhere in the group's history
 * reduces today's pace; `min` caps the subtraction at 0. Route-side this is
 * kept only for (chain, token) pairs the chain registry names as USDC.
 */
export const DASHBOARD_SPEND_GROUPS_SQL = `WITH legs AS (
    SELECT pi.agent_id,
           LOWER(pi.token_address) AS token_key,
           COALESCE(pi.chain_id, 0) AS chain_key,
           CASE WHEN pi.amount_raw ~ '^[0-9]+$' THEN pi.amount_raw::numeric END AS atomic,
           COALESCE(pi.amount_human, '0')::numeric AS amount_human,
           pi.usd_value,
           pi.eur_value,
           pi.sek_value,
           (pi.confirmed_at >= $3) AS in_7d
    FROM payment_intents pi
    JOIN agents a ON a.id = pi.agent_id
    ${DELEGATION_RAIL_JOIN}
    WHERE pi.user_id = $1
      AND pi.status = 'confirmed'
      AND pi.confirmed_at >= $2
      AND pi.confirmed_at < $4
      AND COALESCE(pi.chain_id, 0) = ANY($5)
  ), swept AS (
    SELECT ds.agent_id,
           LOWER(ds.token_address) AS token_key,
           ds.chain_id AS chain_key,
           SUM(ds.value_atomic) FILTER (WHERE COALESCE(ds.submitted_at, ds.created_at) >= $3
                                          AND COALESCE(ds.submitted_at, ds.created_at) < $4) AS swept_7,
           SUM(ds.value_atomic) FILTER (WHERE COALESCE(ds.submitted_at, ds.created_at) >= $2
                                          AND COALESCE(ds.submitted_at, ds.created_at) < $4) AS swept_30,
           SUM(ds.value_atomic) AS swept_all
    FROM delegate_sweeps ds
    WHERE ds.user_id = $1
      AND ds.status = 'submitted'
      AND ds.tx_hash IS NOT NULL
      AND COALESCE(ds.chain_id, 0) = ANY($5)
    GROUP BY ds.agent_id, LOWER(ds.token_address), ds.chain_id
  ), grouped AS (
    SELECT l.agent_id, l.token_key, l.chain_key,
           SUM(l.atomic) FILTER (WHERE l.in_7d) AS atomic_7,
           SUM(l.atomic) AS atomic_30,
           SUM(COALESCE(l.usd_value, 0)) FILTER (WHERE l.in_7d) AS usd_7,
           SUM(COALESCE(l.eur_value, 0)) FILTER (WHERE l.in_7d) AS eur_7,
           SUM(COALESCE(l.sek_value, 0)) FILTER (WHERE l.in_7d) AS sek_7,
           SUM(COALESCE(l.usd_value, 0)) AS usd_30,
           SUM(COALESCE(l.eur_value, 0)) AS eur_30,
           SUM(COALESCE(l.sek_value, 0)) AS sek_30,
           SUM(CASE WHEN l.in_7d AND l.usd_value IS NULL THEN l.amount_human ELSE 0 END) AS fb_usd_7,
           SUM(CASE WHEN l.in_7d AND l.eur_value IS NULL THEN l.amount_human ELSE 0 END) AS fb_eur_7,
           SUM(CASE WHEN l.in_7d AND l.sek_value IS NULL THEN l.amount_human ELSE 0 END) AS fb_sek_7,
           SUM(CASE WHEN l.usd_value IS NULL THEN l.amount_human ELSE 0 END) AS fb_usd_30,
           SUM(CASE WHEN l.eur_value IS NULL THEN l.amount_human ELSE 0 END) AS fb_eur_30,
           SUM(CASE WHEN l.sek_value IS NULL THEN l.amount_human ELSE 0 END) AS fb_sek_30,
           COUNT(*) FILTER (WHERE l.in_7d) AS legs_7,
           COUNT(*) AS legs_30
    FROM legs l
    GROUP BY l.agent_id, l.token_key, l.chain_key
  )
  SELECT g.agent_id, g.token_key, g.chain_key,
         COALESCE(g.usd_7, 0)::text AS gross_usd_7,
         (COALESCE(g.usd_7, 0) * ${spendNetFactorSql('g.atomic_7', 's.swept_7')})::numeric(20, 6)::text AS net_usd_7,
         COALESCE(g.eur_7, 0)::text AS gross_eur_7,
         (COALESCE(g.eur_7, 0) * ${spendNetFactorSql('g.atomic_7', 's.swept_7')})::numeric(20, 6)::text AS net_eur_7,
         COALESCE(g.sek_7, 0)::text AS gross_sek_7,
         (COALESCE(g.sek_7, 0) * ${spendNetFactorSql('g.atomic_7', 's.swept_7')})::numeric(20, 6)::text AS net_sek_7,
         COALESCE(g.fb_usd_7, 0)::text AS fb_usd_7,
         COALESCE(g.fb_eur_7, 0)::text AS fb_eur_7,
         COALESCE(g.fb_sek_7, 0)::text AS fb_sek_7,
         COALESCE(g.usd_30, 0)::text AS gross_usd_30,
         (COALESCE(g.usd_30, 0) * ${spendNetFactorSql('g.atomic_30', 's.swept_30')})::numeric(20, 6)::text AS net_usd_30,
         COALESCE(g.eur_30, 0)::text AS gross_eur_30,
         (COALESCE(g.eur_30, 0) * ${spendNetFactorSql('g.atomic_30', 's.swept_30')})::numeric(20, 6)::text AS net_eur_30,
         COALESCE(g.sek_30, 0)::text AS gross_sek_30,
         (COALESCE(g.sek_30, 0) * ${spendNetFactorSql('g.atomic_30', 's.swept_30')})::numeric(20, 6)::text AS net_sek_30,
         COALESCE(g.fb_usd_30, 0)::text AS fb_usd_30,
         COALESCE(g.fb_eur_30, 0)::text AS fb_eur_30,
         COALESCE(g.fb_sek_30, 0)::text AS fb_sek_30,
         g.legs_7::text AS payments_7,
         g.legs_30::text AS payments_30,
         (COALESCE(g.atomic_7, 0) - LEAST(COALESCE(s.swept_all, 0), COALESCE(g.atomic_7, 0)))::text AS pace_atomic
  FROM grouped g
  LEFT JOIN swept s
    ON s.agent_id = g.agent_id
   AND s.token_key = g.token_key
   AND s.chain_key = g.chain_key`

export interface DashboardSpendGroupRow {
  agent_id: string
  token_key: string
  chain_key: number
  gross_usd_7: string
  net_usd_7: string
  gross_eur_7: string
  net_eur_7: string
  gross_sek_7: string
  net_sek_7: string
  fb_usd_7: string
  fb_eur_7: string
  fb_sek_7: string
  gross_usd_30: string
  net_usd_30: string
  gross_eur_30: string
  net_eur_30: string
  gross_sek_30: string
  net_sek_30: string
  fb_usd_30: string
  fb_eur_30: string
  fb_sek_30: string
  payments_7: string
  payments_30: string
  pace_atomic: string
}

/**
 * `userId` is REQUIRED. `chainIds` is the testnet-scope chain set (owner
 * decision 3); `from30`/`from7`/`to` are ISO timestamps, `[from, to)` shape.
 */
export async function listDashboardSpendGroups(
  userId: string,
  chainIds: number[],
  from30: string,
  from7: string,
  to: string,
  db: Executor = pool,
): Promise<DashboardSpendGroupRow[]> {
  const result = await db.query<DashboardSpendGroupRow>(DASHBOARD_SPEND_GROUPS_SQL, [
    userId,
    from30,
    from7,
    to,
    chainIds,
  ])
  return result.rows
}

/**
 * Merchant identity = the x402 resource HOST, else the recipient address
 * (#3803) — never a display label. One statement returns the user-level
 * DISTINCT merchant counts for both windows (a sum of per-agent counts would
 * double-count a merchant two agents both paid) and the 7-day top merchant
 * with its raw identity fields: `top_merchant_url`/`top_merchant_to` are
 * representative (MIN) raw values from the winning merchant's rows, and
 * `top_merchant_address` is the contact/receipt name-lookup key (analytics'
 * `COALESCE(merchant_address, x402_merchant_address, to_address)`).
 * Always one row; the top-merchant columns are NULL on a no-spend window.
 */
export const DASHBOARD_MERCHANTS_SQL = `WITH legs AS (
    SELECT (CASE WHEN pi.x402_resource_url IS NOT NULL
                 THEN COALESCE(SUBSTRING(pi.x402_resource_url FROM '^[a-zA-Z][a-zA-Z0-9+.\\-]*://([^/?#]+)'), LOWER(pi.to_address))
                 ELSE LOWER(pi.to_address) END) AS merchant_key,
           pi.x402_resource_url,
           pi.to_address,
           COALESCE(pi.merchant_address, pi.x402_merchant_address, pi.to_address) AS merchant_address,
           pi.usd_value,
           (pi.confirmed_at >= $3) AS in_7d
    FROM payment_intents pi
    JOIN agents a ON a.id = pi.agent_id
    ${DELEGATION_RAIL_JOIN}
    WHERE pi.user_id = $1
      AND pi.status = 'confirmed'
      AND pi.confirmed_at >= $2
      AND pi.confirmed_at < $4
      AND COALESCE(pi.chain_id, 0) = ANY($5)
  ), per_merchant AS (
    SELECT merchant_key,
           SUM(COALESCE(usd_value, 0)) FILTER (WHERE in_7d) AS usd_7,
           MIN(x402_resource_url) AS rep_url,
           MIN(to_address) AS rep_to,
           MIN(merchant_address) AS rep_address
    FROM legs
    GROUP BY merchant_key
  ), top AS (
    SELECT merchant_key, rep_url, rep_to, rep_address
    FROM per_merchant
    ORDER BY usd_7 DESC NULLS LAST, merchant_key ASC
    LIMIT 1
  )
  SELECT (SELECT COUNT(DISTINCT merchant_key) FROM legs)::text AS distinct_merchants_30,
         (SELECT COUNT(DISTINCT merchant_key) FROM legs WHERE in_7d)::text AS distinct_merchants_7,
         top.merchant_key AS top_merchant_key,
         top.rep_url AS top_merchant_url,
         top.rep_to AS top_merchant_to,
         top.rep_address AS top_merchant_address
  FROM (SELECT 1) one
  LEFT JOIN top ON TRUE`

export interface DashboardMerchantsRow {
  distinct_merchants_30: string
  distinct_merchants_7: string
  top_merchant_key: string | null
  top_merchant_url: string | null
  top_merchant_to: string | null
  top_merchant_address: string | null
}

/** Same parameter contract as `listDashboardSpendGroups`. */
export async function listDashboardMerchants(
  userId: string,
  chainIds: number[],
  from30: string,
  from7: string,
  to: string,
  db: Executor = pool,
): Promise<DashboardMerchantsRow> {
  const result = await db.query<DashboardMerchantsRow>(DASHBOARD_MERCHANTS_SQL, [
    userId,
    from30,
    from7,
    to,
    chainIds,
  ])
  return (
    result.rows[0] ?? {
      distinct_merchants_30: '0',
      distinct_merchants_7: '0',
      top_merchant_key: null,
      top_merchant_url: null,
      top_merchant_to: null,
      top_merchant_address: null,
    }
  )
}

/**
 * Each agent's ALL-TIME latest confirmed payment — `lastPaymentAt` plus the
 * raw counterparty fields (#3803). The counterparty name is resolved by the
 * caller from `merchant_address` (contacts win, then merchant receipts —
 * analytics' label order); `source`, `x402ResourceUrl` and `to` are returned
 * raw, never as a display label.
 */
export const AGENT_LAST_PAYMENT_SQL = `SELECT DISTINCT ON (pi.agent_id)
         pi.agent_id,
         pi.confirmed_at,
         pi.source,
         pi.x402_resource_url,
         pi.to_address,
         COALESCE(pi.merchant_address, pi.x402_merchant_address, pi.to_address) AS merchant_address
  FROM payment_intents pi
  JOIN agents a ON a.id = pi.agent_id
  ${DELEGATION_RAIL_JOIN}
  WHERE pi.user_id = $1
    AND pi.status = 'confirmed'
  ORDER BY pi.agent_id, pi.confirmed_at DESC`

export interface AgentLastPaymentRow {
  agent_id: string
  /** `timestamptz`, not `::text` — formatted ISO-8601 UTC in application code. */
  confirmed_at: Date
  source: string | null
  x402_resource_url: string | null
  to_address: string | null
  merchant_address: string | null
}

/** `userId` is REQUIRED. */
export async function listAgentLastPayments(
  userId: string,
  db: Executor = pool,
): Promise<AgentLastPaymentRow[]> {
  const result = await db.query<AgentLastPaymentRow>(AGENT_LAST_PAYMENT_SQL, [userId])
  return result.rows.map((r) => ({
    ...r,
    confirmed_at: r.confirmed_at ? new Date(r.confirmed_at) : r.confirmed_at,
  }))
}

/**
 * Refusal ROW counts per bucket, per agent, for both windows (#3803) — rows,
 * not distinct reasons (the `aggregateRefusalsForUserByAgent().refusals`
 * trap the issue names). Buckets: `budget` = delegation_budget_exceeded +
 * delegation_expired, `scope` = no_delegation_for_target, `failed` =
 * onchain_revert, `haven` = relayer_budget. Chain-scoped like the spend
 * block; the user-level figure is the caller's SUM across agents (a refusal
 * row has exactly one agent, so summing per-agent row counts IS the row
 * count — the "not a sum of per-agent counts" rule is about DISTINCT
 * merchants, not refusal rows).
 */
export const REFUSAL_BUCKETS_BY_AGENT_SQL = `SELECT r.agent_id,
    COUNT(*) FILTER (WHERE r.reason IN ('delegation_budget_exceeded', 'delegation_expired')
                       AND r.created_at >= $2 AND r.created_at < $3)::text AS budget_7,
    COUNT(*) FILTER (WHERE r.reason = 'no_delegation_for_target'
                       AND r.created_at >= $2 AND r.created_at < $3)::text AS scope_7,
    COUNT(*) FILTER (WHERE r.reason = 'onchain_revert'
                       AND r.created_at >= $2 AND r.created_at < $3)::text AS failed_7,
    COUNT(*) FILTER (WHERE r.reason = 'relayer_budget'
                       AND r.created_at >= $2 AND r.created_at < $3)::text AS haven_7,
    COUNT(*) FILTER (WHERE r.reason IN ('delegation_budget_exceeded', 'delegation_expired')
                       AND r.created_at >= $4 AND r.created_at < $3)::text AS budget_30,
    COUNT(*) FILTER (WHERE r.reason = 'no_delegation_for_target'
                       AND r.created_at >= $4 AND r.created_at < $3)::text AS scope_30,
    COUNT(*) FILTER (WHERE r.reason = 'onchain_revert'
                       AND r.created_at >= $4 AND r.created_at < $3)::text AS failed_30,
    COUNT(*) FILTER (WHERE r.reason = 'relayer_budget'
                       AND r.created_at >= $4 AND r.created_at < $3)::text AS haven_30
  FROM payment_refusals r
  JOIN agents a ON a.id = r.agent_id
  ${DELEGATION_RAIL_JOIN}
  WHERE r.user_id = $1
    AND r.created_at >= $4
    AND r.created_at < $3
    AND COALESCE(r.chain_id, 0) = ANY($5)
  GROUP BY r.agent_id`

export interface RefusalBucketRow {
  agent_id: string
  budget_7: string
  scope_7: string
  failed_7: string
  haven_7: string
  budget_30: string
  scope_30: string
  failed_30: string
  haven_30: string
}

/** Same parameter contract as `listDashboardSpendGroups`. */
export async function listRefusalBucketsByAgent(
  userId: string,
  chainIds: number[],
  from30: string,
  from7: string,
  to: string,
  db: Executor = pool,
): Promise<RefusalBucketRow[]> {
  const result = await db.query<RefusalBucketRow>(REFUSAL_BUCKETS_BY_AGENT_SQL, [
    userId,
    from7,
    to,
    from30,
    chainIds,
  ])
  return result.rows
}

/** Failed payment intents in the 7-day window — a COUNT, not a fiat sum. */
export const FAILED_INTENTS_7D_SQL = `SELECT COUNT(*)::text AS failed_intents
  FROM payment_intents pi
  JOIN agents a ON a.id = pi.agent_id
  ${DELEGATION_RAIL_JOIN}
  WHERE pi.user_id = $1
    AND pi.status = 'failed'
    AND pi.created_at >= $2
    AND pi.created_at < $3
    AND COALESCE(pi.chain_id, 0) = ANY($4)`

/** `userId` is REQUIRED; `[from7, to)` on `created_at`. */
export async function countFailedIntents7d(
  userId: string,
  chainIds: number[],
  from7: string,
  to: string,
  db: Executor = pool,
): Promise<number> {
  const result = await db.query<{ failed_intents: string }>(FAILED_INTENTS_7D_SQL, [
    userId,
    from7,
    to,
    chainIds,
  ])
  return Number(result.rows[0]?.failed_intents ?? '0')
}
