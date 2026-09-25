import { defineConfig } from 'tsup'

export default defineConfig({
  // #3283: `test-support` ships the ONE guard-valid direct-payment UserOp
  // builder the signer, `@haven_ai/mcp` and `mcp-server` tests share — test
  // fixtures, never imported by anything the SDK or signer runs.
  entry: { index: 'src/index.ts', edge: 'src/edge.ts', 'test-support': 'src/test-support/direct-userop.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  // #3173: two entries (index, edge) share `types.js` and friends. Without
  // splitting each entry would bundle its own copy and `HavenSigningError`
  // from `@haven_ai/sdk` would not be `instanceof`-equal to the one from
  // `@haven_ai/sdk/edge` — the signer throws the edge copy, hosted and connect
  // code catches the barrel copy. Splitting emits one shared chunk both import.
  splitting: true,
  treeshake: true,
})
