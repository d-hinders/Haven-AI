/**
 * Data access for `GET /analytics/overview` (#2946, slice B of epic #2944).
 *
 * One grouped-aggregate statement per section — the AC's performance
 * requirement is that the 90-day query for a seeded user with 5 agents x 300
 * payments runs as ONE statement per section, never a per-agent loop. The one
 * deliberate exception is the budget block: `readRemainingBudget` is an
 * on-chain read with no batch form, so it runs once per ACTIVE delegation
 * (bounded by how many delegations the tenant has, not by payment volume).
 *
 * Every statement here is tenant-scoped (`userId` required). Most are ALSO
 * rail-scoped (`DELEGATION_RAIL_JOIN` — joins through `agents.account_id` to
 * `smart_accounts.account_type = 'delegator_hybrid'`, the same posture
 * `infra/repositories/smart-accounts.ts` and `dashboard.ts` already carry),
 * but NOT every join in this file is that filter — two are deliberately not,
 * corrected here after review claimed "every join" too broadly:
 *
 * - `BALANCE_BY_DAY_SQL` reads `user_daily_portfolio_snapshots` directly —
 *   one row per user per day, never per-account or per-agent. It is
 *   rail-agnostic BY CONSTRUCTION: there is no `account_id`/`agent_id` column
 *   on that table to join through, so a balance day cannot be attributed to
 *   one rail even in principle.
 * - `GAS_EVENTS_BY_CHAIN_SQL` reads `relayer_gas_events`, whose own migration
 *   (`054_relayer_gas_events.ts`) makes `agent_id` deliberately NOT a foreign
 *   key so that a deleted agent's gas attribution survives it, and lets
 *   `user_id` carry a gas event directly for user-level operations (Safe/
 *   Hybrid deploys) that have no owning agent at all. Both properties would
 *   break under a hard `JOIN agents ... JOIN smart_accounts`: a deleted
 *   agent's historical rows would silently vanish (contradicting the
 *   migration's own stated invariant), and every direct `user_id` row —
 *   which by definition has no agent to join through — would too. This
 *   statement therefore stays tenant-scoped only; it is not rail-scoped, and
 *   the CASP shard says so rather than repeating "every join".
 *
 * Refusal data is READ, never RE-WRITTEN: the dedupe/upsert logic and the
 * `(agent_id, reason)` breakdown stay exclusively in
 * `infra/repositories/payment-refusals.ts` (`listRefusalsForUser`,
 * `aggregateRefusalsForUserByAgent`) — nothing here inserts, updates or
 * duplicates that logic. Two READ-ONLY aggregates against `payment_refusals`
 * DO live here (`AGGREGATE_REFUSALS_FOR_USER_SQL`, `REFUSALS_BY_DAY_SQL`,
 * added on review of #2946): `listRefusalsForUser(..., 10_000)` was being
 * pulled in full just to fold `refused_amount` and a by-day refusal count in
 * application code, an O(rows) client-side sum instead of a SQL aggregate —
 * the same class of bug the performance AC exists to prevent everywhere
 * else in this file. Both are tenant-scoped and use the SAME half-open
 * `[from, to)` boundary and `AT TIME ZONE $tz` bucketing as `BY_DAY_SPEND_SQL`
 * (the route's separate `(fromExclusive, toInclusive]` convention for
 * `listRefusalsForUser` does not apply to these two statements).
 */

import pool from '../../db.js'
import type { Executor } from '../transaction.js'
import { getChainData } from '@haven_ai/core'
import { delegationLiveWindowSql } from './delegation-budgets.js'
import {
  readRemainingBudget,
  currentPeriodBounds,
  mapWithConcurrency,
  BUDGET_READ_CONCURRENCY,
} from '../chain/delegation-budget-reader.js'
import { isValueBearingChain } from '../../modules/accounts/index.js'

export type { Executor }

/**
 * The rail filter every section joins on. Mirrors
 * `infra/repositories/smart-accounts.ts`'s `DELEGATION_RAIL_ONLY` verbatim —
 * kept as its own constant here because it is spliced into a JOIN clause
 * (`smart-accounts.ts`'s is spliced into a WHERE), so sharing one string
 * across both shapes would read as more coupling than the two files have.
 *
 * #3803: exported now — the dashboard repository's own spend/pace/refusal
 * statements splice the same JOIN shape, and the dashboard file importing the
 * one JOIN-clause spelling beats a third verbatim copy of the same filter.
 */
export const DELEGATION_RAIL_JOIN = `JOIN smart_accounts sa ON sa.id = a.account_id AND sa.account_type = 'delegator_hybrid'`

export interface DateRange {
  /** ISO timestamp, inclusive lower bound. */
  from: string
  /** ISO timestamp, exclusive upper bound. */
  to: string
}

/**
 * #3803 — the #3755 netting FACTOR as one exported fragment. The ratio
 * expression below already existed three times in this file (TOTALS_SPEND_SQL,
 * BY_DAY_SPEND_SQL, PER_AGENT_SPEND_SQL); the dashboard overview's 7/30-day
 * spend block needed the same netting against `delegate_sweeps`, and a fourth
 * verbatim copy was the one thing the issue forbade. The three existing
 * statements keep their inline copies (their text is pinned by db tests and
 * PREPAREd by db-schema-smoke; rewriting them is behaviour-preserving but
 * touches pinned SQL for no behavioural gain) — every NEW netting consumer
 * takes this fragment, so the expression has exactly one canonical spelling
 * going forward. `atomicExpr` is the group's confirmed atomic sum, `sweptExpr`
 * the group's swept sum — both already window-scoped by the caller's CTEs.
 */
export function spendNetFactorSql(atomicExpr: string, sweptExpr: string): string {
  return `CASE WHEN COALESCE(${atomicExpr}, 0) > 0 THEN 1 - LEAST(COALESCE(${sweptExpr}, 0) / ${atomicExpr}, 1) ELSE 1 END`
}

// ── Totals: spend + previous-period delta ───────────────────────────────────

