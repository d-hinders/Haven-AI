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
 * is its own arm of `pay`. It is NEVER in a Haven balance, but a sale is a sale
 * wherever the money landed (#4981): every revenue figure (tiles, breakdowns,
 * days) reads `pay_f`, both arms. The split stays on the wire, always under the
 * active filters: `revenue_in_account_raw`, `received_in_stripe` and
 * `by_day[].in_stripe_raw`. A several-payer Stripe sale stores no individual
 * payers, so it is `unattributed`. The list and the detail include them, marked.
 *
 * ## Filters and search (#4959)
 *
 * The list, the total and the summary read ONE filtered relation, `pay_f`, so for one filter set the totals,
 * the breakdowns, the count and the rows agree. A filter is a parameter of the
 * statement, never a cut made after the fetch, so keyset paging stays exact.
 * The search term arrives already RESOLVED (`SalesFilters.search`): the module
 * matches it against the caller's own names and product labels in JS and hands
 * this file addresses and product ids; only the receipt number and an address
 * prefix are matched here. A transaction from several payers matches a payer
 * (or a searched address) when any of its legs is from it.
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
 * The resolved filters of one read (#4959). Null means "no filter on that"; an
 * empty array is a filter nothing matches.
 */
export interface SalesFilters {
  kinds: PaymentKind[] | null
  /** Matches sales only. */
  productIds: string[] | null
  /** Lower-case addresses. */
  payers: string[] | null
  /** The search, resolved by the module; null when there is no search. */
  search: {
    /** An ILIKE pattern (wildcards escaped) for the receipt number. */
    receiptPattern: string
    /** The caller's own named addresses whose name matched (lower-case). */
    payers: string[]
    /** The period's products whose label or id matched. */
    productIds: string[]
    /** A LIKE prefix pattern when the term is a partial address, else null. */
    addressPrefix: string | null
  } | null
}

export const NO_FILTERS: SalesFilters = { kinds: null, productIds: null, payers: null, search: null }

/**
 * The per-transaction relation. Parameters:
 * $1 account, $2 user, $3 chain, $4 from (inclusive), $5 to (exclusive),
 * $6 one transaction hash (lower-case) or NULL for every transaction,
 * $7 kinds, $8 product ids, $9 payers (each a text[] or NULL),
 * $10 the search's receipt pattern (NULL: no search), $11 its payers,
 * $12 its product ids, $13 its address-prefix pattern (or NULL).
 *
 * `pay` is every payment of the period; `pay_f` is the filtered one, which
 * every list, count and summary figure reads.
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
           MAX(LOWER(t.payer_address)) AS any_payer_max,
           -- #4959: whether any leg is from a filtered (or searched) address,
           -- for a transaction with several payers.
           COALESCE(BOOL_OR(LOWER(t.payer_address) = ANY($9::text[])), false) AS leg_payer_match,
           COALESCE(BOOL_OR(LOWER(t.payer_address) = ANY($11::text[])
                            OR LOWER(t.payer_address) LIKE $13::text), false) AS leg_search_match
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
           NULL::text AS receiving_address,
           l.leg_payer_match,
           l.leg_search_match
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
    -- marked held_by = 'stripe'. Every summary figure below reads pay_f (#4981).
    SELECT LOWER(ms.tx_hash),
           ms.block_time,
           'sale',
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
           ms.receiving_address,
           COALESCE(LOWER(ms.payer_address) = ANY($9::text[]), false),
           COALESCE(LOWER(ms.payer_address) = ANY($11::text[])
                    OR LOWER(ms.payer_address) LIKE $13::text, false)
      FROM merchant_sales ms
     WHERE ms.account_id = $1
       AND ms.user_id = $2
       AND ms.chain_id = $3
       AND ms.held_by = 'stripe'
       -- A Stripe-held sale from the owner's own address is never revenue and its
       -- row holds no "what moved" amount: it is left out of the list.
       AND NOT ms.sender_is_own_address
       AND ms.block_time >= $4::timestamptz
       AND ms.block_time < $5::timestamptz
       AND ($6::text IS NULL OR LOWER(ms.tx_hash) = $6::text)
  ),
  pay_f AS (
    SELECT * FROM pay p
     WHERE ($7::text[] IS NULL OR p.kind = ANY($7::text[]))
       AND ($8::text[] IS NULL OR (p.kind = 'sale' AND p.product_id = ANY($8::text[])))
       AND ($9::text[] IS NULL
            OR p.payer = ANY($9::text[])
            OR (p.several_payers AND p.leg_payer_match))
       AND ($10::text IS NULL
            OR p.payer = ANY($11::text[])
            OR p.payer LIKE $13::text
            OR (p.several_payers AND p.leg_search_match)
            OR (p.kind = 'sale' AND p.product_id = ANY($12::text[]))
            OR p.receipt_number ILIKE $10::text)
  )`

const NO_BOUND_FROM = '-infinity'
const NO_BOUND_TO = 'infinity'

/** $1 to $13 of `PAYMENTS_CTE`. */
function relationParams(
  scope: SalesScope,
  period: PeriodBounds,
  txHash: string | null,
  filters: SalesFilters,
): unknown[] {
  return [
    scope.accountId,
    scope.userId,
    scope.chainId,
    period.from === null ? NO_BOUND_FROM : period.from,
    period.to === null ? NO_BOUND_TO : period.to,
    txHash,
    filters.kinds,
    filters.productIds,
    filters.payers,
    filters.search?.receiptPattern ?? null,
    filters.search?.payers ?? [],
    filters.search?.productIds ?? [],
    filters.search?.addressPrefix ?? null,
  ]
}

/** How many products and payers the breakdowns name before folding the rest. */
export const BREAKDOWN_TOP = 100

export interface SalesSummaryRaw {
  tiles: {
    revenue_raw: string
    /** #4981: the part of `revenue_raw` received in the Haven account. */
    revenue_in_account_raw: string
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
  by_day: Array<{
    day: string
    payments: number
    sales: number
    revenue_raw: string
    without_product_raw: string
    /** #4981: the part of `revenue_raw` received in Stripe. */
    in_stripe_raw: string
    /** #4959: the day's sales by product, for the products `by_product` names. */
    by_product: Array<{ product_id: string; amount_raw: string }>
    /** The day's sales of the products folded into `by_product_other`. */
    other_products_raw: string
  }>
  /** `last_paid_at` as Postgres's JSON prints a timestamptz. */
  by_payer: Array<{ payer: string; payments: number; amount_raw: string; last_paid_at: string }>
  by_payer_other: { payers: number; payments: number; amount_raw: string }
  unattributed: { payments: number; amount_raw: string }
  /** #4952: the Stripe-held part of the revenue figures above (#4981), under the same filters. */
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
      FROM pay_f
     WHERE kind = 'sale'
     GROUP BY product_id
  ),
  payer_groups AS (
    SELECT payer,
           COUNT(*) AS payments,
           SUM(amount) AS amount,
           MAX(block_time) AS last_paid_at,
           ROW_NUMBER() OVER (ORDER BY SUM(amount) DESC, payer) AS rn
      FROM pay_f
     WHERE kind <> 'own_move' AND NOT several_payers AND payer IS NOT NULL
     GROUP BY payer
  ),
  pay_days AS (
    SELECT TO_CHAR((block_time AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day, kind, held_by, product_id, amount
      FROM pay_f
     WHERE kind <> 'own_move'
  ),
  day_products AS (
    SELECT d.day,
           json_agg(json_build_object('product_id', d.product_id, 'amount_raw', d.amount::text)
                    ORDER BY d.amount DESC, d.product_id) FILTER (WHERE g.rn <= $14) AS products,
           COALESCE(SUM(d.amount) FILTER (WHERE g.rn > $14), 0) AS other_amount
      FROM (SELECT day, product_id, SUM(amount) AS amount
              FROM pay_days WHERE kind = 'sale' GROUP BY day, product_id) d
      JOIN product_groups g ON g.product_id = d.product_id
     GROUP BY d.day
  )
  SELECT
    (SELECT json_build_object(
        'revenue_raw', COALESCE(SUM(amount) FILTER (WHERE kind <> 'own_move'), 0)::text,
        'revenue_in_account_raw', COALESCE(SUM(amount) FILTER (WHERE kind <> 'own_move' AND held_by = 'account'), 0)::text,
        'sales', COUNT(*) FILTER (WHERE kind = 'sale'),
        'sales_raw', COALESCE(SUM(amount) FILTER (WHERE kind = 'sale'), 0)::text,
        'without_product_count', COUNT(*) FILTER (WHERE kind = 'no_product'),
        'without_product_raw', COALESCE(SUM(amount) FILTER (WHERE kind = 'no_product'), 0)::text,
        'own_moves_count', COUNT(*) FILTER (WHERE kind = 'own_move'),
        'own_moves_raw', COALESCE(SUM(all_sum) FILTER (WHERE kind = 'own_move'), 0)::text
      ) FROM pay_f) AS tiles,
    (SELECT COALESCE(json_agg(json_build_object(
        'product_id', product_id, 'record_name', record_name,
        'sales', sales, 'amount_raw', amount::text) ORDER BY rn), '[]'::json)
       FROM product_groups WHERE rn <= $14) AS by_product,
    (SELECT json_build_object(
        'products', COUNT(*), 'sales', COALESCE(SUM(sales), 0),
        'amount_raw', COALESCE(SUM(amount), 0)::text)
       FROM product_groups WHERE rn > $14) AS by_product_other,
    (SELECT COALESCE(json_agg(json_build_object(
        'day', d.day, 'payments', d.payments, 'sales', d.sales, 'revenue_raw', d.revenue_raw::text,
        'without_product_raw', d.without_product_raw::text,
        'in_stripe_raw', d.in_stripe_raw::text,
        'by_product', COALESCE(dp.products, '[]'::json),
        'other_products_raw', COALESCE(dp.other_amount, 0)::text) ORDER BY d.day), '[]'::json)
       FROM (SELECT day,
                    COUNT(*) AS payments,
                    COUNT(*) FILTER (WHERE kind = 'sale') AS sales,
                    SUM(amount) AS revenue_raw,
                    COALESCE(SUM(amount) FILTER (WHERE kind = 'no_product'), 0) AS without_product_raw,
                    COALESCE(SUM(amount) FILTER (WHERE held_by = 'stripe'), 0) AS in_stripe_raw
               FROM pay_days GROUP BY day) d
       LEFT JOIN day_products dp ON dp.day = d.day) AS by_day,
    (SELECT COALESCE(json_agg(json_build_object(
        'payer', payer, 'payments', payments, 'amount_raw', amount::text,
        'last_paid_at', last_paid_at) ORDER BY rn), '[]'::json)
       FROM payer_groups WHERE rn <= $14) AS by_payer,
    (SELECT json_build_object(
        'payers', COUNT(*), 'payments', COALESCE(SUM(payments), 0),
        'amount_raw', COALESCE(SUM(amount), 0)::text)
       FROM payer_groups WHERE rn > $14) AS by_payer_other,
    (SELECT json_build_object(
        'payments', COUNT(*), 'amount_raw', COALESCE(SUM(amount), 0)::text)
       FROM pay_f
      WHERE kind <> 'own_move' AND (several_payers OR payer IS NULL)) AS unattributed,
    (SELECT json_build_object(
        'count', COUNT(*), 'amount_raw', COALESCE(SUM(amount), 0)::text)
       FROM pay_f
      WHERE held_by = 'stripe' AND kind <> 'own_move') AS received_in_stripe`

/** The totals and the three breakdowns for one period and filter set, from one statement. */
export async function readSalesSummary(
  scope: SalesScope,
  period: PeriodBounds,
  filters: SalesFilters = NO_FILTERS,
  db: Executor = pool,
): Promise<SalesSummaryRaw> {
  const result = await db.query<SalesSummaryRaw>(SUMMARY_SQL, [
    ...relationParams(scope, period, null, filters),
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
  filters: SalesFilters = NO_FILTERS,
  db: Executor = pool,
): Promise<PaymentRow[]> {
  const cursor = options.cursor
  const result = await db.query<PaymentRow>(
    `WITH ${PAYMENTS_CTE}
     SELECT ${PAYMENT_COLUMNS}
       FROM pay_f
      WHERE ($14::timestamptz IS NULL OR (block_time, tx_hash) < ($14::timestamptz, $15::text))
      ORDER BY block_time DESC, tx_hash DESC
      LIMIT $16`,
    [
      ...relationParams(scope, period, null, filters),
      cursor === null ? null : cursor.blockTime,
      cursor === null ? null : cursor.txHash,
      options.limit + 1,
    ],
  )
  return result.rows
}

/** #4959: how many payments the filter set has in the period (own moves included, as in the list). */
export async function countPayments(
  scope: SalesScope,
  period: PeriodBounds,
  filters: SalesFilters = NO_FILTERS,
  db: Executor = pool,
): Promise<number> {
  const result = await db.query<{ total: string }>(
    `WITH ${PAYMENTS_CTE} SELECT COUNT(*)::text AS total FROM pay_f`,
    relationParams(scope, period, null, filters),
  )
  return Number(result.rows[0]?.total ?? 0)
}

export interface PeriodFacetsRaw {
  /** Every product with a sale in the period, with its newest record name. */
  products: Array<{ product_id: string; record_name: string | null }>
  /**
   * Every address the payer filter can match in the period: the payer of each
   * single-payer payment, and every leg of each payment from several payers.
   */
  payers: string[]
}

/** #4959: the period's products and payers, unfiltered and uncapped, for the filter menus. */
export async function readPeriodFacets(
  scope: SalesScope,
  period: PeriodBounds,
  db: Executor = pool,
): Promise<PeriodFacetsRaw> {
  const result = await db.query<PeriodFacetsRaw>(
    `WITH ${PAYMENTS_CTE}
     SELECT
       (SELECT COALESCE(json_agg(json_build_object('product_id', product_id, 'record_name', record_name)
                                 ORDER BY product_id), '[]'::json)
          FROM (SELECT product_id,
                       (ARRAY_AGG(product_name ORDER BY block_time DESC, tx_hash DESC))[1] AS record_name
                  FROM pay WHERE kind = 'sale' GROUP BY product_id) pr) AS products,
       (SELECT COALESCE(json_agg(a ORDER BY a), '[]'::json) FROM (
          SELECT payer AS a FROM pay WHERE NOT several_payers AND payer IS NOT NULL
          UNION
          SELECT LOWER(t.payer_address)
            FROM inbound_transfers t
            JOIN pay p ON p.held_by = 'account' AND p.several_payers AND LOWER(t.tx_hash) = p.tx_hash
           WHERE t.account_id = $1 AND t.user_id = $2 AND t.chain_id = $3
             AND t.amount_raw::numeric > 0) x) AS payers`,
    relationParams(scope, period, null, NO_FILTERS),
  )
  return result.rows[0]
}

/**
 * #4959: the products of the period's sale records, for resolving a search
 * term to product ids. Read from `merchant_sales` alone (its account-time
 * index), not through the payment relation: a SUPERSET of the products the
 * relation holds is harmless here, since the ids only feed a match the
 * relation then applies.
 */
export async function listPeriodSaleProducts(
  scope: SalesScope,
  period: PeriodBounds,
  db: Executor = pool,
): Promise<Array<{ product_id: string; record_name: string | null }>> {
  const result = await db.query<{ product_id: string; record_name: string | null }>(
    `SELECT product_id, (ARRAY_AGG(product_name ORDER BY block_time DESC, tx_hash DESC))[1] AS record_name
       FROM merchant_sales
      WHERE account_id = $1 AND user_id = $2 AND chain_id = $3
        AND NOT sender_is_own_address
        AND block_time >= $4::timestamptz AND block_time < $5::timestamptz
      GROUP BY product_id`,
    [
      scope.accountId,
      scope.userId,
      scope.chainId,
      period.from === null ? NO_BOUND_FROM : period.from,
      period.to === null ? NO_BOUND_TO : period.to,
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
    relationParams(scope, { from: null, to: null }, txHash.toLowerCase(), NO_FILTERS),
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
