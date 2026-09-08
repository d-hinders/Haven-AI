import type { PoolClient } from 'pg'

export const version = '079_schema_local_constraint_repair'

/**
 * Re-add the three constraints that a schema-blind idempotency check skipped
 * (#2702).
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
 * A FIFTH site was missed on the first pass and found by review:
 * `018_machine_payment_approval_evidence_refs.ts` spreads the same query over
 * four lines, so the hand-written single-line grep used to claim "zero
 * remaining" could not see it. Measured: 193 schemas hold
 * `machine_payment_evidence`, **zero** hold
 * `machine_payment_evidence_one_payment_reference` — a business XOR invariant
 * (exactly one of `payment_intent_id` / `approval_request_id` non-null). That
 * is why `scripts/lint-migration-constraint-scope.mjs` now gates the pattern
 * structurally instead of by grep.
 *
 * All five checks are now anchored on `conrelid` rather than `conname` alone,
 * which stops it recurring. That alone does not help any schema already
 * created: `schema_migrations` records 000, 018, 036 and 041 as applied, so
 * they never re-run. This migration is the repair half.
 *
 * ## Why this is safe on production
 *
 * Both constraints already exist in the production schema — that is precisely
 * why the blind check kept matching — so both branches below are no-ops there.
 * The `NOT EXISTS` guards are anchored on `conrelid`, so this migration cannot
 * re-add a constraint a schema already has, and it cannot be satisfied by some
 * other schema's copy the way the originals were.
 *
 * `conrelid` rather than `nspname = current_schema()`, on review: the latter is
 * the first EXISTING schema on `search_path`, while `ALTER TABLE t` resolves to
 * the first schema CONTAINING `t`. Those diverge on a multi-element
 * `search_path` — demonstrated — and a guard answering about schema A while the
 * DDL acts on schema B fails with 42710 instead of doing the right thing.
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
        WHERE c.conname = 'user_safes_user_id_safe_address_chain_id_key'
          AND c.conrelid = 'user_safes'::regclass
      ) THEN
        ALTER TABLE user_safes ADD CONSTRAINT user_safes_user_id_safe_address_chain_id_key
          UNIQUE (user_id, safe_address, chain_id);
      END IF;
    END $$;

    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        WHERE c.conname = 'user_safes_account_type_check'
          AND c.conrelid = 'user_safes'::regclass
      ) THEN
        ALTER TABLE user_safes
          ADD CONSTRAINT user_safes_account_type_check
          CHECK (account_type IN ('safe', 'delegator_hybrid'));
      END IF;
    END $$;

    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        WHERE c.conname = 'machine_payment_evidence_one_payment_reference'
          AND c.conrelid = 'machine_payment_evidence'::regclass
      ) THEN
        -- VERBATIM from 018, not a rewrite. An earlier draft expressed the same
        -- XOR in an IS NOT NULL / IS NULL form: semantically identical,
        -- textually different, so a schema repaired here would carry a
        -- different constraint definition than a freshly migrated one. Caught
        -- by CI, because the test asserted the repair's own wording while a
        -- fresh CI schema gets 018's. A repair that makes two schemas differ
        -- is the class of defect this whole issue is about.
        ALTER TABLE machine_payment_evidence
          ADD CONSTRAINT machine_payment_evidence_one_payment_reference
          CHECK (
            (CASE WHEN payment_intent_id IS NULL THEN 0 ELSE 1 END) +
            (CASE WHEN approval_request_id IS NULL THEN 0 ELSE 1 END) = 1
          );
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
