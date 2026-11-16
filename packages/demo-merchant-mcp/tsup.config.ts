import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts', 'reconcile-stripe': 'src/reconcile-cli.ts' },
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  banner: { js: '#!/usr/bin/env node' },
})
