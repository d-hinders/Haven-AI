/**
 * Reaping orphaned `test_w<N>` worker schemas (#2418).
 *
 * ## The cost this removes
 *
 * The real-DB harness gives each vitest worker its own `test_w<N>` schema
 * (`db-harness.ts`, epic #1219). A run that is killed — a `^C`, a crashed
 * worker, the eight orphaned vitest processes found on 2026-08-31 (#2319) —
 * leaves its schemas behind, fully migrated. Nothing ever removed them, so a
 * long-lived developer database accumulates them without bound.
 *
 * They are not inert. Every WARM `resetDb()` re-reads the worker schema's
 * shape from the catalog, and that read scans `pg_class` — whose size is the
 * sum of EVERY schema's relations, not just the reader's. #2354 established
 * the warm reset floor IS that catalog read; #2418 measured it against the
 * backlog on one developer machine:
 *
 * | state                             | `pg_class` rows | catalog read | warm `resetDb()` |
 * |-----------------------------------|-----------------|--------------|------------------|
 * | 206 orphaned schemas              | 46,892          | ~35 ms       | ~38 ms           |
 * | reaped (1 schema)                 | 873             | ~12 ms       | ~19 ms           |
 *
 * Paid per test file, per worker, on every run, growing monotonically with
 * every abandoned run — and invisible in CI, where the database is always
 * fresh. It is felt only by the people who run the suite most.
 *
 * ## Why this runs in GLOBAL SETUP and not in the harness
 *
 * The issue proposed reaping inside `initDbHarness()`. That was tried and it
 * is unsafe, for a reason worth recording because it is not obvious: vitest
 * runs each test FILE in its own fork, so a worker process does not span the
 * run. A lock held by the worker is released when its file ends, and the
 * schema — which deliberately OUTLIVES the process, so the next file reuses it
 * warm — is then visible and unlocked to a sibling reaper. The window is real
 * and it was hit on the first full run: `db-harness-reset-contention.test.ts`
 * failed with `no schema has been selected to create in`, its schema dropped
 * between its own `CREATE SCHEMA` and `runMigrations()`.
 *
 * Global setup has the lifetime the predicate needs: one process, once per
 * run, before any worker starts and after all of them have finished.
 *
 * ## The predicate, stated exactly
 *
 * A schema is dropped when ALL of these hold:
 *
 * 1. its name matches `^test_w\d+$` — and the SQL is rebuilt from the captured
 *    digits, never interpolated from catalog text, so nothing outside that
 *    shape is reachable;
 * 2. its worker id is ABOVE {@link retainedWorkerIdCeiling} — the ids a run on
 *    this machine could plausibly assign. This is what keeps the reap from
 *    destroying the warm-reuse the harness depends on: the ids in active
 *    rotation are never candidates, only the debris above them;
 * 3. `pg_try_advisory_lock(SCHEMA_OWNER_LOCK_NAMESPACE, id)` SUCCEEDS — no
 *    live run holds that id. {@link claimRetainedWorkerIds} is the other half:
 *    a run holds the locks for its own ids for its whole duration, so a
 *    CONCURRENT run with a higher ceiling still cannot reap them. (More than
 *    one agent session works this repo, so concurrent runs against one local
 *    database are the normal case, not the exotic one.)
 *
 * Rule 2 alone would be a heuristic. Rule 3 alone would be unsound across the
 * inter-file window described above. Together the schema is provably owned by
 * nobody AND outside every live run's range.
 *
 * **The reap's client MUST NOT be the client holding the claims.** Postgres
 * session advisory locks are re-entrant, so a `pg_try_advisory_lock` issued on
 * the claiming session re-acquires its own locks and reports every one of them
 * free — collapsing rule 3 to a no-op for exactly the ids it most needs to
 * protect. This was not theory: with rule 2 deleted (mutation m2) and both
 * roles on one connection, the reap dropped every worker schema in the
 * database. `vitest.global-setup.ts` opens a second, short-lived connection
 * for this reason.
 *
 * The application schema is never a candidate: `public` does not match rule 1.
 *
 * This module NEVER runs against anything but the test database the harness
 * resolves, and it drops nothing whose name it did not build itself.
 */
import os from 'node:os'

import type { AdvisoryLockClient } from '../../../db/advisory-lock.js'

/**
 * The namespace half of the schema-ownership lock, taken in the TWO-argument
 * form `pg_try_advisory_lock(namespace, workerId)` — a lock space Postgres
 * keeps disjoint from the one-argument form, so this cannot collide with
 * `db-harness.ts`'s `MIGRATION_LOCK_KEY` (811000061) despite the adjacent
 * number.
 *
 * A session advisory lock dies with its backend, and a backend dies with its
 * client process — including a `kill -9`'d one, which is precisely what
 * produces these orphans. That is why liveness is asked of Postgres rather
 * than of a bookkeeping table: no table can be trusted to have been updated by
 * a process that was killed.
 */
