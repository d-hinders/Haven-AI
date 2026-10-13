import type { PoolClient } from 'pg'

/**
 * 112 — record that an agent was superseded by a newer one (#3772).
 *
 * When `@haven_ai/connect --replace` retires old agent directories on a
 * machine, the connector — authenticated as the NEW agent Y — reports the
 * retired agent ids X1..Xn. The backend stamps each X with the agent that
 * replaced it and when, so a still-running X sees `superseded_by` on its next
 * identity/allowances read and can tell its user it is a stale duplicate.
 *
 * WARNING ONLY (owner decision: no auto-pause). These columns are
 * reconciliation metadata read for display: nothing on the payment path, the
 * agent's status, its delegations or its credentials ever consults them, and
 * writing them grants, revokes and pauses nothing. The on-chain budget
 * delegation stays the only authority.
 *
 * `superseded_by_agent_id` is `ON DELETE SET NULL`: a hard-deleted
 * replacement leaves the old agent's history intact rather than blocking the
 * delete. A later `--replace` overwrites both columns (latest replace wins).
 */
export const version = '112_agent_superseded_by'

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE agents
      ADD COLUMN IF NOT EXISTS superseded_by_agent_id UUID NULL REFERENCES agents(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ NULL
  `)
}

/** Structural down (#1139): drops exactly what this migration added. */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE agents
      DROP COLUMN IF EXISTS superseded_at,
      DROP COLUMN IF EXISTS superseded_by_agent_id
  `)
}