export interface TotalsSpendRow {
  spent_usd: string
  spent_eur: string
  spent_sek: string
  spent_previous_usd: string
  spent_previous_eur: string
  spent_previous_sek: string
  payments_counted: string
}

/**
 * Current + previous window in ONE statement via conditional aggregation —
 * two round trips would double the cost of the exact query the performance
 * AC is about. `status = 'confirmed'` is the whole status-inclusion rule:
 * the fiat columns are NULL on every other status (booked only by the
 * confirm UPDATE, `payment-intents.ts:538,637`), so summing them is already
 * safe, but the explicit predicate is what a mutation test can remove.
 *
 * #3755 — the gross sums are NETTED against `delegate_sweeps`. A clawed-back
 * funding leg (merchant refused after funding, funds swept back to the
 * treasury) must not count as spent. `delegate_sweeps` carries agent, token,
 * `value_atomic` (token units) and `tx_hash` but NO fiat column and NO
 * per-intent link, so the netting is a RATIO per (agent, token, chain)
 * group, applied per window independently:
 *
 *     net = gross × (1 − min(1, swept_atomic / confirmed_atomic))
 *
 * `swept_atomic` sums `value_atomic` of sweeps that actually returned funds
 * (`status = 'submitted'` with a `tx_hash` — the `submitted` lifecycle in
 * `machine-payments.ts` sets both together; `prepared`/`submitting` rows have
 * not left the delegate wallet, `failed`/`expired` rows never did), anchored
 * on `COALESCE(submitted_at, created_at)` inside the SAME window as the
 * gross it amends. `confirmed_atomic` sums `amount_raw::numeric` of the
 * group's confirmed legs in that window — guarded by the same
 * `'^[0-9]+$'` shape check `FEES_TOTALS_SQL` uses, because `amount_raw` is
 * `VARCHAR(78)` with no CHECK constraint and a failed cast would be a
 * FAILED QUERY, not a wrong number. A leg whose `amount_raw` fails the
 * shape check keeps its booked fiat but contributes no measurable atomic
 * (ratio denominator), so its group nets at factor 1 — an unmeasurable
 * group is left gross rather than silently over-netted.
 *
 * The ratio form (rather than a fiat-rate conversion of the swept amount)
 * needs no price point: the same spot price that booked the fiat booked the
 * atomic amounts, so `swept/confirmed` IS the returned share of the group's
 * booked volume. `min(1, …)` caps the factor at 0 — a sweep can never drive
 * a window's spend negative, even when it claws back funds booked in an
 * earlier window (the earlier window stays overstated until the window
 * rolls; that residual is the price of having no sweep→intent link, and is
 * stated here rather than hidden). `payments_counted` is deliberately NOT
 * netted: the count is of funding legs made, not of money kept.
 */
export const TOTALS_SPEND_SQL = `WITH legs AS (
    SELECT pi.agent_id,
           LOWER(pi.token_address) AS token_key,
           COALESCE(pi.chain_id, 0) AS chain_key,
           CASE WHEN pi.amount_raw ~ '^[0-9]+$' THEN pi.amount_raw::numeric END AS atomic,
           pi.usd_value,
           pi.eur_value,
           pi.sek_value,
           pi.confirmed_at
    FROM payment_intents pi
    JOIN agents a ON a.id = pi.agent_id
    ${DELEGATION_RAIL_JOIN}
    WHERE pi.user_id = $1
      AND pi.status = 'confirmed'
      AND pi.confirmed_at >= $4
      AND pi.confirmed_at < $3
  ), swept AS (
    SELECT ds.agent_id,
           LOWER(ds.token_address) AS token_key,
           ds.chain_id AS chain_key,
           SUM(CASE WHEN COALESCE(ds.submitted_at, ds.created_at) >= $2
                     AND COALESCE(ds.submitted_at, ds.created_at) < $3
                    THEN ds.value_atomic ELSE 0 END) AS swept_current,
           SUM(CASE WHEN COALESCE(ds.submitted_at, ds.created_at) >= $4
                     AND COALESCE(ds.submitted_at, ds.created_at) < $2
                    THEN ds.value_atomic ELSE 0 END) AS swept_previous
    FROM delegate_sweeps ds
    WHERE ds.user_id = $1
      AND ds.status = 'submitted'
      AND ds.tx_hash IS NOT NULL
      AND ((COALESCE(ds.submitted_at, ds.created_at) >= $2
        AND COALESCE(ds.submitted_at, ds.created_at) < $3)
    OR (COALESCE(ds.submitted_at, ds.created_at) >= $4
        AND COALESCE(ds.submitted_at, ds.created_at) < $2))
    GROUP BY ds.agent_id, LOWER(ds.token_address), ds.chain_id
  ), grouped AS (
    SELECT l.agent_id, l.token_key, l.chain_key,
           SUM(CASE WHEN l.confirmed_at >= $2 AND l.confirmed_at < $3 THEN l.atomic ELSE 0 END) AS atomic_current,
           SUM(CASE WHEN l.confirmed_at >= $4 AND l.confirmed_at < $2 THEN l.atomic ELSE 0 END) AS atomic_previous,
           SUM(CASE WHEN l.confirmed_at >= $2 AND l.confirmed_at < $3 THEN COALESCE(l.usd_value, 0) ELSE 0 END) AS usd_current,
           SUM(CASE WHEN l.confirmed_at >= $2 AND l.confirmed_at < $3 THEN COALESCE(l.eur_value, 0) ELSE 0 END) AS eur_current,
           SUM(CASE WHEN l.confirmed_at >= $2 AND l.confirmed_at < $3 THEN COALESCE(l.sek_value, 0) ELSE 0 END) AS sek_current,
           SUM(CASE WHEN l.confirmed_at >= $4 AND l.confirmed_at < $2 THEN COALESCE(l.usd_value, 0) ELSE 0 END) AS usd_previous,
           SUM(CASE WHEN l.confirmed_at >= $4 AND l.confirmed_at < $2 THEN COALESCE(l.eur_value, 0) ELSE 0 END) AS eur_previous,
           SUM(CASE WHEN l.confirmed_at >= $4 AND l.confirmed_at < $2 THEN COALESCE(l.sek_value, 0) ELSE 0 END) AS sek_previous,
           COUNT(*) FILTER (WHERE l.confirmed_at >= $2 AND l.confirmed_at < $3) AS legs_current
    FROM legs l
    GROUP BY l.agent_id, l.token_key, l.chain_key
  )
  SELECT
    COALESCE(SUM(g.usd_current * CASE WHEN COALESCE(g.atomic_current, 0) > 0 THEN 1 - LEAST(COALESCE(s.swept_current, 0) / g.atomic_current, 1) ELSE 1 END), 0)::text AS spent_usd,
    COALESCE(SUM(g.eur_current * CASE WHEN COALESCE(g.atomic_current, 0) > 0 THEN 1 - LEAST(COALESCE(s.swept_current, 0) / g.atomic_current, 1) ELSE 1 END), 0)::text AS spent_eur,
    COALESCE(SUM(g.sek_current * CASE WHEN COALESCE(g.atomic_current, 0) > 0 THEN 1 - LEAST(COALESCE(s.swept_current, 0) / g.atomic_current, 1) ELSE 1 END), 0)::text AS spent_sek,
    COALESCE(SUM(g.usd_previous * CASE WHEN COALESCE(g.atomic_previous, 0) > 0 THEN 1 - LEAST(COALESCE(s.swept_previous, 0) / g.atomic_previous, 1) ELSE 1 END), 0)::text AS spent_previous_usd,
    COALESCE(SUM(g.eur_previous * CASE WHEN COALESCE(g.atomic_previous, 0) > 0 THEN 1 - LEAST(COALESCE(s.swept_previous, 0) / g.atomic_previous, 1) ELSE 1 END), 0)::text AS spent_previous_eur,
    COALESCE(SUM(g.sek_previous * CASE WHEN COALESCE(g.atomic_previous, 0) > 0 THEN 1 - LEAST(COALESCE(s.swept_previous, 0) / g.atomic_previous, 1) ELSE 1 END), 0)::text AS spent_previous_sek,
    COALESCE(SUM(g.legs_current), 0)::text AS payments_counted
  FROM grouped g
  LEFT JOIN swept s
    ON s.agent_id = g.agent_id
   AND s.token_key = g.token_key
   AND s.chain_key = g.chain_key`

