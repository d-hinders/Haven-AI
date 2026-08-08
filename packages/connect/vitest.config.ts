import { defineConfig } from 'vitest/config'

// The connector packs and runs @haven_ai/{mcp,signer,sdk} as BUILT artifacts.
// `npm run test -w packages/connect` rebuilds mcp and signer first; running
// vitest directly does not — see #1188.
export default defineConfig({
  test: {
    globalSetup: ['./vitest.global-setup.ts'],
  },
})
