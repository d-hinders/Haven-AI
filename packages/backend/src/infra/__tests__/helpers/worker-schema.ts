/**
 * The single definition of the per-worker test schema NAME (#2625).
 *
 * This name is needed in two places that run at different times and cannot
 * import each other's heavy side effects: `vitest.setup.ts`, which binds the
 * name into `DATABASE_URL`'s `search_path` before `config.ts` reads it, and
 * `db-harness.ts`, whose schema guard fingerprints that same schema by name.
 *
 * It lived as two independent string expressions until #2625, and they
 * DIVERGED: adding `HAVEN_TEST_SCHEMA_SUFFIX` to the harness half alone left
 * the guard fingerprinting a schema that did not exist. That is a silent
 * pass, not a failure — an empty fingerprint before and after a drift diffs
 * clean, so the guard reported nothing while real drift landed in the
 * unsuffixed schema the connection was actually bound to. One definition
 * makes that divergence unrepresentable; `assertSearchPathMatchesWorkerSchema()`
 * in `db-harness.ts` proves the binding actually took effect.
 */
/*
 * Keyed on `VITEST_POOL_ID`, NOT `VITEST_WORKER_ID` (#4971). Under vitest 3
 * `VITEST_WORKER_ID` is the FILE's ordinal in the run's spec list — every file
 * gets a new one — so keying on it gave every real-DB file a never-used schema
 * and a full migration run of its own, serialised across workers on advisory
 * lock 811000061: ~230 runs and 141-309 s of strictly serial time per CI
 * `Backend checks` job on 2026-11-18, which is what pushed that job into its
 * 12-minute ceiling. `VITEST_POOL_ID` is the pool SLOT (1..maxWorkers), reused
 * by every file the slot runs one after another, so each slot migrates once per
 * run and later files take the warm path. Files on one slot never overlap, and
 * the harness empties the rows a previous file left (`ensureMigrated()` in
 * `db-harness.ts`), so a file still starts from an empty schema at head.
 */
export function workerSchemaName(env: NodeJS.ProcessEnv = process.env): string {
  return `test_w${env.VITEST_POOL_ID ?? '0'}${env.HAVEN_TEST_SCHEMA_SUFFIX ?? ''}`
}
