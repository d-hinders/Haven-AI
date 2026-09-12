import type { PoolClient } from 'pg'

export const version = '081_drop_fortnox_connections_retired'

/**
 * Drop `fortnox_connections_retired` — the copy migration 080 (#2860) renamed
 * instead of dropping (#2872, epic #2858, the epic's last slice).
 *
 * ## Why the table existed at all
 *
 * 080 copied every `fortnox_connections` row into the provider-generic
 * `accounting_connections` and then RENAMED the source rather than dropping
 * it, so that a rolling deploy with overlap — an old replica still writing a
 * connection while a new replica migrated — could not lose a committed row
 * with the table. The rename bought a window in which the old rows were still
 * readable; the epic's promotion checklist sequenced this drop LAST, after the
 * product verification on `dev`, so that window has closed by the time this
 * runs.
 *
 * ## Schema-only, and it reads nothing
 *
 * No row is read, compared or copied here. The retired rows are the Fortnox
 * token pairs AS THEY WERE at 080's migration time — plaintext, and every
 * refresh since has rotated them, so Fortnox no longer honours them anyway.
 * Whatever a connection is today lives in `accounting_connections`
 * (encrypted once `HAVEN_SECRETS_KEY` is set, `secrets-migration.ts`). The
 * retired table therefore holds dead credential material and nothing else;
 * dropping it is the one action that makes that material stop existing.
 *
 * `DROP TABLE IF EXISTS`, no `CASCADE`, no `DELETE FROM` first — the same
 * discipline 069/070/071/073/075 wrote down. The table has no child: nothing
 * declares `REFERENCES fortnox_connections_retired`; its only foreign key
 * points OUT to `users`, which a drop of the child never touches.
 *
 * ## Idempotent
 *
 * `IF EXISTS` makes `up()` a no-op on a database where the table is already
 * gone, and `down()` a no-op where it is already back. The migration test
 * relies on that to restore the head state after each reverting case.
 *
 * ## `down()` — DECIDED: recreates the EMPTY table in 027's original shape
 *
 * Not "irreversible": 080's own `down()` does
 * `ALTER TABLE fortnox_connections_retired RENAME TO fortnox_connections`,
 * so a rollback chain that reaches 080 needs the table to exist under the
 * retired name. `down()` therefore recreates it with the exact columns
 * `027_fortnox_connections.ts` created — `user_id` PK → `users`,
 * `access_token`, `refresh_token`, `token_type`, `scope`, `expires_at`,
 * `created_at`, `updated_at` — and no rows. Shape, not data: the dropped
 * rows were dead tokens, and a rollback that restored them would restore
 * refresh tokens Fortnox has already consumed (080's header says the same).
 *
 * Destructive → GitHub code-owner review (the `db/migrations/` CODEOWNERS
 * gate).
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS fortnox_connections_retired;`)
}

/**
 * Structural restore only — 027's column list verbatim, under the name 080
 * left. No data (see the header for why none should come back).
 */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS fortnox_connections_retired (
      user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      access_token   TEXT NOT NULL,
      refresh_token  TEXT NOT NULL,
      token_type     VARCHAR(32) NOT NULL DEFAULT 'Bearer',
      scope          TEXT,
      expires_at     TIMESTAMPTZ NOT NULL,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      updated_at     TIMESTAMPTZ DEFAULT NOW()
    );
  `)
}
