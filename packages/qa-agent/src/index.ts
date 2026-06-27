/**
 * @haven_ai/qa-agent — internal QA harness for the Haven dev environment.
 *
 * Scaffold (epic #573). The shared config contract lives here; the deterministic
 * money-flow scenarios (#575) and the dev seed step (#574) are added once the
 * dev-stack verification checklist (#574) is green. See
 * `docs/operations/agent-qa.md`.
 */

export { loadQaConfig, QaConfigError, type QaConfig } from './config.js'
