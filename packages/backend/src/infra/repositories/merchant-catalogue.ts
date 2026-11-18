/**
 * The merchant's product list and the deployment address it was read from
 * (#4899, epic #4885).
 *
 * Two tables, both keyed on the merchant ACCOUNT (migration 130 says why they
 * are not `merchant_catalog`): `merchant_catalogue_sources` holds the address
 * the owner saved and the outcome of the last read, `merchant_products` holds
 * the list itself.
 *
 * Every function takes `merchantAccountId` as a REQUIRED parameter and every
 * statement scopes on it, per this directory's README. The executor comes last
 * and defaults to the pool, so a caller can thread its own transaction through.
 *
 * Nothing here writes `merchant_catalog`, and nothing here reads a `pay_to`
 * from merchant-supplied data into a payment decision: the document's
 * `pay_to` is stored as a LABEL on the source row so the owner can see which
 * deployment the list came from, and it is compared against the account's own
 * address — never used as a recipient.
 */
import pool from '../../db.js'
import { withTransaction, type Executor } from '../transaction.js'

/** The outcome of one read of the discovery document. */
export type MerchantCatalogueReadStatus = 'never' | 'ok' | 'unreachable' | 'malformed' | 'mismatch' | 'refused'

export interface MerchantCatalogueSourceRow {
  merchant_account_id: string
  deployment_url: string
  last_read_at: Date | string | null
  last_read_status: MerchantCatalogueReadStatus
  last_read_detail: string | null
  document_pay_to: string | null
  document_network: string | null
  document_name: string | null
  document_operator_name: string | null
  document_updated: string | null
  mismatch: boolean
  mismatch_reason: string | null
  created_at: Date | string
  updated_at: Date | string
}

export interface MerchantProductRow {
  merchant_account_id: string
  product_id: string
  name: string | null
  description: string | null
  route: string | null
  model: string | null
  price_atomic: string
  network: string
  output_token_cap: number | null
  offered: boolean
  first_seen_at: Date | string
  last_seen_at: Date | string
  removed_at: Date | string | null
}

/** One product as the document spells it, already validated by the module. */
export interface MerchantProductInput {
  productId: string
  name: string | null
  description: string | null
  route: string | null
  model: string | null
  priceAtomic: string
  network: string
  outputTokenCap: number | null
}

/** A source row joined with the account it belongs to — what the tick needs. */
export interface MerchantCatalogueSourceWithAccount extends MerchantCatalogueSourceRow {
  account_address: string
  chain_id: number
}

const SOURCE_COLUMNS = `merchant_account_id, deployment_url, last_read_at, last_read_status,
       last_read_detail, document_pay_to, document_network, document_name,
       document_operator_name, document_updated, mismatch, mismatch_reason,
       created_at, updated_at`

const PRODUCT_COLUMNS = `merchant_account_id, product_id, name, description, route, model,
       price_atomic, network, output_token_cap, offered, first_seen_at,
       last_seen_at, removed_at`

export const FIND_CATALOGUE_SOURCE_SQL = `SELECT ${SOURCE_COLUMNS}
       FROM merchant_catalogue_sources
       WHERE merchant_account_id = $1`

/** Lock the source row for the rest of the transaction (see `saveCatalogueDeployment`). */
export const LOCK_CATALOGUE_SOURCE_SQL = `SELECT ${SOURCE_COLUMNS}
       FROM merchant_catalogue_sources
       WHERE merchant_account_id = $1
       FOR UPDATE`

export const UPSERT_CATALOGUE_SOURCE_SQL = `INSERT INTO merchant_catalogue_sources (merchant_account_id, deployment_url)
       VALUES ($1, $2)
       ON CONFLICT (merchant_account_id) DO UPDATE
         SET deployment_url = EXCLUDED.deployment_url,
             updated_at = NOW()
       RETURNING ${SOURCE_COLUMNS}`

/**
 * A NEW address invalidates the list the OLD one produced. The rows are kept
 * and marked not offered rather than deleted: a past sale still names its
 * product, and the name lives here.
 */
