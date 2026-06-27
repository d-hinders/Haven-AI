/**
 * Deterministic QA scenario contract (#575). Each scenario asserts one of the
 * #420 money-flow invariants against the live dev stack and returns a structured
 * pass/fail — no LLM, fixed inputs, asserted outputs.
 */

import type { QaConfig } from '../config.js'
import type { HavenApi } from '../lib/haven-api.js'

export interface ScenarioContext {
  cfg: QaConfig
  api: HavenApi
  /** Delegate EOA private key (signs payments locally). */
  delegateKey: string
  delegateAddress: string
}

export interface ScenarioResult {
  pass: boolean
  /** One-line, human-readable evidence (e.g. a tx hash or the failing assertion). */
  detail: string
  /** Set when the scenario could not run (e.g. a missing dependency), not a failure. */
  skipped?: boolean
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
