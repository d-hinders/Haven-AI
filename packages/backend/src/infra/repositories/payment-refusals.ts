/**
 * Storage access for `payment_refusals` (#2945, slice A of epic #2944) — the
 * analytics ledger of what the guardrails refused. Storage only: the
 * fire-and-forget posture, the reason classification and the price booking
 * live in `modules/payments/refusal-ledger.ts`; the migration owns the
 * closed `reason`/`source` CHECKs and the `detail` JSONB allowlist.
 *
 * ## The growth bound is an UPSERT, not insert-then-count
 *
 * A refused attempt costs the caller nothing, so a retry loop against
 * `POST /x402/authorize` would write one row per attempt and grow the table
 * linearly with retries. `recordPaymentRefusal` therefore dedupes on
 * `(agent_id, reason, resource_url)` within a 60-second window: the second
 * refusal in the window increments `attempts` on the existing row instead of
 * inserting. One statement, so two concurrent refusals of the same triple
 * race on the row lock and both land (one insert, one increment) — the count
 * is monotone and never loses an attempt; a lost UPDATE would undercount.
 *
 * NULL `resource_url` must dedupe as a VALUE, not the SQL way where
 * `NULL = NULL` is NULL (an IS-DISTINCT-FROM join would fold every
 * null-URL refusal of an agent into one row forever). `IS NOT DISTINCT
 * FROM` gives the three-valued logic the window comparison needs: two NULLs
 * are EQUAL for the window, and distinct from any non-NULL.
 */

import pool from '../../db.js'

/** The closed `reason` set — mirrors migration 086's CHECK exactly. */
export type PaymentRefusalReason =
  | 'delegation_budget_exceeded'
  | 'no_delegation_for_target'
  | 'delegation_expired'
  | 'relayer_budget'
  | 'onchain_revert'

/** The closed `source` set — mirrors migration 087's CHECK exactly. */
export type PaymentRefusalSource = 'x402_authorize' | 'payment' | 'redeem' | 'hosted_prepare'

/** The `detail` allowlist — mirrors migration 086's CHECK exactly. */
export const REFUSAL_DETAIL_KEYS = [
  'error_code',
  'phase',
  'next_action',
  'remaining_atomic',
  'budget_atomic',
] as const

export type PaymentRefusalDetail = Partial<Record<(typeof REFUSAL_DETAIL_KEYS)[number], string>>

/** Seconds. Two refusals of the same triple inside this window are one row. */
export const REFUSAL_DEDUPE_WINDOW_SECONDS = 60

export interface RecordRefusalInput {
  userId: string
  /** Nullable on purpose: agents.preferred_account_id can be NULL. */
  accountId?: string | null
  agentId: string
  chainId: number
  tokenSymbol: string
  amountAtomic: string
  usdValue: number | null
  eurValue: number | null
  sekValue: number | null
  merchantTo?: string | null
  resourceUrl?: string | null
  reason: PaymentRefusalReason
  source: PaymentRefusalSource
  detail?: PaymentRefusalDetail | null
}

export interface RecordRefusalResult {
  /** The row written or incremented. */
  id: string
  /** False when this call folded into an existing row's `attempts`. */
  inserted: boolean
  attempts: number
}

const RECORD_REFUSAL_SQL = `
  WITH existing AS (
    SELECT id FROM payment_refusals
     WHERE agent_id = $3
       AND reason = $10
       AND resource_url IS NOT DISTINCT FROM $11
       AND created_at > NOW() - ($12::text || ' seconds')::interval
     ORDER BY created_at DESC
     LIMIT 1
  ), folded AS (
    UPDATE payment_refusals r
       SET attempts = r.attempts + 1
      WHERE id IN (SELECT id FROM existing)
    RETURNING r.id, r.attempts
  ), inserted AS (
    INSERT INTO payment_refusals (
      user_id, account_id, agent_id, chain_id, token_symbol,
      amount_atomic, usd_value, eur_value, sek_value, merchant_to, resource_url,
      reason, source, detail
    )
    SELECT $1, $2, $3, $4, $5, $6, $7, $8, $15, $9, $11, $10, $13, $14
     WHERE NOT EXISTS (SELECT 1 FROM existing)
    RETURNING id, attempts
  )
  SELECT id, attempts, (SELECT count(*) FROM folded)::int AS folded_count FROM (
    (SELECT id, attempts FROM folded)
    UNION ALL
    (SELECT id, attempts FROM inserted)
  ) u
  LIMIT 1
`

