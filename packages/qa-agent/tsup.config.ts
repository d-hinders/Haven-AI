import { defineConfig } from 'tsup'

export default defineConfig({
  // `evals/command-tool` is the cold profile's eval-only MCP server (#4680):
  // `claude` spawns it as a stdio server, so it must exist as a JS file the
  // workflow can point `QA_EVAL_COMMAND_TOOL` at.
  entry: { index: 'src/index.ts', 'evals/command-tool': 'src/evals/command-tool.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
})