export const RETIRE_ALL_PRODUCTS_SQL = `UPDATE merchant_products
       SET offered = false,
           removed_at = COALESCE(removed_at, NOW())
       WHERE merchant_account_id = $1 AND offered`

export const RECORD_CATALOGUE_READ_SQL = `UPDATE merchant_catalogue_sources
       SET last_read_at = $2,
           last_read_status = $3,
           last_read_detail = $4,
           mismatch = $5,
           mismatch_reason = $6,
           document_pay_to = COALESCE($7, document_pay_to),
           document_network = COALESCE($8, document_network),
           document_name = COALESCE($9, document_name),
           document_operator_name = COALESCE($10, document_operator_name),
           document_updated = COALESCE($11, document_updated),
           updated_at = NOW()
       WHERE merchant_account_id = $1
       RETURNING ${SOURCE_COLUMNS}`

export const UPSERT_PRODUCT_SQL = `INSERT INTO merchant_products
         (merchant_account_id, product_id, name, description, route, model,
          price_atomic, network, output_token_cap, offered, first_seen_at, last_seen_at, removed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10, $10, NULL)
       ON CONFLICT (merchant_account_id, product_id) DO UPDATE
         SET name = EXCLUDED.name,
             description = EXCLUDED.description,
             route = EXCLUDED.route,
             model = EXCLUDED.model,
             price_atomic = EXCLUDED.price_atomic,
             network = EXCLUDED.network,
             output_token_cap = EXCLUDED.output_token_cap,
             offered = true,
             last_seen_at = EXCLUDED.last_seen_at,
             removed_at = NULL`

/**
 * Mark every product the document no longer lists as not offered. `product_id
 * <> ALL($2)` with an empty array is true for every row, which is the correct
 * answer for a document that lists nothing.
 */
export const RETIRE_MISSING_PRODUCTS_SQL = `UPDATE merchant_products
       SET offered = false,
           removed_at = COALESCE(removed_at, $2)
       WHERE merchant_account_id = $1
         AND offered
         AND product_id <> ALL($3::text[])`

export const LIST_PRODUCTS_SQL = `SELECT ${PRODUCT_COLUMNS}
       FROM merchant_products
       WHERE merchant_account_id = $1
       ORDER BY offered DESC, product_id ASC`

/**
 * The labelling lookup the sales reads use (#4897): the catalogue's name for a
 * product id, whether or not it is still offered. Null means "not in the
 * catalogue", and the caller falls back to the name in the sale record.
 */
export const FIND_PRODUCT_NAME_SQL = `SELECT name
       FROM merchant_products
       WHERE merchant_account_id = $1 AND product_id = $2`

/** Every configured source, with the account address and chain the read needs. */
export const LIST_CATALOGUE_SOURCES_SQL = `SELECT s.merchant_account_id, s.deployment_url, s.last_read_at,
              s.last_read_status, s.last_read_detail, s.document_pay_to,
              s.document_network, s.document_name, s.document_operator_name,
              s.document_updated, s.mismatch, s.mismatch_reason,
              s.created_at, s.updated_at,
              a.account_address, a.chain_id
       FROM merchant_catalogue_sources s
       JOIN smart_accounts a ON a.id = s.merchant_account_id
       ORDER BY s.merchant_account_id`

/** The account's source row, or null when the owner has not saved an address. */
export async function findCatalogueSource(
  merchantAccountId: string,
  db: Executor = pool,
): Promise<MerchantCatalogueSourceRow | null> {
  const result = await db.query<MerchantCatalogueSourceRow>(FIND_CATALOGUE_SOURCE_SQL, [merchantAccountId])
  return result.rows[0] ?? null
}

/**
 * Save the owner's deployment address.
 *
 * A CHANGED address retires the list the old one produced, in the same
 * transaction: the products belong to the deployment they were read from, and
 * leaving them offered would show the owner a catalogue their new address does
 * not serve. The row lock makes two concurrent saves serialise, so the second
 * one sees the first one's address rather than both reading the old value.
 *
 * Returns the row and whether the address changed.
 */
