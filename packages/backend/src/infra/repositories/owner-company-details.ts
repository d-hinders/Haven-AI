/**
 * Data access for owner company details (#3332) — the `owner_company_details`
 * table behind `HAVEN_OWNER_COMPANY_DETAILS`. One row per owner (`user_id` is
 * the PK), read additively into Haven's payment-evidence `parties` block
 * (`openapi/party-model.ts`) and returned by `/user/company-details`.
 *
 * Every function takes the owner's `userId` and filters on it — there is no
 * other user's row a caller can reach through this module, by construction of
 * the primary key.
 */

import pool from '../../db.js'
import type { Executor } from '../transaction.js'
import type { PartiesBuyer } from '../../openapi/party-model.js'

export type { Executor }

export type ViesStatus = 'pending' | 'valid' | 'invalid' | 'not_verifiable'

/**
 * The structured address shape (#4870), owned by
 * `docs/architecture/13-checkout-details.md` § *The address shape* and stored
 * verbatim as one JSONB value per address. `line1`, `city` and `country` are
 * required; the rest are omitted from the JSON when the owner left them
 * blank — never stored as `null` or as an empty string.
 */
export interface OwnerAddress {
  line1: string
  line2?: string
  line3?: string
  city: string
  postCode?: string
  subdivision?: string
  /** ISO 3166-1 alpha-2, uppercase. */
  country: string
}

export interface OwnerCompanyDetailsRow {
  user_id: string
  legal_name: string
  country: string
  org_number: string
  vat_number: string | null
  vies_status: ViesStatus | null
  vies_checked_at: string | null
  /** #4870: optional, stored only when the owner saves one. */
  receipt_email: string | null
  /** #4870: optional structured address, `null` when not saved. */
  billing_address: OwnerAddress | null
  /** #4870: optional structured address, `null` when not saved. */
  shipping_address: OwnerAddress | null
  created_at: string
  updated_at: string
}

/**
 * The stored row's columns, in one place: every statement below returns the
 * same shape, and a column added to the table is added here once rather than
 * to five `RETURNING` lists that can drift apart.
 */
const ROW_COLUMNS = `user_id, legal_name, country, org_number, vat_number, vies_status, vies_checked_at,
  receipt_email, billing_address, shipping_address, created_at, updated_at`

export const GET_OWNER_COMPANY_DETAILS_SQL = `
  SELECT ${ROW_COLUMNS}
  FROM owner_company_details
  WHERE user_id = $1
`

export async function getOwnerCompanyDetails(
  userId: string,
  db: Executor = pool,
): Promise<OwnerCompanyDetailsRow | null> {
  const result = await db.query<OwnerCompanyDetailsRow>(GET_OWNER_COMPANY_DETAILS_SQL, [userId])
  return result.rows[0] ?? null
}

export interface UpsertOwnerCompanyDetailsInput {
  legal_name: string
  country: string
  org_number: string
  /** Normalised (uppercase, no spaces) by the caller before this is reached. Null clears it. */
  vat_number: string | null
  /**
   * The caller decides the resulting status: `'pending'` when `vat_number` is
   * set or changed (a check is about to run), `null` when it is cleared, and
   * unchanged (pass the previous value) when the VAT number did not change.
   */
  vies_status: ViesStatus | null
  vies_checked_at: string | null
  /**
   * #4870. Required, not optional, for the same reason every other field is:
   * this write REPLACES the row. The route's "omitted keeps, `null` clears"
   * rule is resolved in `modules/owner-profile/service.ts`, which reads the
   * previous row and passes the merged value here — so a caller that forgets
   * one of these cannot silently wipe it, because it does not compile.
   */
  receipt_email: string | null
  billing_address: OwnerAddress | null
  shipping_address: OwnerAddress | null
}

/**
 * One row per user — insert or replace, never a partial update. The route
 * layer reads the existing row first (to decide the vies_status transition,
 * and since #4870 to merge the three optional fields the request omitted), so
 * a partial-update UPSERT would only invite two callers disagreeing about
 * what "unspecified" means for a nullable column.
 */
export const UPSERT_OWNER_COMPANY_DETAILS_SQL = `
  INSERT INTO owner_company_details (user_id, legal_name, country, org_number, vat_number, vies_status, vies_checked_at,
    receipt_email, billing_address, shipping_address)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
  ON CONFLICT (user_id) DO UPDATE SET
    legal_name = EXCLUDED.legal_name,
    country = EXCLUDED.country,
    org_number = EXCLUDED.org_number,
    vat_number = EXCLUDED.vat_number,
    vies_status = EXCLUDED.vies_status,
    vies_checked_at = EXCLUDED.vies_checked_at,
    receipt_email = EXCLUDED.receipt_email,
    billing_address = EXCLUDED.billing_address,
    shipping_address = EXCLUDED.shipping_address,
    updated_at = NOW()
  RETURNING ${ROW_COLUMNS}
`

