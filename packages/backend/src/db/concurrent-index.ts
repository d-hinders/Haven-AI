import type { PoolClient } from 'pg'

/**
 * Lock-free index builds for non-transactional migrations (#2150).
 *
 * `CREATE INDEX CONCURRENTLY` is the reason the transactional opt-out exists,
 * and it is also the statement with the nastiest partial-failure mode, so it
 * gets a helper rather than being written by hand in each migration.
 *
 * ## The INVALID index
 *
 * A `CONCURRENTLY` build runs in several passes and takes no `SHARE` lock, so
 * writes keep flowing while it works. The price is that a failure — a unique
 * violation found in the second pass, a cancelled statement, a backend that
 * died mid-build — **leaves the index behind, marked `indisvalid = false`**.
 * Such an index is never used by the planner and is never maintained as a
 * usable index; it is dead weight with a live name.
 *
 * That interacts lethally with the `IF NOT EXISTS` every migration here is
 * written with. A plain retry of
 *
 * ```sql
 * CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_foo ON foo (bar)
 * ```
 *
 * sees the name is taken, emits a NOTICE, and returns success. The migration
 * is then recorded as applied and the database carries a permanently unusable
 * index — a silent, indefinite performance regression that looks exactly like
 * a green deploy. Postgres itself tells you the fix (the `CONCURRENTLY` docs:
 * drop the invalid index and repeat), but only if you go looking.
 *
 * So this helper always looks first:
 *
 * 1. if an index of this name exists and is INVALID, `DROP INDEX CONCURRENTLY`
 *    it — the leftovers of a previous failed attempt, never something a
 *    working system depends on;
 * 2. `CREATE ... CONCURRENTLY IF NOT EXISTS` (idempotent against a *valid*
 *    index, which is what makes a non-transactional migration safe to re-run);
 * 3. verify `indisvalid` afterwards and THROW if it is still false, so a dud
 *    can never be recorded as an applied migration.
 *
 * Step 3 is not redundant with step 1: it is what turns "the build silently
 * produced garbage" into "the migration failed", which the runner's
 * `status = 'running'` bookkeeping then surfaces to an operator.
 *
 * Every statement here is forbidden inside a transaction block (SQLSTATE
 * `25001`) — `DROP INDEX CONCURRENTLY` just as much as the create. Calling
 * this from a migration that has NOT declared `transactional = false` fails on
 * the first statement.
 */

/** Identifiers are migration-authored constants; this keeps that provable. */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface ConcurrentIndexSpec {
  /** Index name. Must be a bare identifier — it is interpolated, not bound. */
  name: string
  /**
   * Everything after the index name, e.g.
   * `ON payment_intents (LOWER(tx_hash)) WHERE tx_hash IS NOT NULL`.
   */
  definition: string
  /** `CREATE UNIQUE INDEX` — the form that most often fails mid-build. */
  unique?: boolean
}

/**
 * `indisvalid` for an index resolved through the current `search_path`, or
 * `null` when no relation of that name exists.
 */
export async function indexIsValid(client: PoolClient, name: string): Promise<boolean | null> {
  const { rows } = await client.query<{ indisvalid: boolean }>(
    `SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)`,
    [name],
  )
  return rows[0]?.indisvalid ?? null
}

/**
 * Build an index without blocking writes, healing the INVALID leftovers of any
 * previous failed attempt first. Only callable from a migration that declares
 * `transactional = false`.
 */
export async function createIndexConcurrently(
  client: PoolClient,
  { name, definition, unique = false }: ConcurrentIndexSpec,
): Promise<void> {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`createIndexConcurrently: unsafe index name ${JSON.stringify(name)}`)
  }

  if ((await indexIsValid(client, name)) === false) {
    await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`)
  }

  await client.query(
    `CREATE ${unique ? 'UNIQUE ' : ''}INDEX CONCURRENTLY IF NOT EXISTS "${name}" ${definition}`,
  )

  if ((await indexIsValid(client, name)) !== true) {
    throw new Error(
      `createIndexConcurrently: ${name} is INVALID after the build. ` +
        'The index exists but the planner will never use it. Drop it ' +
        `(DROP INDEX CONCURRENTLY IF EXISTS "${name}";) and investigate before retrying.`,
    )
  }
}

/**
 * The `down()` counterpart. `DROP INDEX CONCURRENTLY` is equally forbidden
 * inside a transaction, and `IF EXISTS` keeps a non-transactional `down()`
 * re-runnable after its own partial failure.
 */
export async function dropIndexConcurrently(client: PoolClient, name: string): Promise<void> {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`dropIndexConcurrently: unsafe index name ${JSON.stringify(name)}`)
  }
  await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`)
}
