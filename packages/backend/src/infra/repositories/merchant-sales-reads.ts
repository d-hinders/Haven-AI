/**
 * The owner's sales reads (#4897, epic #4885): one payment per transaction
 * into the merchant account, with its sale record when it has one.
 *
 * ## The rule every figure comes from
 *
 * Revenue is computed from all INDEXED TRANSFERS into the account
 * (`inbound_transfers`), never from the receive balance and never from
 * `match_kind`. Zero-value transfers are not in the base at all, and a transfer
 * with `sender_is_own_address = true` is not revenue. The base is then ONE ROW
 * PER TRANSACTION (`pay` below), and the totals, the three breakdowns and the
 * paged list are all cut from that same relation, so they cannot disagree for
 * one period:
 *
 * - a transaction with a `merchant_sales` row counts once, with the SALE's
 *   `amount_raw` (its legs are never added on top);
 * - a transaction with no sale row counts as a payment "without a product",
 *   with the sum of its non-own legs;
 * - a transaction whose every counted transfer is the owner's own (a sale row
 *   with `sender_is_own_address`, or no sale row and no non-own leg) is an own
 *   move: it is in the list, marked, and in no revenue figure.
 *
 * ## Stripe-held sales (#4952)
 *
 * A sale received at a registered Stripe deposit address (`held_by = 'stripe'`)
 * has no `inbound_transfers` legs; its chain facts are on the sale row, and it
 * is its own arm of `pay`. It is NEVER in a Haven balance, so every summary
 * figure (tiles, breakdowns, days) reads `pay_acct`, the account-held arm only,
 * and the separate `received_in_stripe` figure carries the Stripe-held sales.
 * The list and the detail include them, marked.
 *
 * Every statement is scoped by BOTH `user_id` and `account_id` (and the
 * account's chain), so a payment is never readable through another account.
 * Nothing here writes, and no statement reads `match_kind`, `balance_consumed`
 * or the receive balance.
 */
import pool from '../../db.js'
import type { Executor } from '../transaction.js'

export type PaymentKind = 'sale' | 'no_product' | 'own_move'

/** The period, as timestamps (UTC day boundaries); null is unbounded. */
export interface PeriodBounds {
  /** Inclusive. */
  from: Date | null
  /** Exclusive. */
  to: Date | null
}

export interface SalesScope {
  accountId: string
  userId: string
  chainId: number
}

/**
 * The per-transaction relation. Parameters:
 * $1 account, $2 user, $3 chain, $4 from (inclusive), $5 to (exclusive),
 * $6 one transaction hash (lower-case) or NULL for every transaction.
 */
