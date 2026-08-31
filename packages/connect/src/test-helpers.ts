/**
 * Shared test isolation for the Hermes environment (#2179).
 *
 * Hermes path resolution always honours `process.env.HERMES_HOME` BEFORE the
 * fixture `homeDir` argument (`hermesHomePath()` in config-writers). A test
 * that passes a fixture home but leaves the env in place therefore writes into
 * the REAL Hermes home whenever the suite runs inside a Hermes gateway shell —
 * which silently corrupted a developer's `~/.hermes/config.yaml` and `.env`
 * with a bogus `haven` MCP pair before this helper existed.
 *
 * Every Hermes-path suite must wire these with vitest's beforeEach/afterEach so
 * the suite behaves like CI (env unset) regardless of the host shell:
 *
 *   beforeEach(isolateHermesHome)
 *   afterEach(restoreHermesHome)
 *
 * The one existing test that SETS HERMES_HOME deliberately ("uses HERMES_HOME
 * when set…") is unaffected: it saves and restores the value within itself.
 */
let savedHermesHome: string | undefined

/** Clear HERMES_HOME for a test, remembering what the shell had. */
export function isolateHermesHome(): void {
  savedHermesHome = process.env.HERMES_HOME
  delete process.env.HERMES_HOME
}

/** Restore the shell's HERMES_HOME after a test. */
export function restoreHermesHome(): void {
  if (savedHermesHome === undefined) delete process.env.HERMES_HOME
  else process.env.HERMES_HOME = savedHermesHome
}
