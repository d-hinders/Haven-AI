import { generate } from './scripts/serve-docs.mjs'

/**
 * Generate the served product docs once, before any test file runs (#2532).
 *
 * `discovery-surfaces.test.ts` asserts that every entry in `PUBLIC_SURFACES`
 * resolves to a real route or a real file under `public/`, and four of those
 * entries are BUILD OUTPUT — they exist only after `serve-docs.mjs` has run.
 *
 * The first version of this change had no such hook, and the suite passed
 * locally for the worst possible reason: the generator had been run by hand
 * earlier in the session, so the files happened to be on disk. On a fresh
 * checkout — which is every CI run — the four assertions fail. A reviewer
 * reproduced it before I did.
 *
 * A `globalSetup` rather than cross-file ordering: vitest parallelises test
 * files across workers, so "the other file generates them" is not an ordering
 * anything guarantees.
 */
export default async function setup(): Promise<void> {
  generate()
}