const PAYMENTS_CTE = `
  legs AS (
    SELECT LOWER(t.tx_hash) AS tx_hash,
           MIN(t.block_time) AS block_time,
           SUM(t.amount_raw::numeric) AS all_sum,
           COALESCE(SUM(t.amount_raw::numeric) FILTER (WHERE NOT t.sender_is_own_address), 0) AS revenue_sum,
           COUNT(*) FILTER (WHERE NOT t.sender_is_own_address) AS revenue_legs,
           MIN(LOWER(t.payer_address)) FILTER (WHERE NOT t.sender_is_own_address) AS revenue_payer_min,
           MAX(LOWER(t.payer_address)) FILTER (WHERE NOT t.sender_is_own_address) AS revenue_payer_max,
           MIN(LOWER(t.payer_address)) AS any_payer_min,
           MAX(LOWER(t.payer_address)) AS any_payer_max
     FROM inbound_transfers t
     WHERE t.account_id = $1
       AND t.user_id = $2
       AND t.chain_id = $3
       AND t.amount_raw::numeric > 0
       AND t.block_time >= $4::timestamptz
       AND t.block_time < $5::timestamptz
       AND ($6::text IS NULL OR LOWER(t.tx_hash) = $6::text)
     GROUP BY LOWER(t.tx_hash)
  ),
  pay AS (
    SELECT l.tx_hash,
           l.block_time,
           CASE WHEN ms.id IS NOT NULL
                  THEN CASE WHEN ms.sender_is_own_address THEN 'own_move' ELSE 'sale' END
                WHEN l.revenue_legs = 0 THEN 'own_move'
                ELSE 'no_product' END AS kind,
           CASE WHEN ms.id IS NOT NULL THEN ms.amount_raw
                WHEN l.revenue_legs = 0 THEN 0
                ELSE l.revenue_sum END AS amount,
           l.all_sum,
           -- "several payers" is min <> max over the lower-cased payers: the same
           -- answer as counting distinct payers, without a sort per transaction.
           CASE WHEN ms.id IS NOT NULL THEN ms.several_payers
                WHEN l.revenue_legs > 0 THEN l.revenue_payer_min <> l.revenue_payer_max
                ELSE l.any_payer_min <> l.any_payer_max END AS several_payers,
           CASE WHEN ms.id IS NOT NULL THEN LOWER(ms.payer_address)
                WHEN l.revenue_legs > 0 THEN CASE WHEN l.revenue_payer_min = l.revenue_payer_max THEN l.revenue_payer_min END
                ELSE CASE WHEN l.any_payer_min = l.any_payer_max THEN l.any_payer_min END END AS payer,
           ms.id AS sale_id,
           ms.product_id,
           ms.product_name,
           ms.merchant_reference,
           ms.receipt_number,
           ms.vat_treatment,
           'account'::text AS held_by,
           NULL::text AS receiving_address
      FROM legs l
      LEFT JOIN merchant_sales ms
        ON ms.account_id = $1
       AND ms.user_id = $2
       AND ms.chain_id = $3
       AND ms.held_by = 'account'
       AND LOWER(ms.tx_hash) = l.tx_hash
    UNION ALL
    -- #4952: a Stripe-held sale has NO inbound_transfers legs: its chain facts
    -- are on the sale row. Never in a Haven balance, so it is its own arm,
    -- marked held_by = 'stripe', and every summary figure below reads pay_acct.
    SELECT LOWER(ms.tx_hash),
           ms.block_time,
           CASE WHEN ms.sender_is_own_address THEN 'own_move' ELSE 'sale' END,
           ms.amount_raw,
           ms.amount_raw,
           ms.several_payers,
           LOWER(ms.payer_address),
           ms.id,
           ms.product_id,
           ms.product_name,
           ms.merchant_reference,
           ms.receipt_number,
           ms.vat_treatment,
           'stripe'::text,
           ms.receiving_address
      FROM merchant_sales ms
     WHERE ms.account_id = $1
       AND ms.user_id = $2
       AND ms.chain_id = $3
       AND ms.held_by = 'stripe'
       AND ms.block_time >= $4::timestamptz
       AND ms.block_time < $5::timestamptz
       AND ($6::text IS NULL OR LOWER(ms.tx_hash) = $6::text)
  ),
  pay_acct AS (SELECT * FROM pay WHERE held_by = 'account')`

const NO_BOUND_FROM = '-infinity'
const NO_BOUND_TO = 'infinity'

function boundsParams(scope: SalesScope, period: PeriodBounds, txHash: string | null): unknown[] {
  return [
    scope.accountId,
    scope.userId,
    scope.chainId,
    period.from === null ? NO_BOUND_FROM : period.from,
    period.to === null ? NO_BOUND_TO : period.to,
    txHash,
  ]
}

/** How many products and payers the breakdowns name before folding the rest. */
export const BREAKDOWN_TOP = 100

export interface SalesSummaryRaw {
  tiles: {
    revenue_raw: string
    sales: number
    sales_raw: string
    without_product_count: number
    without_product_raw: string
    own_moves_count: number
    own_moves_raw: string
  }
  by_product: Array<{
    product_id: string
    record_name: string | null
    sales: number
    amount_raw: string
  }>
  by_product_other: { products: number; sales: number; amount_raw: string }
  by_day: Array<{ day: string; payments: number; sales: number; revenue_raw: string }>
  by_payer: Array<{ payer: string; payments: number; amount_raw: string }>
  by_payer_other: { payers: number; payments: number; amount_raw: string }
  unattributed: { payments: number; amount_raw: string }
  /** #4952: Stripe-held sales, apart from every figure above. */
  received_in_stripe: { count: number; amount_raw: string }
}