export async function upsertOwnerCompanyDetails(
  userId: string,
  input: UpsertOwnerCompanyDetailsInput,
  db: Executor = pool,
): Promise<OwnerCompanyDetailsRow> {
  const result = await db.query<OwnerCompanyDetailsRow>(UPSERT_OWNER_COMPANY_DETAILS_SQL, [
    userId,
    input.legal_name,
    input.country,
    input.org_number,
    input.vat_number,
    input.vies_status,
    input.vies_checked_at,
    input.receipt_email,
    // Explicit JSON, never a bare object: node-postgres would serialise it
    // too, but saying so here keeps the jsonb column's value unambiguous at
    // the call site and independent of the driver's own coercion rules.
    input.billing_address === null ? null : JSON.stringify(input.billing_address),
    input.shipping_address === null ? null : JSON.stringify(input.shipping_address),
  ])
  return result.rows[0]
}

export const DELETE_OWNER_COMPANY_DETAILS_SQL = `
  DELETE FROM owner_company_details WHERE user_id = $1
`

/** True if a row existed and was deleted. */
export async function deleteOwnerCompanyDetails(userId: string, db: Executor = pool): Promise<boolean> {
  const result = await db.query(DELETE_OWNER_COMPANY_DETAILS_SQL, [userId])
  return (result.rowCount ?? 0) > 0
}

/**
 * #3332 review M1 (stale-result race): bound to the row `vatNumber` was
 * ACTUALLY checked for, and only while it is still `pending` — not merely
 * `user_id`. Without `AND vat_number = $4 AND vies_status = 'pending'`, a
 * check started for VAT number A can land on the row after the owner has
 * since changed it to VAT number B (a new `pending` check for B is already
 * running) or cleared it entirely (`vat_number IS NULL`) — reproduced: a
 * `not_verifiable`/`valid`/`invalid` result for a number the row no longer
 * holds would otherwise overwrite the CURRENT status (or resurrect one on a
 * cleared row), and that wrong result reaches `parties.buyer` on receipts.
 */
export const SET_VIES_RESULT_SQL = `
  UPDATE owner_company_details
  SET vies_status = $2, vies_checked_at = $3, updated_at = NOW()
  WHERE user_id = $1 AND vat_number = $4 AND vies_status = 'pending'
  RETURNING ${ROW_COLUMNS}
`

/**
 * Records a completed (or timed-out/errored, as `not_verifiable`) VIES check
 * for `vatNumber` — the number the caller (`runViesCheck`) actually ran the
 * check against. Null when the row was deleted, the VAT number changed, or
 * the row was already resolved out of `pending` while this check was in
 * flight (`SET_VIES_RESULT_SQL`'s own guard) — the caller must not resurrect
 * a row the owner removed, nor overwrite a status for a different VAT number.
 */
export async function setViesResult(
  userId: string,
  status: ViesStatus,
  checkedAt: string,
  vatNumber: string,
  db: Executor = pool,
): Promise<OwnerCompanyDetailsRow | null> {
  const result = await db.query<OwnerCompanyDetailsRow>(SET_VIES_RESULT_SQL, [userId, status, checkedAt, vatNumber])
  return result.rows[0] ?? null
}

/**
 * Marks a row `pending` ahead of an explicit re-check (`POST
 * /user/company-details/vies-check`) — also used to mark a row that crashed
 * or was killed mid-flight before it could ever record an outcome, so `GET
 * /user/company-details` can re-trigger it (#3332 acceptance: never stuck
 * `pending` forever).
 *
 * `vies_checked_at = NULL` (#3332 review N1): a check that is currently
 * `pending` has no completion time yet — the doc's own invariant
 * ("`vies_checked_at` … never set while `vies_status` is `pending`") was
 * false for this path before this line existed, because a re-check left the
 * PREVIOUS check's `vies_checked_at` sitting on the row all the way through
 * the new `pending` window. Cleared here the same way `writeCompanyDetails`
 * already clears it when a write starts a fresh check.
 */
