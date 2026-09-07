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
export function workerSchemaName(env: NodeJS.ProcessEnv = process.env): string {
  return `test_w${env.VITEST_WORKER_ID ?? '0'}${env.HAVEN_TEST_SCHEMA_SUFFIX ?? ''}`
}
