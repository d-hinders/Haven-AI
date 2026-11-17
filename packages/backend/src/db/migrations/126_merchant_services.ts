import type { PoolClient } from 'pg'

export const version = '126_merchant_services'

/**
 * 126 — merchant services: the per-user setting and the per-account marker
 * (#4895, epic #4885).
 *
 * ## Why two homes, not one
 *
 * The feature has two facts with different cardinality, so they live where
 * their cardinality lives:
 *
 * - **The setting is per USER** — "merchant services are on for this person".
 *   It is a row in `merchant_service_settings`, keyed by `user_id`. Turning
 *   the feature off records `enabled = false` and keeps the row: the account
 *   and its history survive, and turning it back on reuses the same account.
 *   `enabled_at` / `disabled_at` are history, not state — `enabled` is the
 *   state. `enabled_at` is when the feature was FIRST turned on and
 *   `disabled_at` is when it was last turned off.
 *
 * - **The marker is per ACCOUNT** — "this account is the one merchant
 *   payments land in". It is a column on `smart_accounts`, because that is
 *   the table the account row already lives in and the marker has to travel
 *   with it through rename, unlink and the account lists. `account_entitlements`
 *   (migration 032) was the other candidate and is the wrong shape: it models
 *   paid add-ons granted by hand, keyed `(user_id, entitlement)`, with no
 *   account dimension at all.
 *
 * ## One merchant account per user, enforced by the database
 *
 * `smart_accounts_one_merchant_per_user` is a PARTIAL unique index on
 * `(user_id) WHERE is_merchant_account`. The route checks for an existing
 * merchant account before it creates one, but a check is not an invariant:
 * two concurrent turn-ons, or a future caller that forgets the check, would
 * otherwise be able to mark two accounts. The index makes the second mark a
 * `23505` instead of a second merchant account. It is partial so the
 * non-merchant rows cost nothing and stay unconstrained.
 *
 * ## Money path
 *
 * The marker decides which account merchant payments are received into, so a
 * change to it is a money-path change. Nothing here moves funds: the column
 * is a pointer, and the account it points at is an ordinary `smart_accounts`
 * row with the same signer rules as any other.
 *
 * ## Backfill
 *
 * None, deliberately. `is_merchant_account` defaults to `false`, which is the
 * honest state for every existing account — no user had merchant services
 * before this migration, so no row is a merchant account. The setting table
 * starts empty; a missing row reads as `enabled = false`.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE smart_accounts
      ADD COLUMN IF NOT EXISTS is_merchant_account BOOLEAN NOT NULL DEFAULT false;
  `)
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS smart_accounts_one_merchant_per_user
      ON smart_accounts (user_id)
      WHERE is_merchant_account;
  `)
  await client.query(`
    CREATE TABLE IF NOT EXISTS merchant_service_settings (
      user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      enabled     BOOLEAN NOT NULL DEFAULT false,
      enabled_at  TIMESTAMPTZ NULL,
      disabled_at TIMESTAMPTZ NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS merchant_service_settings;`)
  await client.query(`DROP INDEX IF EXISTS smart_accounts_one_merchant_per_user;`)
  await client.query(`ALTER TABLE smart_accounts DROP COLUMN IF EXISTS is_merchant_account;`)
}
