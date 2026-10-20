import { defineConfig } from 'vitest/config'

// qa-agent drives the SDK and the signer as BUILT packages, and its own test
// script rebuilds neither — the money-flow legs would run against stale
// signing code without noticing (#1188), and src/evals/tools.test.ts would
// compare the graders' signer tool list with a stale toolSchemas (#4121).
// The global setup refuses a dist older than its src for both.
export default defineConfig({
  test: {
    globalSetup: ['./vitest.global-setup.ts'],
  },
})
