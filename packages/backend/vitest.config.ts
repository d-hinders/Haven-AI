import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    // #1763: owns the RUN-level database verdict — one probe before
    // collection (which refuses a run that would silently narrow itself), and
    // the closing line after vitest's own summary. Per-file state in
    // db-harness.ts cannot do either; see vitest.global-setup.ts.
    globalSetup: ['./vitest.global-setup.ts'],
    // #1372: the real-DB harness (`initDbHarness`, db-harness.ts) brings a
    // per-worker schema to the migration head inside a `beforeAll` — or, since
    // resetDb() awaits init as a guarantee, inside a `beforeEach` for a file
    // whose first harness call is resetDb; hookTimeout covers both. The FIRST
    // test file scheduled on each worker pays the FULL migration run (61
    // migrations at the time of writing, growing monotonically), and every
    // worker does that concurrently against the single Postgres service
    // container at run start — under CI load that exceeded vitest's default
    // 10s hook budget and killed three hooks at once with zero failing tests.
    // 120s is sized for what the hook actually does (~2s/migration headroom
    // at today's count, re-derived rather than re-tuned as migrations land)
    // while still bounding a genuinely hung/unreachable database to fail the
    // job ~7x faster than the workflow timeout would.
    hookTimeout: 120_000,
  },
})
