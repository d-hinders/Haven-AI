import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plugins: [react() as any],
  test: {
    globals: true,
    environment: 'jsdom',
    // The session tests exercise the fragment handoff against the console's
    // own origin. jsdom refuses history.replaceState to a foreign origin, so
    // the document must BE that origin for `arriveAt(...)` to be legal.
    environmentOptions: {
      jsdom: {
        url: 'https://ops.example/',
      },
    },
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
  },
  esbuild: {
    jsx: 'automatic',
  },
})
