import type { PoolClient } from 'pg'

/**
 * 098 — owner company details (#3332), behind `HAVEN_OWNER_COMPANY_DETAILS`.
 *
 * Keyed on `user_id` (PK, not a surrogate id) — one row per owner, matching
 * migration 080:63's recorded decision that there is no organisation entity
 * above the user yet. This is NOT the `agent_organizations` folder tree
 * (migration 094): that tree groups an owner's OWN agents; this table is the
 * owner's own onboarding data, read into Haven's payment evidence `parties`
 * block additively (`openapi/party-model.ts`) so an agent's receipt can state
 * who it is paying for.
 *
 * `ON DELETE CASCADE` on `user_id`: IF the owner's account is ever deleted,
 * these details go with it — the row has no meaning once the account it
 * describes is gone. Pinned by the real-DB migration test's cascade case.
 * That said, account deletion is an OPERATOR action today — there is no
 * self-serve delete-my-account route — so this cascade is not itself an
 * erasure path an owner can reach; `DELETE /user/company-details`
 * (`routes/owner-company-details.ts`, deliberately NOT gated by
 * `HAVEN_OWNER_COMPANY_DETAILS`) is the one the owner actually has. Two
 * OTHER tables reference `users(id)` with no `ON DELETE` action at all
 * (`payment_intents.user_id`, `agent_rekeys.initiated_by_user_id`) —
 * whichever future flow implements self-serve account deletion will need to
 * delete rows here (and everywhere else with an FK to `users`) explicitly
 * before it can rely on this cascade.
 *
 * `vat_number` is stored NORMALISED (uppercase, no spaces) so an equality
 * lookup and the VIES request never have to re-derive that shape at read
 * time; the CHECK enforces the shape is already normalised on write rather
 * than trusting every caller to normalise before insert.
 *
 * `vies_status` is one of `pending` (a check is in flight or overdue for
 * one), `valid`, `invalid`, or `not_verifiable` — an EU-side outage or a
 * timeout is `not_verifiable`, never `invalid` (owner decision recorded in
 * the issue: a busy VIES endpoint must never be read as "this VAT number is
 * wrong"). NULL means no VAT number has ever been submitted.
 */
export const version = '098_owner_company_details'

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS owner_company_details (
      user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      legal_name       VARCHAR(200) NOT NULL,
      -- VARCHAR(8), not (2): the CHECK below is the actual length/shape
      -- enforcer (and must fire with a real error code, 23514, rather than
      -- Postgres truncating first with 22001) — the column width only needs
      -- to be no narrower than the widest input the CHECK will ever refuse.
      country          VARCHAR(8) NOT NULL,
      org_number       VARCHAR(32) NOT NULL,
      vat_number       VARCHAR(32),
      vies_status      VARCHAR(16),
      vies_checked_at  TIMESTAMPTZ,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT owner_company_details_country_chk
        CHECK (country = UPPER(country) AND country ~ '^[A-Z]{2}$'),
      CONSTRAINT owner_company_details_legal_name_chk
        CHECK (length(btrim(legal_name)) BETWEEN 1 AND 200),
      CONSTRAINT owner_company_details_org_number_chk
        CHECK (length(btrim(org_number)) BETWEEN 1 AND 32),
      CONSTRAINT owner_company_details_vat_number_chk
        CHECK (vat_number IS NULL OR (
          vat_number = UPPER(vat_number)
          AND vat_number !~ '\\s'
          AND vat_number ~ '^[A-Z]{2}[A-Z0-9]{2,20}$'
        )),
      CONSTRAINT owner_company_details_vies_status_chk
        CHECK (vies_status IS NULL OR vies_status IN ('pending', 'valid', 'invalid', 'not_verifiable'))
    )
  `)
}

/** Structural down (#1139): drops exactly what this migration created. */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS owner_company_details`)
}
