import type { PoolClient } from 'pg'
import * as initial from './000_initial.js'
import * as selfSignAgents from './001_self_sign_agents.js'
import * as selfSignPaymentIntents from './002_self_sign_payment_intents.js'
import * as x402Resources from './003_x402_resources.js'
import * as simplifyPolicy from './004_simplify_policy.js'
import * as dashboardOverview from './005_dashboard_overview.js'

export interface Migration {
  version: string
  up: (client: PoolClient) => Promise<void>
}

/**
 * All migrations, in execution order.
 * Add new migrations here — versions must be unique and sortable.
 * Convention: `NNN_short_description.ts` where NNN is zero-padded.
 */
export const migrations: Migration[] = [
  initial,
  selfSignAgents,
  selfSignPaymentIntents,
  x402Resources,
  simplifyPolicy,
  dashboardOverview,
]