/** `userId` is REQUIRED. `current`/`previous` are equal-length, adjacent windows. */
export async function sumTotalsSpendForUser(
  userId: string,
  current: DateRange,
  previous: DateRange,
  db: Executor = pool,
): Promise<TotalsSpendRow> {
  const result = await db.query<TotalsSpendRow>(TOTALS_SPEND_SQL, [
    userId,
    current.from,
    current.to,
    previous.from,
  ])
  return (
    result.rows[0] ?? {
      spent_usd: '0',
      spent_eur: '0',
      spent_sek: '0',
      spent_previous_usd: '0',
      spent_previous_eur: '0',
      spent_previous_sek: '0',
      payments_counted: '0',
    }
  )
}

// ── basis.unsettled_submitted ────────────────────────────────────────────────

export const COUNT_UNSETTLED_SUBMITTED_SQL = `SELECT COUNT(*)::text AS count
  FROM payment_intents pi
  JOIN agents a ON a.id = pi.agent_id
  ${DELEGATION_RAIL_JOIN}
  WHERE pi.user_id = $1
    AND pi.status = 'submitted'
    AND pi.created_at >= $2
    AND pi.created_at < $3`

/**
 * `submitted` rows never carry a booked fiat value and are never counted as
 * spend — this is the count the page uses to say "N payments awaiting
 * settlement evidence are not counted" (an erc7710 payment whose hash was
 * never reported stays `submitted`; `settlement-observed.ts` is fail-closed).
 */
export async function countUnsettledSubmittedForUser(
  userId: string,
  range: DateRange,
  db: Executor = pool,
): Promise<number> {
  const result = await db.query<{ count: string }>(COUNT_UNSETTLED_SUBMITTED_SQL, [
    userId,
    range.from,
    range.to,
  ])
  return Number(result.rows[0]?.count ?? '0')
}

// ── By-day spend, bucketed server-side in the caller's timezone ─────────────

export interface ByDaySpendRow {
  /** `YYYY-MM-DD` in the requested zone (via `date_trunc(... AT TIME ZONE $tz)`). */
  day: string
  agent_id: string
  usd: string
  eur: string
  sek: string
}

/**
 * `AT TIME ZONE $2` takes a text parameter directly — Postgres resolves it
 * against `pg_timezone_names` at execution time, so an invalid zone fails the
 * query rather than silently defaulting to UTC. The route validates `tz`
 * before this ever runs (see `routes/analytics-overview.ts`), so this is a
 * second, structural line of defense, not the only one.
 *
 * #3755 — each day is netted by the SAME window-level ratio
 * `sumTotalsSpendForUser` applies (see its doc block): per (agent, token,
 * chain) group, `1 − min(1, swept_atomic / confirmed_atomic)` over the whole
 * `[from, to)` window, multiplied into every day the group booked spend. The
 * sweep rows carry no per-day breakdown and no sweep→intent link, so the
 * clawback is spread across the days in proportion to where the group's
 * booked volume sits — which sums back to exactly the netted window total
 * (`Σ_day gross_day × factor = gross_window × factor`), keeping by-day and
 * totals consistent by construction. Day values are therefore never negative
 * and no new buckets appear: the wire shape (`by_day[]` days with activity)
 * is unchanged, and the frontend's stacked bar needs no negative-segment
 * handling. A group with sweeps but no confirmed legs in the window nets
 * nothing — there is no booked spend to amend.
 */
