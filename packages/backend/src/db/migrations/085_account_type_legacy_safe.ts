import type { PoolClient } from 'pg'

export const version = '085_account_type_legacy_safe'

/**
 * Naming P3b (#2912, epic #2906 phase 3b): rename the `account_type` VALUE
 * `'safe'` to `'legacy_safe'` on `smart_accounts`, and tighten the CHECK to
 * match. A **data** migration, deliberately separate from `084`'s schema
 * rename (P3, #2911) — `084` renamed the table/columns/constraint NAMES;
 * this migration renames the retired rail's remaining VALUE.
 *
 * ## Owner decision this migration follows (epic #1440, restated on #2906)
 *
 * The retired rows in `smart_accounts` are kept as **inert history** — the
 * value must stay representable, so it is renamed, never dropped: no
 * `DELETE FROM`, no row removed. `UPDATE … SET account_type = 'legacy_safe'
 * WHERE account_type = 'safe'` is the only row UPDATE this migration
 * performs, and it is the only row mutation in this file.
 *
 * ## What is explicitly NOT touched
 *
 * - `onboarding_events.event`'s `'safe_deployed'` / `'safe_imported'` /
 *   `'safe_funded'` values and `relayer_gas_events.operation = 'safe_deploy'`
 *   are event HISTORY describing what happened in the past, not the current
 *   account's rail — epic #2906 Notes, "Not renamed, on purpose". Neither
 *   table nor any row in them is touched here.
 * - `DELEGATION_RAIL_ONLY`-style filters (`infra/repositories/smart-accounts.ts`,
 *   `infra/repositories/agents.ts`, …) compare against `= 'delegator_hybrid'`,
 *   never against `'safe'` — this migration does not change what they match,
 *   and the migration's own test asserts that against the real repository
 *   query.
 * - Column/table/constraint NAMES — already `smart_accounts` /
 *   `smart_accounts_account_type_check` as of `084` (#2911). Only the
 *   constraint's CONTENT and the one row value change here.
 *
 * ## The `SET DEFAULT` statement is a deliberate no-op here
 *
 * `083_drop_dead_safe_rail_tables.ts` already pointed the column's default at
 * `'delegator_hybrid'`, and `084` carried that default forward under the
 * renamed table (a column attribute a table rename does not touch). The issue
 * text was written against a world where `#2851` (the default fix) might not
 * have landed yet, and says to keep the `SET DEFAULT` statement as an
 * idempotent no-op in that case. It is a no-op on this branch (083/084 are
 * both already stacked underneath this migration), and it stays per the
 * issue: re-asserting the default costs nothing, is not order-dependent, and
 * removes any need for this migration to know which branch shipped first.
 *
 * ## Order within the one transaction
 *
 * The OLD CHECK (`IN ('safe','delegator_hybrid')`) does not admit
 * `'legacy_safe'`, and the NEW CHECK (`IN ('legacy_safe','delegator_hybrid')`)
 * does not admit `'safe'` — so neither can be active as-is while the other's
 * value is on any row. The constraint has to come OFF before the UPDATE, not
 * after: `ADD CONSTRAINT` validates every existing row, so a tightened CHECK
 * added before the UPDATE would reject the very `'safe'` rows the UPDATE is
 * about to fix. (Measured, not assumed: an earlier draft of this migration
 * ran the UPDATE first and 500'd `db-schema-smoke` with exactly that
 * violation on a fresh schema.)
 *
 * 1. `SET DEFAULT 'delegator_hybrid'` (idempotent no-op, see above).
 * 2. `DROP CONSTRAINT smart_accounts_account_type_check` — explicit name,
 *    matching `084`'s and `079`'s lesson
 *    (`079_schema_local_constraint_repair.ts:84`): name every constraint
 *    explicitly rather than let Postgres's default naming or a schema-blind
 *    idempotency check silently miss it. No CHECK is active on the column
 *    for the remainder of this transaction — safe, because nothing else in
 *    this same transaction (or able to see it, since this all runs inside
 *    the runner's transaction) writes to `account_type` while it is off.
 * 3. `UPDATE … SET account_type = 'legacy_safe' WHERE account_type = 'safe'`
 *    — no CHECK is active to violate.
 * 4. `ADD CONSTRAINT smart_accounts_account_type_check CHECK (account_type IN
 *    ('legacy_safe','delegator_hybrid'))` — validates every row; by this
 *    point every row is one of exactly those two values, so it passes.
 *
 * ## `down()`
 *
 * Exact mirror: drop the tightened CHECK, rename the value back, re-add the
 * widened CHECK. The default is left at `'delegator_hybrid'` — `083` owns
 * that default, not this migration, so `down()` does not touch it (mirroring
 * `084`'s own note that `083`'s default is "carried forward, not
 * re-derived").
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE smart_accounts
      ALTER COLUMN account_type SET DEFAULT 'delegator_hybrid';

    ALTER TABLE smart_accounts
      DROP CONSTRAINT smart_accounts_account_type_check;

    UPDATE smart_accounts SET account_type = 'legacy_safe' WHERE account_type = 'safe';

    ALTER TABLE smart_accounts
      ADD CONSTRAINT smart_accounts_account_type_check
      CHECK (account_type IN ('legacy_safe', 'delegator_hybrid'));
  `)
}

/**
 * Exact inverse of `up()`, same reasoning: the constraint has to come off
 * before the value can move back, or the still-tightened CHECK would reject
 * the `'safe'` value the UPDATE is about to write. The default is left
 * untouched (see above — `083` owns it, not this migration).
 */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE smart_accounts
      DROP CONSTRAINT smart_accounts_account_type_check;

    UPDATE smart_accounts SET account_type = 'safe' WHERE account_type = 'legacy_safe';

    ALTER TABLE smart_accounts
      ADD CONSTRAINT smart_accounts_account_type_check
      CHECK (account_type IN ('safe', 'delegator_hybrid'));
  `)
}