export async function recordPaymentRefusal(
  input: RecordRefusalInput,
): Promise<RecordRefusalResult> {
  const result = await pool.query<{ id: string; attempts: number; folded_count: number }>(
    RECORD_REFUSAL_SQL,
    [
      input.userId,
      input.accountId ?? null,
      input.agentId,
      input.chainId,
      input.tokenSymbol,
      input.amountAtomic,
      input.usdValue,
      input.eurValue,
      input.merchantTo ?? null,
      input.reason,
      input.resourceUrl ?? null,
      String(REFUSAL_DEDUPE_WINDOW_SECONDS),
      input.source,
      input.detail ? JSON.stringify(input.detail) : null,
      // $15 — APPENDED, not interleaved: $1..$14 keep their exact slots (the
      // statement's existing positional map is untouched), sek_value reads the
      // new tail bind.
      input.sekValue,
    ],
  )
  const row = result.rows[0]
  if (!row) throw new Error('payment_refusals: upsert produced no row')
  return { id: row.id, inserted: row.folded_count === 0, attempts: Number(row.attempts) }
}

export interface PaymentRefusalRow {
  id: string
  user_id: string
  account_id: string | null
  agent_id: string
  chain_id: number
  token_symbol: string
  amount_atomic: string
  usd_value: string | null
  eur_value: string | null
  merchant_to: string | null
  resource_url: string | null
  reason: PaymentRefusalReason
  source: PaymentRefusalSource
  detail: PaymentRefusalDetail | null
  attempts: number
  created_at: string
}

const REFUSAL_READ_COLUMNS = `
  id, user_id, account_id, agent_id, chain_id, token_symbol, amount_atomic,
  usd_value, eur_value, merchant_to, resource_url, reason, source, detail,
  attempts, created_at`

/**
 * The range read the analytics API serves (`slice B` reads this; no public
 * route in this slice). `fromExclusive`/`toInclusive` are ISO timestamps;
 * `limit` is a server-side cap, newest first.
 */
export async function listRefusalsForUser(
  userId: string,
  range: { fromExclusive: string; toInclusive: string },
  limit = 200,
): Promise<PaymentRefusalRow[]> {
  const result = await pool.query<PaymentRefusalRow>(
    `SELECT ${REFUSAL_READ_COLUMNS} FROM payment_refusals
      WHERE user_id = $1 AND created_at > $2 AND created_at <= $3
      ORDER BY created_at DESC
      LIMIT $4`,
    [userId, range.fromExclusive, range.toInclusive, limit],
  )
  return result.rows
}

export interface RefusalsPerAgentAggregate {
  agent_id: string
  /** Distinct refusal ROWS in the range (the dedupe makes rows ≠ attempts). */
  refusals: number
  /** Folded attempts across those rows (what "312 attempts" reads). */
  attempts: number
  by_reason: Partial<Record<PaymentRefusalReason, number>>
}

/** Per-agent aggregate over the same range shape `listRefusalsForUser` takes. */
export async function aggregateRefusalsForUserByAgent(
  userId: string,
  range: { fromExclusive: string; toInclusive: string },
): Promise<RefusalsPerAgentAggregate[]> {
  // Refusals = distinct rows, attempts = SUM(attempts), by_reason = per-reason
  // row counts — all three from ONE grouped scan (inner GROUP BY
  // (agent_id, reason), outer GROUP BY agent_id).
  const result = await pool.query<{
    agent_id: string
    refusals: string
    attempts: string
    by_reason: Record<string, number> | null
  }>(
    `SELECT agent_id,
            COUNT(*)::text AS refusals,
            COALESCE(SUM(reason_attempts), 0)::text AS attempts,
            jsonb_object_agg(reason, reason_rows) AS by_reason
       FROM (
         SELECT agent_id, reason, COUNT(*) AS reason_rows, SUM(attempts) AS reason_attempts
           FROM payment_refusals
          WHERE user_id = $1 AND created_at > $2 AND created_at <= $3
          GROUP BY agent_id, reason
       ) per_reason
      GROUP BY agent_id
      ORDER BY attempts DESC, agent_id ASC`,
    [userId, range.fromExclusive, range.toInclusive],
  )
  return result.rows.map((row) => ({
    agent_id: row.agent_id,
    refusals: Number(row.refusals),
    attempts: Number(row.attempts),
    by_reason: (row.by_reason ?? {}) as Partial<Record<PaymentRefusalReason, number>>,
  }))
}

/**
 * The ledger's floor day (#3013): the earliest `created_at` in
 * `payment_refusals` for this user as a `YYYY-MM-DD` UTC calendar day,
 * inside NO window bound — a property of the ledger, not of any requested
 * range. A window reaching back behind this day knows which part of itself
 * has no refusal coverage (a `refused_count: 0` there means "nothing was
 * recorded", never "nothing happened"). `null` when the ledger has no rows
 * at all, so an empty ledger stays distinguishable from any day value.
 * `MIN()` over an empty set yields one row of NULL, so the single-row read
 * covers both shapes.
 */
export async function firstRefusalDayForUser(userId: string): Promise<string | null> {
  const result = await pool.query<{ day: string | null }>(
    `SELECT TO_CHAR(MIN(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day
       FROM payment_refusals
      WHERE user_id = $1`,
    [userId],
  )
  return result.rows[0]?.day ?? null
}