const SUMMARY_SQL = `
  WITH ${PAYMENTS_CTE},
  product_groups AS (
    SELECT product_id,
           (ARRAY_AGG(product_name ORDER BY block_time DESC, tx_hash DESC))[1] AS record_name,
           COUNT(*) AS sales,
           SUM(amount) AS amount,
           ROW_NUMBER() OVER (ORDER BY SUM(amount) DESC, product_id) AS rn
      FROM pay_acct
     WHERE kind = 'sale'
     GROUP BY product_id
  ),
  payer_groups AS (
    SELECT payer,
           COUNT(*) AS payments,
           SUM(amount) AS amount,
           ROW_NUMBER() OVER (ORDER BY SUM(amount) DESC, payer) AS rn
      FROM pay_acct
     WHERE kind <> 'own_move' AND NOT several_payers AND payer IS NOT NULL
     GROUP BY payer
  )
  SELECT
    (SELECT json_build_object(
        'revenue_raw', COALESCE(SUM(amount) FILTER (WHERE kind <> 'own_move'), 0)::text,
        'sales', COUNT(*) FILTER (WHERE kind = 'sale'),
        'sales_raw', COALESCE(SUM(amount) FILTER (WHERE kind = 'sale'), 0)::text,
        'without_product_count', COUNT(*) FILTER (WHERE kind = 'no_product'),
        'without_product_raw', COALESCE(SUM(amount) FILTER (WHERE kind = 'no_product'), 0)::text,
        'own_moves_count', COUNT(*) FILTER (WHERE kind = 'own_move'),
        'own_moves_raw', COALESCE(SUM(all_sum) FILTER (WHERE kind = 'own_move'), 0)::text
      ) FROM pay_acct) AS tiles,
    (SELECT COALESCE(json_agg(json_build_object(
        'product_id', product_id, 'record_name', record_name,
        'sales', sales, 'amount_raw', amount::text) ORDER BY rn), '[]'::json)
       FROM product_groups WHERE rn <= $7) AS by_product,
    (SELECT json_build_object(
        'products', COUNT(*), 'sales', COALESCE(SUM(sales), 0),
        'amount_raw', COALESCE(SUM(amount), 0)::text)
       FROM product_groups WHERE rn > $7) AS by_product_other,
    (SELECT COALESCE(json_agg(d ORDER BY d.day), '[]'::json) FROM (
        SELECT TO_CHAR((block_time AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day,
               COUNT(*) AS payments,
               COUNT(*) FILTER (WHERE kind = 'sale') AS sales,
               SUM(amount)::text AS revenue_raw
          FROM pay_acct
         WHERE kind <> 'own_move'
         GROUP BY 1) d) AS by_day,
    (SELECT COALESCE(json_agg(json_build_object(
        'payer', payer, 'payments', payments, 'amount_raw', amount::text) ORDER BY rn), '[]'::json)
       FROM payer_groups WHERE rn <= $7) AS by_payer,
    (SELECT json_build_object(
        'payers', COUNT(*), 'payments', COALESCE(SUM(payments), 0),
        'amount_raw', COALESCE(SUM(amount), 0)::text)
       FROM payer_groups WHERE rn > $7) AS by_payer_other,
    (SELECT json_build_object(
        'payments', COUNT(*), 'amount_raw', COALESCE(SUM(amount), 0)::text)
       FROM pay_acct
      WHERE kind <> 'own_move' AND (several_payers OR payer IS NULL)) AS unattributed,
    (SELECT json_build_object(
        'count', COUNT(*), 'amount_raw', COALESCE(SUM(amount), 0)::text)
       FROM pay
      WHERE held_by = 'stripe' AND kind <> 'own_move') AS received_in_stripe`

/** The totals and the three breakdowns for one period, from one statement. */
export async function readSalesSummary(
  scope: SalesScope,
  period: PeriodBounds,
  db: Executor = pool,
): Promise<SalesSummaryRaw> {
  const result = await db.query<SalesSummaryRaw>(SUMMARY_SQL, [
    ...boundsParams(scope, period, null),
    BREAKDOWN_TOP,
  ])
  return result.rows[0]
}