export const BY_DAY_SPEND_SQL = `WITH legs AS (
    SELECT date_trunc('day', pi.confirmed_at AT TIME ZONE $2)::date::text AS day,
           pi.agent_id,
           LOWER(pi.token_address) AS token_key,
           COALESCE(pi.chain_id, 0) AS chain_key,
           CASE WHEN pi.amount_raw ~ '^[0-9]+$' THEN pi.amount_raw::numeric END AS atomic,
           pi.usd_value,
           pi.eur_value,
           pi.sek_value
    FROM payment_intents pi
    JOIN agents a ON a.id = pi.agent_id
    ${DELEGATION_RAIL_JOIN}
    WHERE pi.user_id = $1
      AND pi.status = 'confirmed'
      AND pi.confirmed_at >= $3
      AND pi.confirmed_at < $4
  ), swept AS (
    SELECT ds.agent_id,
           LOWER(ds.token_address) AS token_key,
           ds.chain_id AS chain_key,
           SUM(ds.value_atomic) AS swept_window
    FROM delegate_sweeps ds
    WHERE ds.user_id = $1
      AND ds.status = 'submitted'
      AND ds.tx_hash IS NOT NULL
      AND COALESCE(ds.submitted_at, ds.created_at) >= $3
      AND COALESCE(ds.submitted_at, ds.created_at) < $4
    GROUP BY ds.agent_id, LOWER(ds.token_address), ds.chain_id
  ), grouped AS (
    SELECT l.agent_id, l.token_key, l.chain_key, SUM(l.atomic) AS atomic_window
    FROM legs l
    GROUP BY l.agent_id, l.token_key, l.chain_key
  ), day_groups AS (
    SELECT l.day, l.agent_id, l.token_key, l.chain_key,
           SUM(COALESCE(l.usd_value, 0)) AS usd_day,
           SUM(COALESCE(l.eur_value, 0)) AS eur_day,
           SUM(COALESCE(l.sek_value, 0)) AS sek_day
    FROM legs l
    GROUP BY l.day, l.agent_id, l.token_key, l.chain_key
  )
  SELECT dg.day,
         dg.agent_id,
         SUM(dg.usd_day * CASE WHEN COALESCE(gr.atomic_window, 0) > 0 THEN 1 - LEAST(COALESCE(s.swept_window, 0) / gr.atomic_window, 1) ELSE 1 END)::text AS usd,
         SUM(dg.eur_day * CASE WHEN COALESCE(gr.atomic_window, 0) > 0 THEN 1 - LEAST(COALESCE(s.swept_window, 0) / gr.atomic_window, 1) ELSE 1 END)::text AS eur,
         SUM(dg.sek_day * CASE WHEN COALESCE(gr.atomic_window, 0) > 0 THEN 1 - LEAST(COALESCE(s.swept_window, 0) / gr.atomic_window, 1) ELSE 1 END)::text AS sek
  FROM day_groups dg
  JOIN grouped gr
    ON gr.agent_id = dg.agent_id
   AND gr.token_key = dg.token_key
   AND gr.chain_key = dg.chain_key
  LEFT JOIN swept s
    ON s.agent_id = dg.agent_id
   AND s.token_key = dg.token_key
   AND s.chain_key = dg.chain_key
  GROUP BY dg.day, dg.agent_id`

/** `userId` is REQUIRED. One statement regardless of agent count. */
export async function listByDaySpendForUser(
  userId: string,
  tz: string,
  range: DateRange,
  db: Executor = pool,
): Promise<ByDaySpendRow[]> {
  const result = await db.query<ByDaySpendRow>(BY_DAY_SPEND_SQL, [userId, tz, range.from, range.to])
  return result.rows
}

// ── Per-agent spend ──────────────────────────────────────────────────────────

export interface PerAgentSpendRow {
  agent_id: string
  name: string
  status: string
  spent_usd: string
  spent_eur: string
  spent_sek: string
  payments: string
  last_payment_at: string | null
}

/**
 * Every delegation-rail agent the tenant owns, in ANY status — a revoked
 * agent that spent inside the range must still appear (AC). The LEFT JOIN to
 * `payment_intents` is what lets a zero-spend agent still show up with
 * `payments = 0` rather than being dropped by an inner join.
 *
 * #3755 — the per-agent fiat sums are netted by the SAME per-(agent, token,
 * chain) sweep ratio `sumTotalsSpendForUser` applies (see its doc block),
 * over this statement's single `[from, to)` window: each token group's
 * gross × (1 − min(1, swept/confirmed)), then summed per agent, so an agent
 * whose funds were partially clawed back shows its net share here and
 * `totals.spent` stays the sum of the `agents[].spent` column. `payments`
 * and `last_payment_at` stay gross — they describe activity, not money
 * kept — and an agent with no confirmed legs keeps `0` spend even if it has
 * sweeps (nothing booked to amend), via the `COALESCE` on the netted CTE.
 */
