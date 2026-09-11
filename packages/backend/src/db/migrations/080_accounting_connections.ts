import type { PoolClient } from 'pg'

export const version = '080_accounting_connections'

/**
 * Provider-generic accounting connections, encrypted-at-rest ready, and the
 * two renames slice 1 deferred (#2860, epic #2858). The epic's ONE migration.
 *
 * ## Schema-only, and it reads no environment. That is the design, not an
 * ## omission.
 *
 * `runMigrations()` runs at boot on EVERY replica (`index.ts`), prod included,
 * and CI applies the full set with only `DATABASE_URL` in the environment. A
 * migration that needed `HAVEN_SECRETS_KEY` to encrypt rows as it copied them
 * would refuse to start the prod backend — for a feature prod only shows as
 * Coming soon — and would fail every backend test run until CI grew the
 * secret. So rows are copied AS-IS, stamped `secrets_key_version = 0`
 * ("plaintext, encrypt on next write"), and encryption happens at the
 * application layer: a boot-time job re-encrypts version-0 rows when the key
 * is present, and NEW writes fail closed without one (`infra/secrets.ts`).
 * Prod and CI hold zero rows, so nothing there fails and nothing is left
 * unprotected. Dev's rows stay exactly as exposed as they are today until the
 * operator sets the key — no worse, and one boot away from better.
 *
 * ## Rename, not drop
 *
 * `fortnox_connections` becomes `fortnox_connections_retired`. The hazard is
 * specific: a rolling deploy with overlap, where OLD replicas still serve —
 * and can write a connection — while a new replica runs this. Every replica
 * migrates before it listens (`docs/operations/backend-scaling.md`), so new
 * code never writes during the window, but an old replica's insert committing
 * between the copy's read and a drop would be lost with the table. With a
 * rename inside the same transaction nothing committed is lost, and a
 * deploy-level rollback fails loudly at boot on the missing table name instead
 * of silently reading an empty one (a drop's `down()` recreates the table —
 * empty). #2872 drops the retired table after the product verification.
 *
 * ## One active destination per user
 *
 * A user may hold several connections (Fortnox today; Accounted, Light,
 * Igdrasil later) but exactly one is where settled payments go. A partial
 * unique index on `(user_id) WHERE is_active_destination` makes a second
 * active row a constraint violation rather than a repository convention.
 *
 * ## `user_id`, not `account_id`
 *
 * Owner decision 2026-09-11: no organisation entity above the user yet. The
 * key is `user_id` today; when an account entity lands, `account_id` replaces
 * it by adding the column and repointing the unique constraints — a data
 * rewrite is not needed because nothing here derives from the user beyond the
 * foreign key.
 *
 * ## The two names #2859 left behind
 *
 * `reporting_feed_syncs` → `accounting_feed_syncs` (table and its index), and
 * `reporting_feed` → `accounting_feed` in `account_entitlements`. The
 * repository SQL and the entitlement constant flip in the same deploy, so dev
 * availability never has a gap.
 *
 * No `pg_constraint` lookups: #2702's lint refuses an unscoped one, and
 * `IF NOT EXISTS` on the table and indexes is enough here.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS accounting_connections (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider              TEXT NOT NULL,
      auth_kind             TEXT NOT NULL,
      secrets_ciphertext    BYTEA,
      secrets_key_version   SMALLINT NOT NULL DEFAULT 0,
      external_company_id   TEXT,
      external_company_name TEXT,
      base_currency         CHAR(3),
      status                TEXT NOT NULL DEFAULT 'connected',
      status_reason         TEXT,
      granted_scope         TEXT,
      token_expires_at      TIMESTAMPTZ,
      is_active_destination BOOLEAN NOT NULL DEFAULT false,
      feed_from             TIMESTAMPTZ,
      settings              JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_push_at          TIMESTAMPTZ,
      last_error            TEXT,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT accounting_connections_user_provider_key UNIQUE (user_id, provider),
      CONSTRAINT accounting_connections_auth_kind_check
        CHECK (auth_kind IN ('oauth2', 'api_key')),
      CONSTRAINT accounting_connections_status_check
        CHECK (status IN ('connected', 'needs_reauthorisation', 'revoked_at_provider', 'scope_missing', 'disconnected'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_accounting_connections_one_active
      ON accounting_connections(user_id) WHERE is_active_destination;

    CREATE INDEX IF NOT EXISTS idx_accounting_connections_user
      ON accounting_connections(user_id, updated_at DESC);
  `)

  // Copy every Fortnox connection across AS-IS. The secrets blob is the same
  // JSON the encrypted path serialises (see infra/secrets.ts plaintextSecrets),
  // so a version-0 row and a version-1 row decrypt to identical objects and no
  // caller branches on the version. jsonb normalises key order; the reader is
  // JSON.parse, so that is fine.
  await client.query(`
    INSERT INTO accounting_connections
      (user_id, provider, auth_kind, secrets_ciphertext, secrets_key_version,
       base_currency, status, granted_scope, token_expires_at,
       is_active_destination, created_at, updated_at)
    SELECT
      user_id,
      'fortnox',
      'oauth2',
      convert_to(
        jsonb_build_object(
          'accessToken', access_token,
          'refreshToken', refresh_token,
          'tokenType', token_type,
          'scope', scope
        )::text,
        'UTF8'
      ),
      0,
      'SEK',
      'connected',
      scope,
      expires_at,
      true,
      COALESCE(created_at, NOW()),
      COALESCE(updated_at, NOW())
    FROM fortnox_connections
    ON CONFLICT (user_id, provider) DO NOTHING;
  `)

  await client.query(`ALTER TABLE fortnox_connections RENAME TO fortnox_connections_retired;`)

  await client.query(`
    ALTER TABLE reporting_feed_syncs RENAME TO accounting_feed_syncs;
    ALTER INDEX IF EXISTS idx_reporting_feed_syncs_user RENAME TO idx_accounting_feed_syncs_user;
    UPDATE account_entitlements SET entitlement = 'accounting_feed' WHERE entitlement = 'reporting_feed';
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    UPDATE account_entitlements SET entitlement = 'reporting_feed' WHERE entitlement = 'accounting_feed';
    ALTER INDEX IF EXISTS idx_accounting_feed_syncs_user RENAME TO idx_reporting_feed_syncs_user;
    ALTER TABLE accounting_feed_syncs RENAME TO reporting_feed_syncs;
    ALTER TABLE fortnox_connections_retired RENAME TO fortnox_connections;
    DROP TABLE IF EXISTS accounting_connections;
  `)
}
