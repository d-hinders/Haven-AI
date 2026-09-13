import type { PoolClient } from 'pg'

export const version = '083_drop_dead_safe_rail_tables'

/**
 * Drop the last dead Safe-rail tables and fix the one remaining wrong
 * default (#2851, epic #1440's final slice).
 *
 * ## Owner decision this migration follows (2026-09-10, recorded on #1440)
 *
 * The retired ROWS in `user_safes` and their agents/intents are kept as
 * **inert history** — nothing row-level happens here. This migration drops
 * dead *tables* that have zero live readers or writers, and fixes a column
 * default. No `DELETE FROM`, no row touched, no `user_safes` row rewritten.
 *
 * ## The three tables
 *
 * - **`self_sign_agents`** (`001_self_sign_agents.ts`) and
 *   **`self_sign_payment_intents`** (`002_self_sign_payment_intents.ts`) —
 *   the self-sign identity/payment pair from the pre-delegation Safe rail.
 *   Zero live INSERT or SELECT. The only surviving SQL against
 *   `self_sign_agents` was `ORPHAN_SELF_SIGN_AGENTS_FOR_ACCOUNT_SQL`
 *   (`infra/repositories/smart-accounts.ts`), which existed solely to null
 *   out `self_sign_agents.safe_id` inside the account-unlink transaction so
 *   its `NO ACTION` FK to `user_safes` (001 declares no action) would not block the delete — removed
 *   in the same change that lands this migration, along with the one
 *   `db-schema-smoke.ts` entry that named it. `self_sign_agents`' other two
 *   children, `self_sign_agent_allowances` and `self_sign_agent_recipients`,
 *   are already gone (dropped by `075` and `004` respectively), so the only
 *   surviving FK into either dropped table here is
 *   `self_sign_payment_intents.agent_id → self_sign_agents(id) ON DELETE
 *   CASCADE` (`002:9`) — the child is dropped first, before its parent, so
 *   nothing ever needs `CASCADE` to resolve it.
 * - **`owner_aliases`** (`009_owner_aliases.ts`) — its routes, repository and
 *   `db-schema-smoke.ts` entries were already removed by #2847; only the
 *   table itself survived, in migration `009` and the `migrations/index.ts`
 *   import (both of which stay — migrations are history, never edited after
 *   the fact). No table declares a foreign key into `owner_aliases`.
 *
 * ## The default fix
 *
 * `041_hybrid_accounts.ts:29` added `user_safes.account_type` as
 * `NOT NULL DEFAULT 'safe'` and no later migration repointed it — `075`
 * repointed `execution_rail`'s default at `'delegation'` but left
 * `account_type` on the retired value. A row inserted today with NEITHER
 * column set is therefore born inconsistent: `execution_rail` says
 * `'delegation'`, `account_type` says `'safe'`. Repointed here at
 * `'delegator_hybrid'`, the live rail's account type, so an omitting insert
 * is self-consistent on both columns. This is a default only — no existing
 * row is rewritten, so a legacy `account_type='safe'` row (inert history,
 * per the owner decision above) keeps reading exactly as it does today.
 *
 * ## Table name note for #2911
 *
 * `user_safes` is still named `user_safes` as of this migration — P3 (#2911)
 * renames the table AFTER this lands. #2911's author: the `account_type`
 * default is already `'delegator_hybrid'` by the time you rename the table;
 * carry the default forward under the new name rather than re-deriving it,
 * and drop the `self_sign_payment_intents.safe_address` /
 * `self_sign_agents.safe_id` renames from your scope — both tables are gone.
 * If #2911 lands FIRST instead, this file must be renumbered and re-targeted
 * at `smart_accounts` in both `up()` and `down()` (`ALTER TABLE user_safes`
 * and `REFERENCES user_safes(id)` would fail on the renamed table).
 *
 * ## Destructive scope, and what is NOT touched
 *
 * `DROP TABLE IF EXISTS`, no `CASCADE`, no `DELETE FROM` first — the same
 * no-DELETE-first discipline `070`/`075`/`081` wrote down (#2055). `user_safes`,
 * `user_passkeys` and `payment_intents.allowance_nonce` are all recorded
 * keeps and none is touched by this migration — verified by this migration's
 * own test.
 *
 * Destructive → GitHub code-owner review (the `db/migrations/` CODEOWNERS
 * gate).
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    DROP TABLE IF EXISTS self_sign_payment_intents;
    DROP TABLE IF EXISTS self_sign_agents;
    DROP TABLE IF EXISTS owner_aliases;

    ALTER TABLE user_safes
      ALTER COLUMN account_type SET DEFAULT 'delegator_hybrid';
  `)
}

/**
 * Structural restore only — the three tables as the migration history left
 * them at head (`001`/`002`/`009` as amended by `004`, which dropped
 * `self_sign_agents.restrict_recipients`, and `005`, which added
 * `self_sign_payment_intents.usd_value`/`eur_value` — the 075 convention:
 * "as 004 left them"), plus the pre-existing `'safe'` default.
 * DATA is not restored: the dropped tables held no live rows a rollback
 * could meaningfully recreate, and this is retirement, not migration.
 */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS self_sign_agents (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name                VARCHAR(255) NOT NULL,
      description         TEXT,
      delegate_address    VARCHAR(42) NOT NULL,
      safe_id             UUID REFERENCES user_safes(id),
      status              VARCHAR(20) NOT NULL DEFAULT 'active',
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, delegate_address)
    );

    CREATE INDEX IF NOT EXISTS idx_self_sign_agents_user_id ON self_sign_agents(user_id);
    CREATE INDEX IF NOT EXISTS idx_self_sign_agents_delegate ON self_sign_agents(delegate_address);

    CREATE TABLE IF NOT EXISTS self_sign_payment_intents (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id          UUID NOT NULL REFERENCES self_sign_agents(id) ON DELETE CASCADE,
      user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      safe_address      VARCHAR(42) NOT NULL,
      chain_id          INTEGER NOT NULL,
      token_symbol      VARCHAR(20) NOT NULL,
      token_address     VARCHAR(42) NOT NULL,
      to_address        VARCHAR(42) NOT NULL,
      amount_raw        VARCHAR(78) NOT NULL,
      amount_human      VARCHAR(50) NOT NULL,
      delegate_address  VARCHAR(42) NOT NULL,
      sign_hash         VARCHAR(66),
      signature         VARCHAR(200),
      tx_hash           VARCHAR(66),
      status            VARCHAR(30) NOT NULL DEFAULT 'pending_signature',
      error_message     TEXT,
      reason            TEXT,
      usd_value         NUMERIC(20,6),
      eur_value         NUMERIC(20,6),
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      signed_at         TIMESTAMPTZ,
      submitted_at      TIMESTAMPTZ,
      confirmed_at      TIMESTAMPTZ,
      expires_at        TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ss_payment_agent
      ON self_sign_payment_intents(agent_id);

    CREATE INDEX IF NOT EXISTS idx_ss_payment_status
      ON self_sign_payment_intents(status);

    CREATE INDEX IF NOT EXISTS idx_ss_payment_spending
      ON self_sign_payment_intents(agent_id, token_address, status, confirmed_at);

    CREATE TABLE IF NOT EXISTS owner_aliases (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      owner_address VARCHAR(42) NOT NULL,
      name          VARCHAR(80) NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, owner_address)
    );

    CREATE INDEX IF NOT EXISTS idx_owner_aliases_user_id ON owner_aliases(user_id);
    CREATE INDEX IF NOT EXISTS idx_owner_aliases_owner_address ON owner_aliases(owner_address);

    ALTER TABLE user_safes
      ALTER COLUMN account_type SET DEFAULT 'safe';
  `)
}
