import type { PoolClient } from 'pg'
import * as initial from './000_initial.js'
import * as selfSignAgents from './001_self_sign_agents.js'

export interface Migration {
  version: string
  up: (client: PoolClient) => Promise<void>
}

/**
 * All migrations, in execution order.
 * Add new migrations here — versions must be unique and sortable.
 * Convention: `NNN_short_description.ts` where NNN is zero-padded.
 */
export const migrations: Migration[] = [initial, selfSignAgents]
