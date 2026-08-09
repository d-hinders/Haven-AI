// Default matches `docker compose up -d postgres` AND the ci.yml service
// container (the old postgres:postgres/haven_test default matched neither —
// it predated both and no test ever connected). CI sets DATABASE_URL
// explicitly, so this only fills in locally.
process.env.DATABASE_URL ??= 'postgres://haven:haven@localhost:5432/haven'
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
{
  const url = new URL(process.env.DATABASE_URL)
  const worker = process.env.VITEST_WORKER_ID ?? '0'
  url.searchParams.set('options', `-c search_path=test_w${worker},public`)
  process.env.DATABASE_URL = url.toString()
}
