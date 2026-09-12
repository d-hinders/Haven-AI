import { applyTestEnvDefaults } from './src/infra/__tests__/helpers/test-env.js'
import { workerSchemaName } from './src/infra/__tests__/helpers/worker-schema.js'

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
// The three assignments live in `applyTestEnvDefaults()` because
// `vitest.global-setup.ts` needs the same ones (#2622) and a second copy of
// them is the divergence this file's own comment above warns about.
applyTestEnvDefaults()

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
//
// The name comes from `workerSchemaName()` (#2625) — the ONE definition,
// shared with the db-harness guard that fingerprints this same schema. A
// second copy of the expression lived here and drifted from that one,
// silently disabling the guard; see that module's comment.
{
  const url = new URL(process.env.DATABASE_URL)
  url.searchParams.set('options', `-c search_path=${workerSchemaName()}`)
  process.env.DATABASE_URL = url.toString()
}
