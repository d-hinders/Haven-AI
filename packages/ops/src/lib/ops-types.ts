/**
 * The ops wire shapes the console renders (#3516, epic #3507).
 *
 * `OpsSession`, `OpsOverview`, `OpsSearchResponse`, `OpsUserDetail`,
 * `OpsOnchainView`, `OpsRevealRequest/Response` and `HealthOpsResponse` are
 * `ApiSchema<…>` re-exports: `packages/core/src/api-types.ts` is generated
 * from the backend's OpenAPI document, so a backend field rename fails this
 * package's typecheck instead of rendering `undefined` at runtime.
 *
 * `OpsHealth` mirrors the `GET /ops/health` payload from #3514 — that shape
 * is not in the generated document yet (#3514 is in review), so the
 * projection is declared here from #3514's own module, one field at a time,
 * and the mirror test holds it against the branch's source. When #3514 lands
 * and regenerates `api-types.ts`, these aliases collapse into `ApiSchema`
 * re-exports and the mirror test shrinks to an import check.
 */
import type { ApiSchema } from '@haven_ai/core'

export type OpsMe = ApiSchema<'OpsSession'>
export type OpsOverview = ApiSchema<'OpsOverview'>
export type OpsSearchResponse = ApiSchema<'OpsSearchResponse'>
export type OpsUserDetail = ApiSchema<'OpsUserDetail'>
export type OpsOnchainView = ApiSchema<'OpsOnchainView'>
export type OpsRevealRequest = ApiSchema<'OpsRevealRequest'>
export type OpsRevealResponse = ApiSchema<'OpsRevealResponse'>
export type HealthOpsResponse = ApiSchema<'HealthOpsResponse'>

/** #3514: `in_window` is inside the sweeper's recovery horizon, `past_horizon` past it. */
export type SweepableWindow = 'in_window' | 'past_horizon'

export interface OpsSweepableIntent {
  id: string
  agent_id: string
  chain_id: number
  token_symbol: string
  amount_human: string
  status: string
  window: SweepableWindow
  age_seconds: number
}

export interface OpsEvidenceOrphan {
  id: string
  agent_id: string
  chain_id: number
  token_symbol: string
  amount_human: string
  status: string
  age_seconds: number
}

export interface OpsStuckRevocation {
  agent_id: string
  revocation_requested_at: string | null
  revocation_attempts: number
  age_seconds: number
}

export interface OpsStuckReanchor {
  agent_id: string
  agent_eoa: string | null
  delegate_address: string | null
  revocation_attempts: number
}

export interface OpsStuckLane {
  id: string
  chain_id: number
  submitter: string
  nonce: string
  age_seconds: number
  reason: 'stale_unmined' | 'capped_needs_operator'
}

export interface OpsDelegateBalanceReport {
  scanned_delegates: number
  unread: number
  lingering: {
    agent_id: string
    agent_name: string
    delegate_address: string
    chain_id: number
    balance_atomic: string
  }[]
  dust_total_atomic: string
  dust_alert: boolean
  chain_errors: Record<number, string>
}

/**
 * The delegate-balance section: the monitor's LAST report, or the explicit
 * not-available answer on a replica that does not hold the monitor's leader
 * lock (#3514). `not_available_on_this_replica` is a STATE the page renders,
 * never an error.
 */
export type OpsDelegateBalances =
  | { available: true; scanned_at: string; report: OpsDelegateBalanceReport }
  | { available: false; reason: 'not_available_on_this_replica' }

export interface OpsHealth {
  sweepable_intents: OpsSweepableIntent[]
  evidence_orphans: OpsEvidenceOrphan[]
  stuck_revocations: OpsStuckRevocation[]
  stuck_reanchors: OpsStuckReanchor[]
  stuck_lanes: OpsStuckLane[]
  delegate_balances: OpsDelegateBalances
  ops_diagnostics: HealthOpsResponse
  generated_at: string
}

/** The build-time doc-health JSON (#3511's `scripts/docs/doc-health.mjs`). */
export interface DocHealthReport {
  generatedAt: string
  unverifiedDays: number
  notes: string[]
  total: number
  counts: Record<string, number>
  docs: {
    path: string
    owner: string | null
    status: string | null
    lastVerified: string | null
    flags: string[]
  }[]
}
