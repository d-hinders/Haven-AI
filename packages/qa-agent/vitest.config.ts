import { defineConfig } from 'vitest/config'

// qa-agent drives the SDK as a BUILT package, and its own test script does not
// rebuild it — the money-flow legs would run against stale signing code
// without noticing (#1188).
export default defineConfig({
  test: {
    globalSetup: ['./vitest.global-setup.ts'],
  },
})
