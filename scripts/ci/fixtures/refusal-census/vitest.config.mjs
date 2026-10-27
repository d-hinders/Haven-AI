/**
 * Probe config for the backend-suite response recorder (#4471).
 *
 * Merges the backend's own base config — so `vitest.setup.ts` (the #4217
 * loopback net) and the global DB verdict still apply — and adds the recorder
 * setup file. `root` is the backend package, so test discovery, `./vitest.setup.ts`
 * and `./vitest.global-setup.ts` resolve exactly as they do for `npm test -w
 * packages/backend`.
 *
 * This file is NOT the backend's default config and is never referenced by it.
 * Run it through the instrument, which resolves `fastify` from the backend
 * package first:
 *
 *   node scripts/ci/refusal-census.mjs record
 */
import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vitest/config'
import base from '../../../../packages/backend/vitest.config.ts'

const recorder = fileURLToPath(new URL('./recorder.setup.mjs', import.meta.url))
const backendRoot = fileURLToPath(new URL('../../../../packages/backend', import.meta.url))

export default mergeConfig(
  base,
  defineConfig({
    root: backendRoot,
    test: {
      // mergeConfig concatenates arrays, so this lands after the backend's own
      // `./vitest.setup.ts` rather than replacing it.
      setupFiles: [recorder],
    },
  }),
)