export const PER_AGENT_SPEND_SQL = `WITH legs AS (
    SELECT pi.agent_id,
           LOWER(pi.token_address) AS token_key,
           COALESCE(pi.chain_id, 0) AS chain_key,
           CASE WHEN pi.amount_raw ~ '^[0-9]+$' THEN pi.amount_raw::numeric END AS atomic,
           pi.usd_value,
           pi.eur_value,
           pi.sek_value
    FROM payment_intents pi
    WHERE pi.user_id = $1
      AND pi.status = 'confirmed'
      AND pi.confirmed_at >= $2
      AND pi.confirmed_at < $3
  ), swept AS (
    SELECT ds.agent_id,
           LOWER(ds.token_address) AS token_key,
           ds.chain_id AS chain_key,
           SUM(ds.value_atomic) AS swept_window
    FROM delegate_sweeps ds
    WHERE ds.user_id = $1
      AND ds.status = 'submitted'
      AND ds.tx_hash IS NOT NULL
      AND COALESCE(ds.submitted_at, ds.created_at) >= $2
      AND COALESCE(ds.submitted_at, ds.created_at) < $3
    GROUP BY ds.agent_id, LOWER(ds.token_address), ds.chain_id
  ), per_token AS (
    SELECT l.agent_id, l.token_key, l.chain_key,
           SUM(l.atomic) AS atomic_window,
           SUM(COALESCE(l.usd_value, 0)) AS usd_token,
           SUM(COALESCE(l.eur_value, 0)) AS eur_token,
           SUM(COALESCE(l.sek_value, 0)) AS sek_token
    FROM legs l
    GROUP BY l.agent_id, l.token_key, l.chain_key
  ), netted AS (
    SELECT p.agent_id,
           SUM(p.usd_token * CASE WHEN COALESCE(p.atomic_window, 0) > 0 THEN 1 - LEAST(COALESCE(s.swept_window, 0) / p.atomic_window, 1) ELSE 1 END) AS spent_usd,
           SUM(p.eur_token * CASE WHEN COALESCE(p.atomic_window, 0) > 0 THEN 1 - LEAST(COALESCE(s.swept_window, 0) / p.atomic_window, 1) ELSE 1 END) AS spent_eur,
           SUM(p.sek_token * CASE WHEN COALESCE(p.atomic_window, 0) > 0 THEN 1 - LEAST(COALESCE(s.swept_window, 0) / p.atomic_window, 1) ELSE 1 END) AS spent_sek
    FROM per_token p
    LEFT JOIN swept s
      ON s.agent_id = p.agent_id
     AND s.token_key = p.token_key
     AND s.chain_key = p.chain_key
    GROUP BY p.agent_id
  )
  SELECT
    a.id AS agent_id,
    a.name,
    a.status,
    COALESCE(n.spent_usd, 0)::text AS spent_usd,
    COALESCE(n.spent_eur, 0)::text AS spent_eur,
    COALESCE(n.spent_sek, 0)::text AS spent_sek,
    COUNT(pi.id)::text AS payments,
    MAX(pi.confirmed_at) AS last_payment_at
  FROM agents a
  ${DELEGATION_RAIL_JOIN}
  LEFT JOIN payment_intents pi
    ON pi.agent_id = a.id
   AND pi.status = 'confirmed'
   AND pi.confirmed_at >= $2
   AND pi.confirmed_at < $3
  LEFT JOIN netted n ON n.agent_id = a.id
  WHERE a.user_id = $1
  GROUP BY a.id, a.name, a.status, n.spent_usd, n.spent_eur, n.spent_sek`

interface PerAgentSpendRawRow {
  agent_id: string
  name: string
  status: string
  spent_usd: string
  spent_eur: string
  spent_sek: string
  payments: string
  /** `timestamptz`, not `::text` — a session-zone cast would silently rebase
   * this off UTC. Formatted to ISO-8601 UTC in application code below. */
  last_payment_at: Date | null
}

export async function listPerAgentSpendForUser(
  userId: string,
  range: DateRange,
  db: Executor = pool,
): Promise<PerAgentSpendRow[]> {
  const result = await db.query<PerAgentSpendRawRow>(PER_AGENT_SPEND_SQL, [userId, range.from, range.to])
  return result.rows.map((r) => ({
    ...r,
    last_payment_at: r.last_payment_at ? r.last_payment_at.toISOString() : null,
  }))
}

export interface PerAgentTopMerchantRow {
  agent_id: string
  merchant_key: string
}

/**
 * The top merchant per agent, in ONE statement via a window function rather
 * than one query per agent. Ranked on the USD sum regardless of the caller's
 * display currency — the top merchant by USD, by EUR and by SEK are the same
 * merchant in every case this codebase can produce (all are booked from the
 * same spot price at confirmation), so ranking on one currency avoids a
 * second parameter without changing which merchant wins.
 */
export const PER_AGENT_TOP_MERCHANT_SQL = `WITH per_agent_merchant AS (
    SELECT
      pi.agent_id,
      LOWER(COALESCE(pi.merchant_address, pi.x402_merchant_address, pi.to_address)) AS merchant_key,
      SUM(pi.usd_value) AS usd_spent
    FROM payment_intents pi
    JOIN agents a ON a.id = pi.agent_id
    ${DELEGATION_RAIL_JOIN}
    WHERE pi.user_id = $1
      AND pi.status = 'confirmed'
      AND pi.confirmed_at >= $2
      AND pi.confirmed_at < $3
    GROUP BY pi.agent_id, merchant_key
  ), ranked AS (
    SELECT agent_id, merchant_key,
           ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY usd_spent DESC) AS rn
    FROM per_agent_merchant
  )
  SELECT agent_id, merchant_key FROM ranked WHERE rn = 1`

export async function listPerAgentTopMerchantForUser(
  userId: string,
  range: DateRange,
  db: Executor = pool,
): Promise<PerAgentTopMerchantRow[]> {
  const result = await db.query<PerAgentTopMerchantRow>(PER_AGENT_TOP_MERCHANT_SQL, [
    userId,
    range.from,
    range.to,
  ])
  return result.rows
}

// ── Merchants (top 10) ───────────────────────────────────────────────────────

export interface MerchantAggregateRow {
  merchant_key: string
  spent_usd: string
  spent_eur: string
  spent_sek: string
  payments: string
  agent_ids: string[]
  /** ISO-8601 UTC (`toISOString()`), never a `::text` session-zone cast. */
  first_seen: string
  last_seen: string
}

export const TOP_MERCHANTS_SQL = `SELECT
    LOWER(COALESCE(pi.merchant_address, pi.x402_merchant_address, pi.to_address)) AS merchant_key,
    COALESCE(SUM(pi.usd_value), 0)::text AS spent_usd,
    COALESCE(SUM(pi.eur_value), 0)::text AS spent_eur,
    COALESCE(SUM(pi.sek_value), 0)::text AS spent_sek,
    COUNT(*)::text AS payments,
    ARRAY_AGG(DISTINCT pi.agent_id)::text[] AS agent_ids,
    MIN(pi.confirmed_at) AS first_seen,
    MAX(pi.confirmed_at) AS last_seen
  FROM payment_intents pi
  JOIN agents a ON a.id = pi.agent_id
  ${DELEGATION_RAIL_JOIN}
  WHERE pi.user_id = $1
    AND pi.status = 'confirmed'
    AND pi.confirmed_at >= $2
    AND pi.confirmed_at < $3
  GROUP BY merchant_key
  ORDER BY SUM(pi.usd_value) DESC
  LIMIT 10`

