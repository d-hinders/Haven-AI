import type { ApiSchema } from '@haven_ai/core'

/**
 * Wire shapes from `@haven_ai/core`'s generated API types (#984). The old
 * hand-written copy marked `actionableApprovals`/`onboardingProgress`
 * optional — the route always emits both — and typed the preview agents with
 * an unreachable 'revoked' status; the spec now records reality.
 */

export type DashboardAgentAllowance = ApiSchema<'DashboardAgentAllowance'>
export type DashboardAgentPreview = ApiSchema<'DashboardAgentPreview'>
export type DashboardOverviewResponse = ApiSchema<'DashboardOverviewResponse'>