export const SCHEMA_OWNER_LOCK_NAMESPACE = 811000062

/** Anchored, digits only. The one shape this module will ever drop. */
const WORKER_SCHEMA_PATTERN = /^test_w(\d+)$/

/**
 * How long the reap may spend dropping before leaving the rest to the next
 * run.
 *
 * `DROP SCHEMA ... CASCADE` costs per relation, and the machine that motivated
 * #2418 had 206 schemas of ~36 tables waiting. Draining all of it in one go
 * would put an unbounded DDL run in front of every developer's next test run.
 * Bounded instead: each run removes what it can afford and the backlog shrinks
 * monotonically. The steady state — every run after the first few — has
 * nothing to do and costs one catalog query.
 */
export const REAP_BUDGET_MS = 5_000

/**
 * The highest worker id this machine's runs may reuse, and therefore the
 * highest id the reap will never touch.
 *
 * vitest assigns `VITEST_WORKER_ID` from 1 upward, bounded by the pool size it
 * derives from the CPU count. Doubling that, with a floor, buys a wide margin
 * for a pool sized differently than assumed — and the cost of being generous
 * is only that a few more already-migrated schemas stay warm, which is the
 * state this whole module is trying to reach anyway. Being generous errs
 * toward keeping a schema; the failure mode this must not have is dropping a
 * live one.
 */
export function retainedWorkerIdCeiling(): number {
  const parallelism = os.availableParallelism?.() ?? os.cpus().length ?? 4
  return Math.max(parallelism, 8) * 2
}

/**
 * The schemas the naming and ceiling rules make candidates — rules 1 and 2 of
 * the predicate above, with no database involved so they are provable without
 * one. The liveness rule is {@link reapOrphanWorkerSchemas}'s job.
 */
export function planSchemaReap(
  schemas: readonly string[],
  retainCeiling: number,
): { schema: string; workerId: number }[] {
  const candidates: { schema: string; workerId: number }[] = []
  for (const schema of schemas) {
    const match = WORKER_SCHEMA_PATTERN.exec(schema)
    if (!match) continue
    const workerId = Number(match[1])
    if (workerId <= retainCeiling) continue
    candidates.push({ schema: `test_w${workerId}`, workerId })
  }
  return candidates.sort((a, b) => a.workerId - b.workerId)
}

/**
 * Hold the ownership locks for the ids THIS run may use, for as long as
 * `client` stays connected.
 *
 * Best-effort by design: an id already locked belongs to a concurrent run, and
 * the two runs then share that schema exactly as they did before #2418 — no
 * regression, and nothing to fail over. What matters is that after this call,
 * no OTHER run's reap can take an id this run might be handed.
 *
 * Returns the ids actually claimed, for the caller's diagnostics.
 */
export async function claimRetainedWorkerIds(
  client: AdvisoryLockClient,
  retainCeiling: number,
): Promise<number[]> {
  const claimed: number[] = []
  for (let workerId = 0; workerId <= retainCeiling; workerId++) {
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS locked',
      [SCHEMA_OWNER_LOCK_NAMESPACE, workerId],
    )
    if (rows[0]?.locked) claimed.push(workerId)
  }
  return claimed
}

/**
 * Drop every `test_w<N>` schema that satisfies all three rules of the
 * predicate documented at the top of this module. Returns what it dropped.
 *
 * A failed drop is reported and swallowed, never fatal: losing the race to a
 * concurrent reaper (`3F00`) is the expected outcome under concurrency, and no
 * performance cleanup is worth failing a test run over.
 */
export async function reapOrphanWorkerSchemas(
  client: AdvisoryLockClient,
  options: { retainCeiling: number; budgetMs?: number; now?: () => number },
): Promise<string[]> {
  const now = options.now ?? Date.now
  const deadline = now() + (options.budgetMs ?? REAP_BUDGET_MS)
  const { rows } = await client.query<{ nspname: string }>(
    "SELECT nspname FROM pg_namespace WHERE nspname ~ '^test_w[0-9]+$'",
  )
  const dropped: string[] = []
  for (const { schema, workerId } of planSchemaReap(
    rows.map((row) => row.nspname),
    options.retainCeiling,
  )) {
    if (now() >= deadline) break
    const { rows: lock } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS locked',
      [SCHEMA_OWNER_LOCK_NAMESPACE, workerId],
    )
    if (!lock[0]?.locked) continue
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
      dropped.push(schema)
    } catch (err) {
      console.warn(
        `db-harness: could not reap orphaned schema ${schema} — harmless, another reaper ` +
          `probably won the race: ${(err as Error).message}`,
      )
    } finally {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [
        SCHEMA_OWNER_LOCK_NAMESPACE,
        workerId,
      ])
    }
  }
  return dropped
}
