/**
 * The ops wire shapes the console renders (#3516, epic #3507).
 *
 * Every type here is an `ApiSchema<…>` re-export: `packages/core/src/
 * api-types.ts` is generated from the backend's OpenAPI document, so a
 * backend field rename fails this package's typecheck instead of rendering
 * `undefined` at runtime. `/ops/health` (#3514) is covered too — the spec
 * declares its response as the named `OpsSystemHealth` schema.
 */
import type { ApiSchema } from '@haven_ai/core'

export type OpsMe = ApiSchema<'OpsSession'>
export type OpsOverview = ApiSchema<'OpsOverview'>
export type OpsFeedbackList = ApiSchema<'OpsFeedbackList'>
export type OpsSearchResponse = ApiSchema<'OpsSearchResponse'>
export type OpsUserDetail = ApiSchema<'OpsUserDetail'>
export type OpsOnchainView = ApiSchema<'OpsOnchainView'>
export type OpsRevealRequest = ApiSchema<'OpsRevealRequest'>
export type OpsRevealResponse = ApiSchema<'OpsRevealResponse'>
export type HealthOpsResponse = ApiSchema<'HealthOpsResponse'>
export type OpsHealth = ApiSchema<'OpsSystemHealth'>
export type OpsSponsoredGas = ApiSchema<'OpsSponsoredGas'>

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
