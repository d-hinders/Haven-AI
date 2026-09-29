/**
 * Deterministic QA scenario contract (#575). Each scenario asserts one of the
 * #420 money-flow invariants against the live dev stack and returns a structured
 * pass/fail — no LLM, fixed inputs, asserted outputs.
 */

import type { QaConfig } from '../config.js'

export interface ScenarioContext {
  cfg: QaConfig
}

export interface ScenarioResult {
  pass: boolean
  /** One-line, human-readable evidence (e.g. a tx hash or the failing assertion). */
  detail: string
  /** Set when the scenario could not run (e.g. a missing dependency), not a failure. */
  skipped?: boolean
  /**
   * Set when a throwaway agent this scenario created could NOT be revoked
   * (#3459). Never part of the verdict or `detail` — a leaked agent is
   * visible in the run report without turning a green leg red. Names the
   * agent id so the leak can be cleaned up by hand.
   */
  cleanupWarning?: string
}

export interface Scenario {
  name: string
  /** The #420 invariant this asserts, for the run report. */
  invariant: string
  run(ctx: ScenarioContext): Promise<ScenarioResult>
}

/** Helper: a passing result. */
export const pass = (detail: string): ScenarioResult => ({ pass: true, detail })
/** Helper: a failing result. */
export const fail = (detail: string): ScenarioResult => ({ pass: false, detail })
/** Helper: a skipped result (dependency missing — not counted as a failure). */
export const skip = (detail: string): ScenarioResult => ({ pass: true, skipped: true, detail })
