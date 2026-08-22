import { DEFAULT_TEST_DATABASE_URL } from './src/infra/__tests__/helpers/db-availability.js'

// Default matches `docker compose up -d postgres` AND the ci.yml service
// container (the old postgres:postgres/haven_test default matched neither —
// it predated both and no test ever connected). CI sets DATABASE_URL
// explicitly, so this only fills in locally.
//
// IMPORTED, not restated (#1763 review finding). `vitest.global-setup.ts`
// probes before setup files run and so resolves this default independently;
// two hand-copied literals that merely happen to match would let global setup
// probe one host while the workers connect to another — the guard reporting on
// a database nobody used. One constant makes that impossible rather than
// unlikely.
process.env.DATABASE_URL ??= DEFAULT_TEST_DATABASE_URL
process.env.JWT_SECRET ??= 'test-secret'

// Cap the per-worker pool under vitest (#1222). The production default (20)
// times a dozen parallel workers overruns Postgres's max_connections=100 —
// observed as the real-DB suites' availability probe timing out under a full
// run, which skips locally and FAILS in CI. Repository tests never need more
// than a handful of concurrent connections per worker.
process.env.DB_POOL_MAX ??= '5'

// Real-DB isolation (#1220): bind this worker's connections to its own
// schema BEFORE config.ts reads DATABASE_URL. `options` rides the postgres
// startup packet, so every connection the pool hands out — including the
// module-level `pool` repositories import — resolves unqualified names into
// `test_w<worker>`. Mocked suites never connect and are unaffected. See
// src/infra/__tests__/helpers/db-harness.ts for the full model.
//
// The worker schema is the WHOLE search_path (#1562). It used to be
// `test_wN,public`, and that fallback was a trap: a worker schema missing a
// table silently aliased the SHARED public one, where rows persist across
// runs and workers — observed as a test seeing a 'mined' row it never
// created. A missing table must be a loud error, never shared state. No
// extension needs public here (verified: only plpgsql, in pg_catalog;
// gen_random_uuid is core PG13+), and the migrations create everything a
// repository touches inside the worker schema.
{
  const url = new URL(process.env.DATABASE_URL)
  const worker = process.env.VITEST_WORKER_ID ?? '0'
  url.searchParams.set('options', `-c search_path=test_w${worker}`)
  process.env.DATABASE_URL = url.toString()
}