interface MerchantAggregateRawRow {
  merchant_key: string
  spent_usd: string
  spent_eur: string
  spent_sek: string
  payments: string
  agent_ids: string[]
  first_seen: Date
  last_seen: Date
}

export async function listTopMerchantsForUser(
  userId: string,
  range: DateRange,
  db: Executor = pool,
): Promise<MerchantAggregateRow[]> {
  const result = await db.query<MerchantAggregateRawRow>(TOP_MERCHANTS_SQL, [userId, range.from, range.to])
  return result.rows.map((r) => ({
    ...r,
    first_seen: r.first_seen.toISOString(),
    last_seen: r.last_seen.toISOString(),
  }))
}

/**
 * Best-effort merchant-name fallback from a merchant-issued receipt (#956),
 * for the (bounded, <=10) merchant addresses the top-merchants list just
 * produced. `contacts` still wins in the shaping layer — this is only the
 * SECOND-choice label, read from the newest receipt on file for the address.
 */
export const RECEIPT_MERCHANT_NAMES_SQL = `SELECT DISTINCT ON (LOWER(mpe.merchant_address))
    LOWER(mpe.merchant_address) AS merchant_key,
    mr.inline_json ->> 'merchant_name' AS receipt_name
  FROM machine_payment_evidence mpe
  JOIN merchant_receipts mr ON mr.evidence_id = mpe.id
  WHERE mpe.user_id = $1
    AND mpe.merchant_address = ANY($2)
    AND mr.inline_json ->> 'merchant_name' IS NOT NULL
  ORDER BY LOWER(mpe.merchant_address), mpe.created_at DESC`

export async function listReceiptMerchantNamesForUser(
  userId: string,
  merchantAddresses: string[],
  db: Executor = pool,
): Promise<Map<string, string>> {
  if (merchantAddresses.length === 0) return new Map()
  const result = await db.query<{ merchant_key: string; receipt_name: string }>(
    RECEIPT_MERCHANT_NAMES_SQL,
    [userId, merchantAddresses],
  )
  return new Map(result.rows.map((r) => [r.merchant_key, r.receipt_name]))
}

// ── Balance over time ────────────────────────────────────────────────────────

export interface BalanceDayRow {
  snapshot_date: string
  total_usd: string
  total_eur: string
  /**
   * NULL on days snapshotted before migration 090 (the column is NULLABLE,
   * deliberately without a 0 default). The route passes it through as null —
   * the client renders "change unavailable" rather than reading a zero.
   */
  total_sek: string | null
}

export const BALANCE_BY_DAY_SQL = `SELECT snapshot_date::text, total_usd::text, total_eur::text, total_sek::text
  FROM user_daily_portfolio_snapshots
  WHERE user_id = $1
    AND snapshot_date >= $2::date
    AND snapshot_date <= $3::date
  ORDER BY snapshot_date ASC`

export async function listBalanceByDayForUser(
  userId: string,
  range: DateRange,
  db: Executor = pool,
): Promise<BalanceDayRow[]> {
  const result = await db.query<BalanceDayRow>(BALANCE_BY_DAY_SQL, [userId, range.from, range.to])
  return result.rows
}

// ── Fees paid to Haven ───────────────────────────────────────────────────────

export interface FeesTotalsRow {
  fee_usd: string
  fee_eur: string
  fee_sek: string
  fee_usd_previous: string
  fee_eur_previous: string
  fee_sek_previous: string
  fee_rows: string
}

/**
 * `payment_fees` is keyed by `payment_id` and carries no fiat column — it is
 * valued with the INTENT's booked fiat (owner decision, #2944): the fee's
 * share of the payment's atomic amount, applied to the payment's booked
 * usd/eur value at the same price point. While the fee flag is off,
 * `fee_amount_atomic` is `'0'` for every row, so this is honestly zero, not a
 * silent skip.
 */
/**
 * `pi.amount_raw::numeric` would throw a Postgres cast error — not a wrong
 * number, a FAILED QUERY — the instant one row's `amount_raw` (`VARCHAR(78)`,
 * no CHECK constraint) is not a plain digit string. `routes/payments.ts`'s own
 * `try { BigInt(intent.amount_raw) } catch { gross = 0n }` is this codebase
 * already not trusting that column absolutely, so this statement does not
 * either: `pi.amount_raw ~ '^[0-9]+$'` guards every cast, and a row that
 * fails it contributes 0 fee rather than crashing the aggregate — the same
 * "honestly zero, not a silent skip" posture the module doc already commits
 * to for the fee-flag-off case.
 */
const AMOUNT_RAW_IS_NUMERIC = `pi.amount_raw ~ '^[0-9]+$'`

