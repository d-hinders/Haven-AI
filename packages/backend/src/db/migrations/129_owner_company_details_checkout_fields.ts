import type { PoolClient } from 'pg'

export const version = '129_owner_company_details_checkout_fields'

/**
 * 129 — business details gain a receipt email and two structured addresses
 * (#4870, epic #4868).
 *
 * ## Why columns on the existing row, not a table of their own
 *
 * The three fields describe the same owner the row already describes, and
 * they are saved by the same form and the same `PUT /user/company-details`
 * call. A second table would need its own lifecycle, its own erasure path and
 * its own join, to hold at most one row per owner — the cardinality the
 * existing primary key (`user_id`) already enforces. `DELETE
 * /user/company-details` therefore removes them with the row, in the same
 * statement, with no extra code and no way for the two to drift apart.
 *
 * The consequence, stated plainly: an owner with no company row cannot store
 * an email or an address. `legal_name`, `country` and `org_number` are
 * `NOT NULL` and `PUT` requires them, so the three new fields are saved
 * together with those, and the form says so. That is the owner decision this
 * slice records in `docs/product/owner-company-details.md`; the alternative
 * (a separate table keyed on `users(id)`) buys an owner-without-a-company
 * case that no surface asks for yet.
 *
 * ## Why JSONB per address, not fourteen columns
 *
 * The address shape is owned by `docs/architecture/13-checkout-details.md`
 * § *The address shape* — `line1`, `line2`, `line3`, `city`, `postCode`,
 * `subdivision`, `country` — and #4871 returns it verbatim to a merchant.
 * Storing it as one JSONB value per address keeps the stored shape and the
 * wire shape the same object, so a field added to the shape later is a
 * validation change, not a migration. The shape is validated in
 * `modules/owner-profile/service.ts` before it is written; the database
 * stores what the service normalised.
 *
 * ## Existing rows
 *
 * All three columns are nullable with no default and no backfill: a row saved
 * before this migration reads back with `receipt_email = NULL` and both
 * addresses `NULL`, which is exactly "the owner has not saved these yet".
 * Nothing about the existing columns changes, so every existing row stays
 * valid.
 *
 * ## Money path
 *
 * `packages/backend/src/db/migrations/**` is on the money-path perimeter, so
 * this migration is owner-reviewed. It adds storage for data the owner may
 * later share with a merchant; it moves no funds, grants no spend authority,
 * and the new fields are deliberately NOT added to
 * `OWNER_COMPANY_DETAILS_JOIN_COLUMNS`, so `parties.buyer` on payment
 * evidence and settled-payment receipts is unchanged by this slice.
 *
 * ## Numbering
 *
 * 128 is taken by the in-flight #4903 branch (`128_inbound_transfer_identity`),
 * so this takes 129 rather than colliding with it. A gap at 128 is harmless:
 * the runner applies the list in `index.ts` in order and records each version.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE owner_company_details
      ADD COLUMN IF NOT EXISTS receipt_email TEXT NULL,
      ADD COLUMN IF NOT EXISTS billing_address JSONB NULL,
      ADD COLUMN IF NOT EXISTS shipping_address JSONB NULL;
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE owner_company_details
      DROP COLUMN IF EXISTS shipping_address,
      DROP COLUMN IF EXISTS billing_address,
      DROP COLUMN IF EXISTS receipt_email;
  `)
}
