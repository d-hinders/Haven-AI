import type { UserConfig } from 'vitest/config'
import base from './vitest.config.js'

/**
 * The child-process config for `db-harness-schema-guard.test.ts`'s disposable
 * fixture (#2625), and nothing else.
 *
 * The fixture lives in `.tmp-fixtures/`, which the main config EXCLUDES so an
 * orphaned one — left behind by a killed parent — can never be collected by an
 * ordinary run. That exclusion has to be lifted for the child that is meant to
 * run it, and two obvious ways do not work:
 *
 *   - a CLI `--exclude` APPENDS to the configured excludes rather than
 *     replacing them, so the fixture stayed filtered out;
 *   - `mergeConfig` CONCATENATES arrays, so the base's `.tmp-fixtures/**`
 *     survived the merge and did the same thing.
 *
 * Both were observed as `No test files found`. So `exclude` is REPLACED here,
 * spread-over rather than merged. Everything else is inherited, which is the
 * point: the child must reach the same database, the same `vitest.setup.ts`
 * `search_path` binding and the same hook timeout as a real run, or it is not
 * reproducing a real run.
 */
const config = base as UserConfig
export default {
  ...config,
  test: {
    ...config.test,
    include: ['.tmp-fixtures/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
} satisfies UserConfig
