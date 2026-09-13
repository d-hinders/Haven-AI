import type { PoolClient } from 'pg'

export const version = '084_rename_user_safes_to_smart_accounts'

/**
 * Naming P3 (#2911, epic #2906): rename `user_safes` to `smart_accounts` and
 * every `safe_*` column, index and constraint that names it, in one
 * transaction. Code that reads/writes the NEW names (repositories, routes,
 * `db-schema-smoke.ts`) ships in the same PR (`db/migrations/index.ts:333`
 * runs migrations on boot, on every replica, before that replica serves —
 * so a new image never meets the pre-rename schema).
 *
 * ## Decision 3 — no compatibility view (re-decided after review, epic Notes)
 *
 * A view can shadow the TABLE name `user_safes`, but not the six other
 * relations whose COLUMNS this migration renames: `agents.safe_id` (bare
 * UUID, never FK-constrained — see below), `agent_connection_setups.safe_id`
 * / `.safe_tx_hash`, `users.safe_address`, `payment_intents.safe_address`,
 * `user_passkeys.safe_address`, `hybrid_account_passkeys.user_safe_id`. A
 * view protects one relation of seven and makes the deploy only LOOK
 * protected. Instead: a **quiesced deploy** (epic operator step O2) — scale
 * the backend to 0, confirm no old container still serves, deploy the image
 * carrying this migration, confirm it in the boot log, scale back up. No
 * `CREATE VIEW` here, and none should ever be added for this table.
 *
 * ## `083`'s default carried forward, not re-derived
 *
 * `083_drop_dead_safe_rail_tables.ts` already pointed
 * `user_safes.account_type`'s DEFAULT at `'delegator_hybrid'` and left a note
 * for this migration: the default is a column ATTRIBUTE that
 * `ALTER TABLE … RENAME TO` carries across automatically (a table rename
 * touches no column definition), so nothing here sets it again — the
 * post-rename default is `'delegator_hybrid'` because it already was.
 * `083` also dropped `self_sign_agents` and `self_sign_payment_intents`
 * (and `owner_aliases`), so — contrary to the issue text, which was written
 * before the two migrations were ordered — this migration does NOT rename
 * anything on those tables: they do not exist at this point in history.
 *
 * ## `agents.account_id` — rename only, no new FK
 *
 * `agents.safe_id` has been a bare `UUID` column since `000_initial.ts`,
 * never FK-constrained to `user_safes`. Renaming it to `account_id` here
 * does not add one — adding the FK is a separate, later decision (not part
 * of this naming slice), and adding it now would risk failing on any
 * orphaned value a bare column never enforced against.
 *
 * ## Every rename is explicit and by name
 *
 * `079_schema_local_constraint_repair.ts:49-51` records that two of these
 * exact constraint names were silently dropped from 185 schemas once,
 * because an idempotency guard resolved `pg_constraint.conname` without a
 * `conrelid`/schema scope. The lesson taken here is not "guard again" but
 * "name every constraint explicitly and assert it by name in the test" —
 * there is no scope-blind shortcut in a rename.
 *
 * Implicit names below are exactly what Postgres generated (verified against
 * a live migrated schema; `ALTER TABLE … RENAME TO` does NOT rename a
 * table's existing indexes or constraints — confirmed empirically: a fresh
 * `foo`/`foo_pkey` renamed to `bar` keeps `foo_pkey` until told otherwise):
 *
 * - `user_safes_pkey` (implicit PK)
 * - `user_safes_user_id_fkey` (implicit FK to `users`)
 * - `user_safes_user_id_safe_address_chain_id_key` (explicit UNIQUE, `000`)
 * - `user_safes_account_type_check` (explicit CHECK, `041`) — content
 *   untouched: the `'safe'` value and the CHECK's IN-list are #2912's scope,
 *   not this one's. Only the constraint's NAME changes.
 * - `user_safes_execution_rail_check` (explicit CHECK, `041`) — content
 *   untouched, name only.
 * - `agent_connection_setups_safe_id_fkey` (implicit FK to `user_safes`,
 *   `017` — unlike `agents.safe_id`, this one IS FK-constrained)
 * - `hybrid_account_passkeys_user_safe_id_fkey` (implicit FK, `044`)
 * - `hybrid_account_passkeys_user_safe_id_key_id_key` (implicit UNIQUE
 *   backing `UNIQUE (user_safe_id, key_id)`, `044`)
 *
 * `RENAME CONSTRAINT` on a PK/UNIQUE constraint renames its backing index in
 * the same statement (verified empirically) — no separate `ALTER INDEX` is
 * needed for `user_safes_pkey` or the two UNIQUE constraints above. Plain
 * (non-constraint-backed) indexes need their own `ALTER INDEX … RENAME TO`:
 * `idx_user_safes_user_id`, `idx_user_safes_address`,
 * `idx_user_safes_chain_id` (all `000_initial.ts`), and
 * `hybrid_account_passkeys_safe_idx` (`044`).
 *
 * ## What is explicitly NOT touched here
 *
 * - The `account_type` VALUE `'safe'` and its CHECK's IN-list — #2912.
 * - `onboarding_events.event`'s `'safe_deployed'/'safe_imported'/
 *   'safe_funded'` values and `relayer_gas_events.operation = 'safe_deploy'`
 *   — historical event labels describing the past, epic Notes "Not renamed".
 * - Row data — zero rows read, written or deleted.
 * - `openapi/spec.ts`, `wire-aliases.ts`, `api-types.ts` — the wire contract
 *   is #2907/#2909/#2910's scope, already merged; this migration is schema
 *   only.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE user_safes RENAME TO smart_accounts;

    ALTER TABLE smart_accounts RENAME COLUMN safe_address TO account_address;
    ALTER TABLE users RENAME COLUMN safe_address TO account_address;
    ALTER TABLE payment_intents RENAME COLUMN safe_address TO account_address;
    ALTER TABLE user_passkeys RENAME COLUMN safe_address TO account_address;

    ALTER TABLE agents RENAME COLUMN safe_id TO account_id;
    ALTER TABLE agent_connection_setups RENAME COLUMN safe_id TO account_id;
    ALTER TABLE agent_connection_setups RENAME COLUMN safe_tx_hash TO account_tx_hash;
    ALTER TABLE hybrid_account_passkeys RENAME COLUMN user_safe_id TO account_id;

    ALTER INDEX idx_user_safes_user_id RENAME TO idx_smart_accounts_user_id;
    ALTER INDEX idx_user_safes_address RENAME TO idx_smart_accounts_address;
    ALTER INDEX idx_user_safes_chain_id RENAME TO idx_smart_accounts_chain_id;
    ALTER INDEX hybrid_account_passkeys_safe_idx RENAME TO hybrid_account_passkeys_account_idx;

    ALTER TABLE smart_accounts RENAME CONSTRAINT user_safes_pkey TO smart_accounts_pkey;
    ALTER TABLE smart_accounts RENAME CONSTRAINT user_safes_user_id_fkey TO smart_accounts_user_id_fkey;
    ALTER TABLE smart_accounts RENAME CONSTRAINT user_safes_user_id_safe_address_chain_id_key TO smart_accounts_user_id_account_address_chain_id_key;
    ALTER TABLE smart_accounts RENAME CONSTRAINT user_safes_account_type_check TO smart_accounts_account_type_check;
    ALTER TABLE smart_accounts RENAME CONSTRAINT user_safes_execution_rail_check TO smart_accounts_execution_rail_check;

    ALTER TABLE agent_connection_setups RENAME CONSTRAINT agent_connection_setups_safe_id_fkey TO agent_connection_setups_account_id_fkey;

    ALTER TABLE hybrid_account_passkeys RENAME CONSTRAINT hybrid_account_passkeys_user_safe_id_fkey TO hybrid_account_passkeys_account_id_fkey;
    ALTER TABLE hybrid_account_passkeys RENAME CONSTRAINT hybrid_account_passkeys_user_safe_id_key_id_key TO hybrid_account_passkeys_account_id_key_id_key;
  `)
}

/**
 * Exact structural inverse of `up()`, in reverse order — every rename
 * reversed, nothing else. `RENAME CONSTRAINT` on the PK/UNIQUE pair also
 * restores the backing index name, mirroring `up()`.
 */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE hybrid_account_passkeys RENAME CONSTRAINT hybrid_account_passkeys_account_id_key_id_key TO hybrid_account_passkeys_user_safe_id_key_id_key;
    ALTER TABLE hybrid_account_passkeys RENAME CONSTRAINT hybrid_account_passkeys_account_id_fkey TO hybrid_account_passkeys_user_safe_id_fkey;

    ALTER TABLE agent_connection_setups RENAME CONSTRAINT agent_connection_setups_account_id_fkey TO agent_connection_setups_safe_id_fkey;

    ALTER TABLE smart_accounts RENAME CONSTRAINT smart_accounts_execution_rail_check TO user_safes_execution_rail_check;
    ALTER TABLE smart_accounts RENAME CONSTRAINT smart_accounts_account_type_check TO user_safes_account_type_check;
    ALTER TABLE smart_accounts RENAME CONSTRAINT smart_accounts_user_id_account_address_chain_id_key TO user_safes_user_id_safe_address_chain_id_key;
    ALTER TABLE smart_accounts RENAME CONSTRAINT smart_accounts_user_id_fkey TO user_safes_user_id_fkey;
    ALTER TABLE smart_accounts RENAME CONSTRAINT smart_accounts_pkey TO user_safes_pkey;

    ALTER INDEX hybrid_account_passkeys_account_idx RENAME TO hybrid_account_passkeys_safe_idx;
    ALTER INDEX idx_smart_accounts_chain_id RENAME TO idx_user_safes_chain_id;
    ALTER INDEX idx_smart_accounts_address RENAME TO idx_user_safes_address;
    ALTER INDEX idx_smart_accounts_user_id RENAME TO idx_user_safes_user_id;

    ALTER TABLE hybrid_account_passkeys RENAME COLUMN account_id TO user_safe_id;
    ALTER TABLE agent_connection_setups RENAME COLUMN account_tx_hash TO safe_tx_hash;
    ALTER TABLE agent_connection_setups RENAME COLUMN account_id TO safe_id;
    ALTER TABLE agents RENAME COLUMN account_id TO safe_id;

    ALTER TABLE user_passkeys RENAME COLUMN account_address TO safe_address;
    ALTER TABLE payment_intents RENAME COLUMN account_address TO safe_address;
    ALTER TABLE users RENAME COLUMN account_address TO safe_address;
    ALTER TABLE smart_accounts RENAME COLUMN account_address TO safe_address;

    ALTER TABLE smart_accounts RENAME TO user_safes;
  `)
}