export const FEES_TOTALS_SQL = `SELECT
    COALESCE(SUM(CASE WHEN pi.confirmed_at >= $2 AND pi.confirmed_at < $3 AND ${AMOUNT_RAW_IS_NUMERIC}
      THEN (pf.fee_amount_atomic::numeric / NULLIF(pi.amount_raw::numeric, 0)) * COALESCE(pi.usd_value, 0)
      ELSE 0 END), 0)::text AS fee_usd,
    COALESCE(SUM(CASE WHEN pi.confirmed_at >= $2 AND pi.confirmed_at < $3 AND ${AMOUNT_RAW_IS_NUMERIC}
      THEN (pf.fee_amount_atomic::numeric / NULLIF(pi.amount_raw::numeric, 0)) * COALESCE(pi.eur_value, 0)
      ELSE 0 END), 0)::text AS fee_eur,
    COALESCE(SUM(CASE WHEN pi.confirmed_at >= $2 AND pi.confirmed_at < $3 AND ${AMOUNT_RAW_IS_NUMERIC}
      THEN (pf.fee_amount_atomic::numeric / NULLIF(pi.amount_raw::numeric, 0)) * COALESCE(pi.sek_value, 0)
      ELSE 0 END), 0)::text AS fee_sek,
    COALESCE(SUM(CASE WHEN pi.confirmed_at >= $4 AND pi.confirmed_at < $2 AND ${AMOUNT_RAW_IS_NUMERIC}
      THEN (pf.fee_amount_atomic::numeric / NULLIF(pi.amount_raw::numeric, 0)) * COALESCE(pi.usd_value, 0)
      ELSE 0 END), 0)::text AS fee_usd_previous,
    COALESCE(SUM(CASE WHEN pi.confirmed_at >= $4 AND pi.confirmed_at < $2 AND ${AMOUNT_RAW_IS_NUMERIC}
      THEN (pf.fee_amount_atomic::numeric / NULLIF(pi.amount_raw::numeric, 0)) * COALESCE(pi.eur_value, 0)
      ELSE 0 END), 0)::text AS fee_eur_previous,
    COALESCE(SUM(CASE WHEN pi.confirmed_at >= $4 AND pi.confirmed_at < $2 AND ${AMOUNT_RAW_IS_NUMERIC}
      THEN (pf.fee_amount_atomic::numeric / NULLIF(pi.amount_raw::numeric, 0)) * COALESCE(pi.sek_value, 0)
      ELSE 0 END), 0)::text AS fee_sek_previous,
    COUNT(*) FILTER (WHERE pi.confirmed_at >= $2 AND pi.confirmed_at < $3 AND ${AMOUNT_RAW_IS_NUMERIC})::text AS fee_rows
  FROM payment_fees pf
  JOIN payment_intents pi ON pi.id::text = pf.payment_id
  JOIN agents a ON a.id = pi.agent_id
  ${DELEGATION_RAIL_JOIN}
  WHERE pi.user_id = $1
    AND pi.status = 'confirmed'
    AND pi.confirmed_at >= $4
    AND pi.confirmed_at < $3`

export async function sumFeesTotalsForUser(
  userId: string,
  current: DateRange,
  previous: DateRange,
  db: Executor = pool,
): Promise<FeesTotalsRow> {
  const result = await db.query<FeesTotalsRow>(FEES_TOTALS_SQL, [
    userId,
    current.from,
    current.to,
    previous.from,
  ])
  return (
    result.rows[0] ?? {
      fee_usd: '0',
      fee_eur: '0',
      fee_sek: '0',
      fee_usd_previous: '0',
      fee_eur_previous: '0',
      fee_sek_previous: '0',
      fee_rows: '0',
    }
  )
}

// ── Gas — a COUNT, never a fiat sum ──────────────────────────────────────────

export interface GasEventsByChainRow {
  chain_id: number
  ops: string
}

/**
 * Grouped by chain rather than pre-filtered in SQL: `isValueBearingChain`
 * (`modules/accounts/mainnet-gate.ts`) is the single fail-closed source for
 * "which chains are real" and is applied in application code below, so a
 * change to that predicate is the only place this behavior can drift from —
 * duplicating its testnet list into SQL would give the mutation test nothing
 * to catch (removing the JS filter would not touch a hardcoded WHERE).
 */
export const GAS_EVENTS_BY_CHAIN_SQL = `SELECT chain_id, COUNT(*)::text AS ops
  FROM relayer_gas_events
  WHERE created_at >= $2
    AND created_at < $3
    AND (user_id = $1 OR agent_id IN (SELECT id FROM agents WHERE user_id = $1))
  GROUP BY chain_id`

export async function listGasEventsByChainForUser(
  userId: string,
  range: DateRange,
  db: Executor = pool,
): Promise<GasEventsByChainRow[]> {
  const result = await db.query<GasEventsByChainRow>(GAS_EVENTS_BY_CHAIN_SQL, [
    userId,
    range.from,
    range.to,
  ])
  return result.rows
}

/** Sums the value-bearing chains only — the one place `isValueBearingChain` is applied. */
export function sumValueBearingGasOps(rows: GasEventsByChainRow[]): number {
  return rows
    .filter((r) => isValueBearingChain(r.chain_id))
    .reduce((sum, r) => sum + Number(r.ops), 0)
}

// ── Budgets — read from the chain, one delegation at a time ─────────────────

export interface ActiveDelegationForUserRow {
  id: string
  agent_id: string
  chain_id: number
  token_address: string
  recipient_address: string | null
  delegation_json: string
  budget_atomic: string
  period_seconds: number
  start_date: string
}

/**
 * Every ACTIVE delegation across every delegation-rail agent the tenant
 * owns — ONE statement regardless of agent or delegation count. The
 * per-delegation chain read (`readRemainingBudget`) happens afterwards, in
 * `shapeBudgets` below: it cannot be folded into this query because it is an
 * RPC call, not SQL, but it is bounded by delegation count, not payment
 * volume, so it does not violate the "one statement per section" AC (that AC
 * is about the payment_intents-scale sections).
 */
export const ACTIVE_DELEGATIONS_FOR_USER_SQL = `SELECT
    ad.id, ad.agent_id, ad.chain_id, ad.token_address, ad.recipient_address,
    ad.delegation_json, ad.budget_atomic, ad.period_seconds, ad.start_date::text AS start_date
  FROM agent_delegations ad
  JOIN agents a ON a.id = ad.agent_id
  ${DELEGATION_RAIL_JOIN}
  WHERE a.user_id = $1 AND ad.status = 'active'
    AND (${delegationLiveWindowSql('ad')})`

export async function listActiveDelegationsForUser(
  userId: string,
  db: Executor = pool,
): Promise<ActiveDelegationForUserRow[]> {
  const result = await db.query<ActiveDelegationForUserRow>(ACTIVE_DELEGATIONS_FOR_USER_SQL, [userId])
  return result.rows
}

export interface DelegationBudgetView {
  agent_id: string
  token: string
  recipient: string | null
  used_atomic: string
  budget_atomic: string
  remaining_from_chain: boolean
  period_start: string
  period_end: string
  /** Used/budget in [0, 1], for `budget_bands` — NaN-safe (0 when budget is 0). */
  ratio: number
}

