import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  // comment-stripper imports typescript (see its header note); it must be a
  // runtime import, never bundled into dist. Satisfied by the workspace's
  // hoisted devDependency — @haven_ai/core is private and never packed.
  external: ['typescript'],
})
