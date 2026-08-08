/**
 * vitest `globalSetup` that refuses to run a suite against a stale sibling
 * `dist/` (#1188).
 *
 * The npm scripts already rebuild what they depend on — `mcp-server`'s `test`
 * runs `npm --prefix ../signer run build` first — so CI never hits this. What
 * CI cannot protect is the shortcut everyone takes while iterating:
 * `npx vitest run --root packages/mcp-server`, which skips the script and its
 * builds entirely. That is the path #1154's four-week-old signer dist survived
 * on. A globalSetup runs whichever way the suite was started, so the guard
 * follows the tests rather than the incantation.
 *
 * Each consuming package passes the siblings it imports built:
 *
 *   // vitest.config.ts
 *   globalSetup: [freshDistSetup('signer', 'sdk')]
 */
import { checkPackages, formatStale } from '../check-dist-freshness.mjs'

/** Packages to verify; set by the wrapper each consumer generates. */
export async function assertFreshDist(packages) {
  const message = formatStale(await checkPackages(packages))
  if (message) {
    // Thrown, not logged: a warning here would be read past exactly when it
    // matters, and the resulting failure would be the confusing protocol-shaped
    // one this guard exists to replace.
    throw new Error(message)
  }
}