export async function saveCatalogueDeployment(
  params: { merchantAccountId: string; deploymentUrl: string },
  db: Executor = pool,
): Promise<{ source: MerchantCatalogueSourceRow; changed: boolean }> {
  return withTransaction(db, async (tx) => {
    const existing = await tx.query<MerchantCatalogueSourceRow>(LOCK_CATALOGUE_SOURCE_SQL, [
      params.merchantAccountId,
    ])
    const previous = existing.rows[0] ?? null
    const changed = previous !== null && previous.deployment_url !== params.deploymentUrl
    const upserted = await tx.query<MerchantCatalogueSourceRow>(UPSERT_CATALOGUE_SOURCE_SQL, [
      params.merchantAccountId,
      params.deploymentUrl,
    ])
    if (changed) {
      await tx.query(RETIRE_ALL_PRODUCTS_SQL, [params.merchantAccountId])
    }
    return { source: upserted.rows[0], changed }
  })
}

/**
 * Record the outcome of one read. The `document_*` columns are only written
 * when the caller passes a value, so a failed read leaves the last GOOD
 * document's identity in place — the owner still sees which deployment the
 * list came from.
 */
export async function recordCatalogueRead(
  params: {
    merchantAccountId: string
    readAt: Date
    status: MerchantCatalogueReadStatus
    detail: string | null
    mismatch: boolean
    mismatchReason: string | null
    document?: {
      payTo: string
      network: string
      name: string | null
      operatorName: string | null
      updated: string | null
    }
  },
  db: Executor = pool,
): Promise<MerchantCatalogueSourceRow | null> {
  const doc = params.document
  const result = await db.query<MerchantCatalogueSourceRow>(RECORD_CATALOGUE_READ_SQL, [
    params.merchantAccountId,
    params.readAt,
    params.status,
    params.detail,
    params.mismatch,
    params.mismatchReason,
    doc?.payTo ?? null,
    doc?.network ?? null,
    doc?.name ?? null,
    doc?.operatorName ?? null,
    doc?.updated ?? null,
  ])
  return result.rows[0] ?? null
}

/**
 * Write one document's product list: upsert every product it lists, then mark
 * every product it no longer lists as not offered. One transaction, so a
 * reader never sees a half-replaced list.
 */
export async function replaceCatalogueProducts(
  params: { merchantAccountId: string; products: readonly MerchantProductInput[]; readAt: Date },
  db: Executor = pool,
): Promise<void> {
  await withTransaction(db, async (tx) => {
    for (const product of params.products) {
      await tx.query(UPSERT_PRODUCT_SQL, [
        params.merchantAccountId,
        product.productId,
        product.name,
        product.description,
        product.route,
        product.model,
        product.priceAtomic,
        product.network,
        product.outputTokenCap,
        params.readAt,
      ])
    }
    await tx.query(RETIRE_MISSING_PRODUCTS_SQL, [
      params.merchantAccountId,
      params.readAt,
      params.products.map((p) => p.productId),
    ])
  })
}

/** The account's product list, offered first. */
export async function listCatalogueProducts(
  merchantAccountId: string,
  db: Executor = pool,
): Promise<MerchantProductRow[]> {
  const result = await db.query<MerchantProductRow>(LIST_PRODUCTS_SQL, [merchantAccountId])
  return result.rows
}

/**
 * The catalogue's name for a product id, or null when the catalogue does not
 * know it. A product that is no longer offered still answers: a past sale
 * keeps its name.
 */
export async function findCatalogueProductName(
  merchantAccountId: string,
  productId: string,
  db: Executor = pool,
): Promise<string | null> {
  const result = await db.query<{ name: string | null }>(FIND_PRODUCT_NAME_SQL, [merchantAccountId, productId])
  return result.rows[0]?.name ?? null
}

/** Every configured source, with the account address and chain the read needs. */
export async function listCatalogueSources(
  db: Executor = pool,
): Promise<MerchantCatalogueSourceWithAccount[]> {
  const result = await db.query<MerchantCatalogueSourceWithAccount>(LIST_CATALOGUE_SOURCES_SQL)
  return result.rows
}
