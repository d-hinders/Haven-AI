import { DEFAULT_TEST_DATABASE_URL } from './db-availability.js'

/**
 * The environment every test-side entry point needs before `config.ts` is
 * imported, in ONE place.
 *
 * `vitest.setup.ts` has always applied these, and that was enough while it was
 * the only entry point that reached `config.ts`. #2622 added a second:
 * `vitest.global-setup.ts` now imports the migration runner to build the run's
 * pristine schema reference, and the runner reaches `config.ts` through
 * `db.ts`. Global setup runs BEFORE setup files, so it got none of these and
 * died on `Missing required environment variable: JWT_SECRET`.
 *
 * Restating the three assignments in the second file was the obvious fix and
 * the wrong one. `vitest.setup.ts`'s own comment on `DEFAULT_TEST_DATABASE_URL`
 * already records why, from #1763: two hand-copied literals that merely happen
 * to match let global setup probe one database while the workers connect to
 * another — the guard reporting on a database nobody used. #2625 then spent a
 * session on exactly that shape, where one schema name computed in two places
 * silently disabled the guard between them the moment they diverged.
 *
 * `??=` throughout: CI sets these explicitly, and a test-only default must
 * never overwrite what an operator chose.
 */
export function applyTestEnvDefaults(): void {
  process.env.DATABASE_URL ??= DEFAULT_TEST_DATABASE_URL
  process.env.JWT_SECRET ??= 'test-secret'
  // Cap the per-worker pool under vitest (#1222): the production default (20)
  // times a dozen parallel workers overruns Postgres's max_connections=100.
  process.env.DB_POOL_MAX ??= '5'
}
