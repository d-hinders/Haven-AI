import type { PoolClient } from 'pg'

export const version = '079_schema_local_constraint_repair'

/**
 * Re-add the two `user_safes` constraints that a schema-blind idempotency
 * check skipped (#2702).
 *
 * ## What went wrong
 *
 * Four migrations guarded constraint creation with
 * `IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '…')`.
 * `pg_constraint.conname` is **not unique across schemas** — the query carried
 * no `connamespace` predicate — so once ANY schema in the database held the
 * name, every schema migrated afterwards saw it and skipped its own.
 *
 * Measured on one developer machine before the fix: 185 worker schemas held
 * `user_safes`, and **zero** held `user_safes_user_id_safe_address_chain_id_key`
 * or `user_safes_account_type_check`. `public` had claimed both names first,
 * and every test schema created since had quietly gone without. The suite was
 * certifying behaviour against a schema that accepts a duplicate
 * `(user_id, safe_address, chain_id)` and an out-of-range `account_type` that
 * production rejects.
 *
 * The four checks are now schema-qualified, which stops it recurring. That
 * alone does not help any schema already created: `schema_migrations` records
 * 000, 036 and 041 as applied, so they never re-run. This migration is the
 * repair half.
 *
 * ## Why this is safe on production
 *
 * Both constraints already exist in the production schema — that is precisely
 * why the blind check kept matching — so both branches below are no-ops there.
 * The `NOT EXISTS` guards are themselves schema-qualified, so this migration
 * cannot re-add a constraint a schema already has, and it cannot be satisfied
 * by some other schema's copy the way the originals were.
 *
 * ## The failure mode this deliberately does not hide
 *
 * `ADD CONSTRAINT` fails if existing rows violate it. That is the correct
 * behaviour and it is not caught: a schema carrying duplicate
 * `(user_id, safe_address, chain_id)` rows has data that the intended schema
 * forbids, and silently leaving the constraint off — which is exactly how this
 * defect behaved for 185 schemas — is what made it invisible for so long. A
 * loud failure naming the constraint is the outcome to want here.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE c.conname = 'user_safes_user_id_safe_address_chain_id_key'
          AND n.nspname = current_schema()
      ) THEN
        ALTER TABLE user_safes ADD CONSTRAINT user_safes_user_id_safe_address_chain_id_key
          UNIQUE (user_id, safe_address, chain_id);
      END IF;
    END $$;

    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE c.conname = 'user_safes_account_type_check'
          AND n.nspname = current_schema()
      ) THEN
        ALTER TABLE user_safes
          ADD CONSTRAINT user_safes_account_type_check
          CHECK (account_type IN ('safe', 'delegator_hybrid'));
      END IF;
    END $$;
  `)
}

/**
 * Deliberately NOT a mirror of `up()`.
 *
 * `down()` must not drop these constraints: they are part of the schema every
 * earlier migration intended, and 000/041 are what create them on a fresh
 * schema. Dropping them here would make a `down()` leave the schema in the
 * broken state this migration exists to repair — and #2616's guard would then
 * correctly report the drift as inherited, pointing at the wrong cause.
 */
export async function down(): Promise<void> {
  // No-op, on purpose. See above.
}
