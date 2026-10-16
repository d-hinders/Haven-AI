import type { PoolClient } from 'pg'

export const version = '114_smart_account_deploy_salt'

/**
 * #4023 (epic #4022 slice S1) — MULTIPLE ACCOUNTS on one passkey.
 *
 * Today every user-account address is derived at the literal salt `'0x'`
 * (`rails/hybrid-provisioning.ts`), so one owner configuration derives
 * exactly one address and `POST /accounts/hybrid` for the same owner answers
 * 409. This migration adds the three things the per-account salt scheme
 * (partner review, 2026-10-16) needs:
 *
 * 1. `smart_accounts.deploy_salt` — the salt the account's address was
 *    derived from, `NOT NULL DEFAULT '0x'`. The default IS the backfill:
 *    every pre-#4023 row was derived at salt `'0x'`, and re-deriving at
 *    `'0x'` must keep landing on the same address. New rows are written by
 *    the register route with the salt they were derived at. The uniqueness
 *    rule this column serves is stated explicitly on the address itself:
 *
 *      UNIQUE (user_id, chain_id, LOWER(account_address)) — WHERE hybrid
 *
 *    the same rule the app-level duplicate check
 *    (FIND_HYBRID_ACCOUNT_BY_ADDRESS_FOR_USER_SQL) has always enforced, now
 *    carried by the database so two concurrent creates cannot both claim one
 *    derived address — the loser's `ON CONFLICT DO NOTHING` insert returns
 *    no row and the route answers the winner instead of 500ing on a bare
 *    constraint violation. Scoped to `delegator_hybrid` because the retired
 *    Safe-rail rows were never salt-derived and must not retroactively
 *    constrain this table.
 *
 * 2. `hybrid_deploy_salt_counters` — the never-reused counter, keyed
 *    `(user_id, salt_key)` where `salt_key` is the signer the account's
 *    owner config is built from (a passkey `key_id`, or `eoa:<address>` for
 *    an EOA-only account). GLOBAL across chains by decision: the same
 *    (owner, salt) pair derives the same address on every chain, so one
 *    counter per signer means a salt is never reused on ANY chain and an
 *    address identifies exactly one Haven account. The counter starts at 0
 *    and allocation returns 1, 2, 3, … — counter value 0 must never be
 *    ISSUED because `pad('0x', { size: 32 })` is the SAME salt as `'0x'`
 *    (`packages/sdk/src/delegate-account.ts:93`) and would collide with
 *    every pre-#4023 account. The table is deliberately NOT on
 *    `smart_accounts`: unlink is a hard DELETE (`routes/user-accounts.ts`),
 *    and a counter that died with the row would re-issue a deleted —
 *    possibly funded — account's salt on the next create.
 *
 * 3. `smart_accounts.create_idempotency_key` — the retried-create key,
 *    the `payments.ts` `send_idempotency_key` pattern (migration 020): a
 *    body field, persisted on the row the request created, deduplicated by
 *
 *      UNIQUE (user_id, create_idempotency_key)  — WHERE NOT NULL
 *
 *    A retried create returns the FIRST account; the key is scoped per user
 *    because creates are authenticated requests, not agent intents.
 *
 * All three are guarded idempotent DDL (the #2702 rule: anchored on
 * `pg_class`/`information_schema`, never an unscoped name lookup), so a
 * fresh schema and a repaired schema converge.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE smart_accounts
      ADD COLUMN IF NOT EXISTS deploy_salt TEXT NOT NULL DEFAULT '0x';

    ALTER TABLE smart_accounts
      ADD COLUMN IF NOT EXISTS create_idempotency_key VARCHAR(128);

    CREATE TABLE IF NOT EXISTS hybrid_deploy_salt_counters (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      salt_key TEXT NOT NULL,
      last_allocated BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, salt_key)
    );
  `)

  // The uniqueness rules, stated explicitly (see the docblock). Partial unique
  // INDEXes because both rules are qualified (expression / partial).
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_smart_accounts_user_chain_derived_address
      ON smart_accounts (user_id, chain_id, LOWER(account_address))
      WHERE account_type = 'delegator_hybrid';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_smart_accounts_create_idempotency
      ON smart_accounts (user_id, create_idempotency_key)
      WHERE create_idempotency_key IS NOT NULL;
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    DROP INDEX IF EXISTS idx_smart_accounts_create_idempotency;
    DROP INDEX IF EXISTS idx_smart_accounts_user_chain_derived_address;
    DROP TABLE IF EXISTS hybrid_deploy_salt_counters;
    ALTER TABLE smart_accounts DROP COLUMN IF EXISTS create_idempotency_key;
    ALTER TABLE smart_accounts DROP COLUMN IF EXISTS deploy_salt;
  `)
}
