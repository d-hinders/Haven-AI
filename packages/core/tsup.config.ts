import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/comment-stripper.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  // comment-stripper (its own entry, never in the barrel) imports typescript;
  // keep it external rather than bundling the compiler into dist. Only test
  // code imports that entry, and the workspace's devDependency satisfies it.
  external: ['typescript'],
})