function tokenSymbolFor(chainId: number, tokenAddress: string): string {
  try {
    const token = getChainData(chainId).tokens.find(
      (t) => t.address !== null && t.address.toLowerCase() === tokenAddress.toLowerCase(),
    )
    if (token) return token.symbol
  } catch {
    // Unknown chain — the generic fallback below still reports a budget.
  }
  return 'TOKEN'
}

/**
 * Reads the chain for every ACTIVE delegation (documented above) and shapes
 * the per-agent budget view. Reads run with up to
 * `BUDGET_READ_CONCURRENCY` in flight at once — each `readRemainingBudget`
 * call keeps its own per-read timeout, so N sequential reads no longer cost
 * N timeouts in the worst case (#2946 review). `remaining_from_chain: false`
 * marks a fallback read exactly as `readRemainingBudget` reports it.
 */
export async function shapeBudgets(
  delegations: ActiveDelegationForUserRow[],
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<Map<string, DelegationBudgetView[]>> {
  const byAgent = new Map<string, DelegationBudgetView[]>()
  const views = await mapWithConcurrency(delegations, BUDGET_READ_CONCURRENCY, async (d) => {
    const { remainingAtomic, fromChain } = await readRemainingBudget(
      d.chain_id,
      d.delegation_json,
      d.budget_atomic,
    )
    const budgetAtomic = BigInt(d.budget_atomic)
    const remaining = BigInt(remainingAtomic)
    const used = budgetAtomic > remaining ? budgetAtomic - remaining : 0n
    const { start, end } = currentPeriodBounds(Number(d.start_date), d.period_seconds, nowSec)
    const ratio = budgetAtomic > 0n ? Number(used) / Number(budgetAtomic) : 0
    const view: DelegationBudgetView = {
      agent_id: d.agent_id,
      token: tokenSymbolFor(d.chain_id, d.token_address),
      recipient: d.recipient_address,
      used_atomic: used.toString(),
      budget_atomic: d.budget_atomic,
      remaining_from_chain: fromChain,
      period_start: new Date(start * 1000).toISOString(),
      period_end: new Date(end * 1000).toISOString(),
      ratio,
    }
    return view
  })
  for (const view of views) {
    const existing = byAgent.get(view.agent_id) ?? []
    existing.push(view)
    byAgent.set(view.agent_id, existing)
  }
  return byAgent
}

// ── Refusal aggregates — amount and by-day, from ONE statement each ─────────

export interface RefusalAmountRow {
  refused_count: string
  refused_amount_usd: string
  refused_amount_eur: string
  refused_amount_sek: string
}

/**
 * The total refused amount AND the row count from the same scan, so they
 * cannot disagree with each other (the review finding this replaces: the
 * previous code derived `refused_amount` from a separately-fetched
 * 10,000-row list while `refused_count` came from a different aggregate).
 * `[from, to)` — the same half-open boundary `TOTALS_SPEND_SQL` and
 * `BY_DAY_SPEND_SQL` use, not `listRefusalsForUser`'s `(from, to]`.
 */
export const AGGREGATE_REFUSALS_FOR_USER_SQL = `SELECT
    COUNT(*)::text AS refused_count,
    COALESCE(SUM(pr.usd_value), 0)::text AS refused_amount_usd,
    COALESCE(SUM(pr.eur_value), 0)::text AS refused_amount_eur,
    COALESCE(SUM(pr.sek_value), 0)::text AS refused_amount_sek
  FROM payment_refusals pr
  WHERE pr.user_id = $1
    AND pr.created_at >= $2
    AND pr.created_at < $3`

export async function aggregateRefusalAmountForUser(
  userId: string,
  range: DateRange,
  db: Executor = pool,
): Promise<RefusalAmountRow> {
  const result = await db.query<RefusalAmountRow>(AGGREGATE_REFUSALS_FOR_USER_SQL, [
    userId,
    range.from,
    range.to,
  ])
  return (
    result.rows[0] ?? {
      refused_count: '0',
      refused_amount_usd: '0',
      refused_amount_eur: '0',
      refused_amount_sek: '0',
    }
  )
}

export interface RefusalsByDayRow {
  /** `YYYY-MM-DD` in the requested zone — bucketed exactly like `BY_DAY_SPEND_SQL`. */
  day: string
  refusals: string
}

export const REFUSALS_BY_DAY_SQL = `SELECT
    date_trunc('day', pr.created_at AT TIME ZONE $2)::date::text AS day,
    COUNT(*)::text AS refusals
  FROM payment_refusals pr
  WHERE pr.user_id = $1
    AND pr.created_at >= $3
    AND pr.created_at < $4
  GROUP BY day`

/**
 * `YYYY-MM-DD` in the given zone, via `Intl.DateTimeFormat` — the JS-side
 * counterpart to `AT TIME ZONE $tz` bucketing in `BY_DAY_SPEND_SQL` and
 * `REFUSALS_BY_DAY_SQL`. Lives here (not in the route) so the repository
 * test suite can prove, by construction, that this function and the SQL
 * bucket the same instant onto the same calendar day for a non-UTC zone.
 */
export function dayKeyInZone(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso))
}

export async function listRefusalsByDayForUser(
  userId: string,
  tz: string,
  range: DateRange,
  db: Executor = pool,
): Promise<RefusalsByDayRow[]> {
  const result = await db.query<RefusalsByDayRow>(REFUSALS_BY_DAY_SQL, [
    userId,
    tz,
    range.from,
    range.to,
  ])
  return result.rows
}

export interface BudgetBands {
  above_75: number
  above_50: number
  agents_with_budget: number
}

/** An agent's "worst" ratio is the max across its delegations — one over-budget delegation is enough to flag it. */
export function computeBudgetBands(byAgent: Map<string, DelegationBudgetView[]>): BudgetBands {
  let above75 = 0
  let above50 = 0
  for (const views of byAgent.values()) {
    if (views.length === 0) continue
    const worst = Math.max(...views.map((v) => v.ratio))
    if (worst > 0.75) above75 += 1
    if (worst > 0.5) above50 += 1
  }
  return { above_75: above75, above_50: above50, agents_with_budget: byAgent.size }
}
