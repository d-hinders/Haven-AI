/**
 * Data access for owner company details (#3332) — the `owner_company_details`
 * table behind `HAVEN_OWNER_COMPANY_DETAILS`. One row per owner (`user_id` is
 * the PK), read additively into Haven's payment-evidence `parties` block
 * (`openapi/party-model.ts`) and into the settings form.
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

export interface OwnerCompanyDetailsRow {
  user_id: string
  legal_name: string
  country: string
  org_number: string
  vat_number: string | null
  vies_status: ViesStatus | null
  vies_checked_at: string | null
  created_at: string
  updated_at: string
}

export const GET_OWNER_COMPANY_DETAILS_SQL = `
  SELECT user_id, legal_name, country, org_number, vat_number, vies_status, vies_checked_at, created_at, updated_at
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
}

/**
 * One row per user — insert or replace, never a partial update. The route
 * layer reads the existing row first (to decide the vies_status transition),
 * so a partial-update UPSERT would only invite two callers disagreeing about
 * what "unspecified" means for a nullable column.
 */
export const UPSERT_OWNER_COMPANY_DETAILS_SQL = `
  INSERT INTO owner_company_details (user_id, legal_name, country, org_number, vat_number, vies_status, vies_checked_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7)
  ON CONFLICT (user_id) DO UPDATE SET
    legal_name = EXCLUDED.legal_name,
    country = EXCLUDED.country,
    org_number = EXCLUDED.org_number,
    vat_number = EXCLUDED.vat_number,
    vies_status = EXCLUDED.vies_status,
    vies_checked_at = EXCLUDED.vies_checked_at,
    updated_at = NOW()
  RETURNING user_id, legal_name, country, org_number, vat_number, vies_status, vies_checked_at, created_at, updated_at
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
  RETURNING user_id, legal_name, country, org_number, vat_number, vies_status, vies_checked_at, created_at, updated_at
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
 * Rows stuck `pending` for longer than `olderThanMinutes` — a VIES check that
 * crashed or was killed mid-flight before it could ever record an outcome.
 * `GET /user/company-details` re-triggers a check for exactly these rows
 * (#3332 acceptance: never stuck `pending` forever).
 */
export const MARK_VIES_PENDING_SQL = `
  UPDATE owner_company_details
  SET vies_status = 'pending', updated_at = NOW()
  WHERE user_id = $1 AND vat_number IS NOT NULL
  RETURNING user_id, legal_name, country, org_number, vat_number, vies_status, vies_checked_at, created_at, updated_at
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

export const FIND_STALE_PENDING_SQL = `
  SELECT user_id, legal_name, country, org_number, vat_number, vies_status, vies_checked_at, created_at, updated_at
  FROM owner_company_details
  WHERE user_id = $1
    AND vies_status = 'pending'
    AND updated_at < NOW() - ($2 || ' minutes')::INTERVAL
`

export async function findStalePendingForUser(
  userId: string,
  olderThanMinutes: number,
  db: Executor = pool,
): Promise<OwnerCompanyDetailsRow | null> {
  const result = await db.query<OwnerCompanyDetailsRow>(FIND_STALE_PENDING_SQL, [
    userId,
    String(olderThanMinutes),
  ])
  return result.rows[0] ?? null
}

/**
 * #3332 review M3: the atomic counterpart to `findStalePendingForUser` — an
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
  RETURNING user_id, legal_name, country, org_number, vat_number, vies_status, vies_checked_at, created_at, updated_at
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
 * `parties.buyer` block (#3332). Deliberately narrower than the settings row:
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
 * settings form, so a caller must pass `enabled` explicitly rather than this
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