export interface PaymentRow {
  tx_hash: string
  block_time: Date
  /** `block_time` as Postgres prints it: the keyset cursor keeps full precision. */
  block_time_text: string
  kind: PaymentKind
  amount_raw: string
  several_payers: boolean
  payer: string | null
  sale_id: string | null
  product_id: string | null
  product_name: string | null
  merchant_reference: string | null
  receipt_number: string | null
  vat_treatment: 'SE_25' | 'REVERSE_CHARGE' | null
  held_by: 'account' | 'stripe'
  receiving_address: string | null
}

const PAYMENT_COLUMNS = `
  tx_hash, block_time, block_time::text AS block_time_text, kind,
  CASE WHEN kind = 'own_move' THEN all_sum ELSE amount END::text AS amount_raw,
  several_payers, payer, sale_id, product_id, product_name, merchant_reference,
  receipt_number, vat_treatment, held_by, receiving_address`

export interface PaymentsCursor {
  blockTime: string
  txHash: string
}

/**
 * One page of the list, newest first, keyset on `(block_time, tx_hash)`.
 * Fetches `limit + 1` so the caller can tell whether another page exists.
 * An own move shows the sum of its transfers as its amount (it is no revenue;
 * the row says so by its kind).
 */
export async function listPayments(
  scope: SalesScope,
  period: PeriodBounds,
  options: { limit: number; cursor: PaymentsCursor | null },
  db: Executor = pool,
): Promise<PaymentRow[]> {
  const cursor = options.cursor
  const result = await db.query<PaymentRow>(
    `WITH ${PAYMENTS_CTE}
     SELECT ${PAYMENT_COLUMNS}
       FROM pay
      WHERE ($7::timestamptz IS NULL OR (block_time, tx_hash) < ($7::timestamptz, $8::text))
      ORDER BY block_time DESC, tx_hash DESC
      LIMIT $9`,
    [
      ...boundsParams(scope, period, null),
      cursor === null ? null : cursor.blockTime,
      cursor === null ? null : cursor.txHash,
      options.limit + 1,
    ],
  )
  return result.rows
}

/** One payment by transaction hash, or null. */
export async function findPayment(
  scope: SalesScope,
  txHash: string,
  db: Executor = pool,
): Promise<PaymentRow | null> {
  const result = await db.query<PaymentRow>(
    `WITH ${PAYMENTS_CTE}
     SELECT ${PAYMENT_COLUMNS} FROM pay`,
    boundsParams(scope, { from: null, to: null }, txHash.toLowerCase()),
  )
  return result.rows[0] ?? null
}

export interface PaymentLegRow {
  log_index: number | null
  payer_address: string
  amount_raw: string
  token_address: string
}

/** The indexed transfers of one transaction, zero-value ones excluded. */
export async function listPaymentLegs(
  scope: SalesScope,
  txHash: string,
  db: Executor = pool,
): Promise<PaymentLegRow[]> {
  const result = await db.query<PaymentLegRow>(
    `SELECT log_index, LOWER(payer_address) AS payer_address, amount_raw, LOWER(token_address) AS token_address
       FROM inbound_transfers
      WHERE account_id = $1
        AND user_id = $2
        AND chain_id = $3
        AND LOWER(tx_hash) = $4
        AND amount_raw::numeric > 0
      ORDER BY log_index NULLS FIRST, id`,
    [scope.accountId, scope.userId, scope.chainId, txHash.toLowerCase()],
  )
  return result.rows
}

/**
 * The names of the owner's agents by delegate address: the agent's current
 * delegate and every delegate a rotation replaced, revoked agents included.
 * Scoped to the user. This is the one name source the existing loaders do not
 * have: an agent's payment arrives from its delegate address, not an account.
 */
export async function listAgentNamesByDelegate(
  userId: string,
  db: Executor = pool,
): Promise<Map<string, string>> {
  const result = await db.query<{ address: string; name: string }>(
    `SELECT LOWER(delegate_address) AS address, name
       FROM agents
      WHERE user_id = $1 AND delegate_address IS NOT NULL
     UNION
     SELECT LOWER(r.old_delegate_address), a.name
       FROM agent_rekeys r
       JOIN agents a ON a.id = r.agent_id
      WHERE a.user_id = $1`,
    [userId],
  )
  const names = new Map<string, string>()
  for (const row of result.rows) if (!names.has(row.address)) names.set(row.address, row.name)
  return names
}
