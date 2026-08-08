import { defineConfig } from 'vitest/config'

// The MCP server imports @haven_ai/signer and @haven_ai/sdk as BUILT packages.
// `npm run test -w packages/mcp-server` rebuilds both first; running vitest
// directly does not, which is how a four-week-old signer dist survived
// unnoticed (#1154). The globalSetup runs either way — see #1188.
export default defineConfig({
  test: {
    globalSetup: ['./vitest.global-setup.ts'],
  },
})