export const MARK_VIES_PENDING_SQL = `
  UPDATE owner_company_details
  SET vies_status = 'pending', vies_checked_at = NULL, updated_at = NOW()
  WHERE user_id = $1 AND vat_number IS NOT NULL
  RETURNING ${ROW_COLUMNS}
`

/**
 * Marks the row `pending` ahead of an explicit re-check (`POST
 * /user/company-details/vies-check`). Null if there is no row, or the row has
 * no VAT number to check.
 */
export async function markViesPending(userId: string, db: Executor = pool): Promise<OwnerCompanyDetailsRow | null> {
  const result = await db.query<OwnerCompanyDetailsRow>(MARK_VIES_PENDING_SQL, [userId])
  return result.rows[0] ?? null
}

/**
 * #3332 review M3: an atomic stale-pending claim — an
 * UPDATE, not a SELECT, so two concurrent callers (two `GET
 * /user/company-details` requests racing) can never both claim the same
 * stale row. Bumping `updated_at` to `NOW()` in the SAME statement that reads
 * the row is what makes this atomic: Postgres takes the row lock and
 * re-evaluates the WHERE clause under read-committed isolation, so a second
 * concurrent UPDATE against the same row blocks until the first commits, then
 * sees the now-fresh `updated_at` and matches zero rows — the second caller
 * gets `null` and starts no check of its own. The first caller's claim is
 * indistinguishable on the wire from an ordinary read (the returned row is
 * unchanged apart from `updated_at`), so this is safe to call from a GET.
 */
export const CLAIM_STALE_PENDING_SQL = `
  UPDATE owner_company_details
  SET updated_at = NOW()
  WHERE user_id = $1
    AND vies_status = 'pending'
    AND vat_number IS NOT NULL
    AND updated_at < NOW() - ($2 || ' minutes')::INTERVAL
  RETURNING ${ROW_COLUMNS}
`

export async function claimStalePendingForUser(
  userId: string,
  olderThanMinutes: number,
  db: Executor = pool,
): Promise<OwnerCompanyDetailsRow | null> {
  const result = await db.query<OwnerCompanyDetailsRow>(CLAIM_STALE_PENDING_SQL, [
    userId,
    String(olderThanMinutes),
  ])
  return result.rows[0] ?? null
}

/**
 * The buyer-party fields joined by `user_id`, for the payment-evidence
 * `parties.buyer` block (#3332). Deliberately narrower than the stored row:
 * no timestamps but `created_at`/`updated_at`, since a receipt states what the
 * details ARE, not their record-keeping history.
 */
export interface BuyerPartyFields {
  legal_name: string
  country: string
  org_number: string
  vat_number: string | null
  vies_status: ViesStatus | null
  vies_checked_at: string | null
}

/** SQL fragment a caller LEFT JOINs on `<alias>.user_id = <ownerIdExpr>`, aliased `ocd`. */
export const OWNER_COMPANY_DETAILS_JOIN_COLUMNS = `
  ocd.legal_name AS buyer_legal_name,
  ocd.country AS buyer_country,
  ocd.org_number AS buyer_org_number,
  ocd.vat_number AS buyer_vat_number,
  ocd.vies_status AS buyer_vies_status,
  ocd.vies_checked_at AS buyer_vies_checked_at
`

/** The row shape `OWNER_COMPANY_DETAILS_JOIN_COLUMNS` adds to whatever it is joined onto. */
export interface BuyerJoinColumns {
  buyer_legal_name: string | null
  buyer_country: string | null
  buyer_org_number: string | null
  buyer_vat_number: string | null
  buyer_vies_status: ViesStatus | null
  buyer_vies_checked_at: string | null
}

/**
 * `undefined` (never present on the wire) unless the LEFT JOIN matched AND
 * the caller says the feature is on — the flag gates the FIELD, not just the
 * company-details routes, so a caller must pass `enabled` explicitly rather than this
 * function reading `config` itself (this module has no business knowing
 * about `config.ts`, and a repository that reads config is untestable
 * without booting the whole app).
 */
export function buyerPartyFromJoin(row: BuyerJoinColumns, enabled: boolean): PartiesBuyer | undefined {
  if (!enabled) return undefined
  if (row.buyer_legal_name === null || row.buyer_country === null || row.buyer_org_number === null) {
    return undefined
  }
  return {
    legal_name: row.buyer_legal_name,
    country: row.buyer_country,
    org_number: row.buyer_org_number,
    vat_number: row.buyer_vat_number,
    vies_status: row.buyer_vies_status,
    vies_checked_at: row.buyer_vies_checked_at,
  }
}
