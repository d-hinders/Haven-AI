import type { PoolClient } from 'pg'

export const version = '127_merchant_keys'

/**
 * 127 — the receive-only merchant key (#4896, epic #4885).
 *
 * ## Its own table, never `agents`
 *
 * A merchant key is not an agent key. It authenticates the merchant's server
 * to the merchant routes (sales ingest, #4897) and nothing else: it cannot
 * move funds, sign, change signers, budgets or agents, and it reads nothing
 * about the account except what those routes return. Storing it in `agents`
 * would put it behind `agentAuthMiddleware`, whose whole contract is spend
 * authority — the exact confusion the separate prefix (`sk_merchant_`) and
 * this table exist to prevent. The prefix is fixed here, not taken from the
 * mockup's display name, because it goes into two published packages' secret
 * scrubbers (`@haven_ai/cli`, `@haven_ai/connect`).
 *
 * ## Only a hash and a prefix
 *
 * `key_hash` is the SHA-256 hex of the secret, the same shape `agents` uses
 * (`api_key_hash`), and it is UNIQUE: one row per secret. `key_prefix` is the
 * display prefix the list returns — `sk_merchant_` plus the first twelve hex
 * characters — and it is never enough to authenticate. The secret itself is
 * returned by the create call and by no later read; nothing here can produce
 * it again.
 *
 * ## Bound to one merchant account
 *
 * `account_id` references `smart_accounts` and is the account the key acts
 * for. The middleware resolves the account from the key row, never from the
 * request, so a key cannot name another account — including the same user's
 * other accounts. The row is scoped to `user_id` as well, and the auth query
 * joins on `sa.user_id = mk.user_id`, so a key whose account was somehow
 * reassigned resolves to nothing.
 *
 * ## Who created it, who revoked it
 *
 * `created_by` / `created_at` and `revoked_by` / `revoked_at` are recorded on
 * the row. There is no owner-action audit table today and this slice does not
 * add one; these four columns are the record. The CHECK keeps the pair
 * honest: a row is either revoked (both set) or not (both null), never half.
 *
 * ## Last used
 *
 * `last_used_at` is written by the merchant routes' `onResponse` hook, at most
 * once a minute per key (the throttle is in the UPDATE's WHERE clause, so a
 * busy kit does not cause a write per call). It is only written for an
 * ACCEPTED request (a 2xx answer), which is what the mockup's list shows.
 *
 * ## Money path
 *
 * The key is a credential for the receive side: it can describe payments that
 * already reached its account, and it cannot create one. Nothing here moves
 * funds or grants authority. The table is on the money-path perimeter through
 * `db/migrations/**`; the check and the routes are listed individually.
 *
 * ## Backfill
 *
 * None. No merchant key existed before this migration, so the table starts
 * empty.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS merchant_keys (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id   UUID NOT NULL REFERENCES smart_accounts(id) ON DELETE CASCADE,
      key_hash     VARCHAR(64) NOT NULL UNIQUE,
      key_prefix   VARCHAR(32) NOT NULL,
      created_by   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_by   UUID NULL REFERENCES users(id) ON DELETE CASCADE,
      revoked_at   TIMESTAMPTZ NULL,
      last_used_at TIMESTAMPTZ NULL,
      CONSTRAINT merchant_keys_revocation_pair
        CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
    );
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_merchant_keys_user
      ON merchant_keys (user_id, created_at DESC);
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_merchant_keys_account
      ON merchant_keys (account_id);
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS merchant_keys;`)
}
