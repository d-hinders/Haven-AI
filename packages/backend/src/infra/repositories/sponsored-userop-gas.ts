/**
 * Storage access for `sponsored_userop_gas_events` (migration 110, #3837) —
 * the sponsored-UserOp gas ledger for the delegation payment path. Storage
 * only: the failure-direction policy (swallow everything) lives in
 * `modules/payments/sponsored-gas.ts`, and the ops view in
 * `modules/ops/sponsored-gas.ts`.
 *
 * Deliberately NOT `relayer_gas_events` (054): see the migration's header —
 * that table is the budget guard's count substrate AND the user-facing
 * `gas_sponsored_ops` figure; this one is monitoring only.
 */
import pool from '../../db.js'
import type { Executor } from '../transaction.js'
import { HOST_OF_URL_SQL } from '../../db/url-host.js'

export type SponsoredLeg = 'direct' | 'x402_funding'

export type SponsoredUserOpOutcome = 'confirmed' | 'included_reverted' | 'receipt_unconfirmed'

export interface SponsoredUserOpGasInput {
  paymentIntentId?: string | null
  agentId?: string | null
  userId?: string | null
  chainId: number
  leg: SponsoredLeg
  outcome: SponsoredUserOpOutcome
  userOpHash?: string | null
  txHash?: string | null
  actualGasUsed?: bigint | null
  actualGasCost?: bigint | null
}

export async function insertSponsoredUserOpGas(
  input: SponsoredUserOpGasInput,
  db: Executor = pool,
): Promise<string | null> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO sponsored_userop_gas_events
      (payment_intent_id, agent_id, user_id, chain_id, leg, outcome, user_op_hash, tx_hash, actual_gas_used, actual_gas_cost_wei)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      input.paymentIntentId ?? null,
      input.agentId ?? null,
      input.userId ?? null,
      input.chainId,
      input.leg,
      input.outcome,
      input.userOpHash ?? null,
      input.txHash ?? null,
      input.actualGasUsed?.toString() ?? null,
      input.actualGasCost?.toString() ?? null,
    ],
  )
  return res.rows[0]?.id ?? null
}

export interface SponsoredGasByMerchantDayRow {
  /** UTC day bucket (`created_at AT TIME ZONE 'UTC'`) — the aggregate's day is UTC, always. */
  day: string
  leg: SponsoredLeg
  /**
   * The merchant host from the joined intent's `payment_resource_url` (the
   * ONE host rule, `db/url-host.ts`). NULL for direct payments — their own
   * bucket — and for a funding leg whose intent has no resource URL.
   */
  merchant_host: string | null
  /** Every submitted op counts, cost-known or not. */
  funding_legs: string
  /** Sum of `actualGasCost` in wei; NULL while no leg in the bucket has a known cost. */
  gas_cost_wei: string | null
  /** Value the legs moved: `payment_intents.usd_value` of CONFIRMED intents only (reverted legs moved nothing). */
  value_moved_usd: string | null
}

/**
 * The per-merchant-per-day aggregate of sponsored gas — ONE query (#3837 AC).
 *
 * x402 funding legs group by the merchant host extracted (in SQL, by the
 * shared regex) from the LIVE join on `payment_intents.payment_resource_url`
 * (migration 012) — no host copy on this table, so a later intent-side
 * backfill is reflected here. Direct payments carry no merchant and group as
 * their own `leg = 'direct'` / `merchant_host = NULL` bucket. Value moved is
 * the confirmed intents' `usd_value` — reverted legs moved nothing, and a
 * still-pending intent contributes once it confirms (live join).
 */
export const SPONSORED_GAS_BY_MERCHANT_DAY_SQL = `
  WITH legs AS (
    SELECT e.created_at,
           e.leg,
           e.actual_gas_cost_wei,
           e.payment_intent_id,
           pi.payment_resource_url AS resource_url,
           pi.status AS intent_status,
           pi.usd_value
    FROM sponsored_userop_gas_events e
    LEFT JOIN payment_intents pi ON pi.id = e.payment_intent_id
    WHERE e.created_at >= $1 AND e.created_at < $2
  ),
  buckets AS (
    SELECT (created_at AT TIME ZONE 'UTC')::date::text AS day,
           leg,
           CASE WHEN leg = 'x402_funding'
                THEN ${HOST_OF_URL_SQL}
           END AS merchant_host,
           COUNT(*)::text AS funding_legs,
           SUM(actual_gas_cost_wei)::text AS gas_cost_wei
    FROM legs
    GROUP BY 1, 2, 3
  ),
  -- Value moved sums DISTINCT CONFIRMED intents: one intent can have several
  -- recorded legs, and joining per-leg would multiply its usd_value by the
  -- leg count. The intent is attributed to each (day, host) bucket its legs
  -- landed in.
  moved AS (
    SELECT day, leg, merchant_host, SUM(COALESCE(usd_value, 0))::text AS value_moved_usd
    FROM (
      SELECT DISTINCT
        (created_at AT TIME ZONE 'UTC')::date::text AS day,
        leg,
        CASE WHEN leg = 'x402_funding'
             THEN ${HOST_OF_URL_SQL}
        END AS merchant_host,
        payment_intent_id,
        usd_value
      FROM legs
      WHERE intent_status = 'confirmed'
    ) d
    GROUP BY day, leg, merchant_host
  )
  SELECT b.day,
         b.leg,
         b.merchant_host,
         b.funding_legs,
         b.gas_cost_wei,
         COALESCE(m.value_moved_usd, '0') AS value_moved_usd
  FROM buckets b
  LEFT JOIN moved m ON m.day = b.day AND m.leg = b.leg
                   AND (m.merchant_host IS NOT DISTINCT FROM b.merchant_host)
  ORDER BY 1, 2, 3`

export async function sponsoredGasByMerchantDay(
  from: Date,
  to: Date,
  db: Executor = pool,
): Promise<SponsoredGasByMerchantDayRow[]> {
  const result = await db.query<SponsoredGasByMerchantDayRow>(SPONSORED_GAS_BY_MERCHANT_DAY_SQL, [from, to])
  return result.rows
}
