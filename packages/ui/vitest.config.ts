import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

// @haven_ai/ui's own suite. It runs the tests that MOVED here with the
// primitives (#3508): a primitive and its tests travel together, so the
// package can be worked on without a consumer app around it.
//
// The two guards in src/guards are collected by the same include — they are
// `.test.ts` files under src/, and vitest's default include is not used, this
// one is. `environmentMatchGlobs` keeps the two import-graph guards (pure
// node, no DOM) out of jsdom for no reason.
export default defineConfig({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plugins: [react() as any],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/__tests__/**/*.test.{ts,tsx}', 'src/guards/*.test.ts'],
  },
  resolve: {
    alias: {
      '@haven_ai/ui': path.resolve(__dirname, 'src'),
    },
  },
  esbuild: {
    jsx: 'automatic',
  },
})
