import type { PoolClient } from 'pg'

export const version = '060_agents_archived_at'

/**
 * #1401: agent removal becomes a soft ARCHIVE, never a hard delete.
 *
 * `DELETE /agents/:id` had two structural defects: it 500'd on any agent with
 * payment history (payment_intents/approval_requests reference agents(id)
 * with NO ON DELETE clause), and where it succeeded it silently cascaded away
 * seven tables of money-path audit trail (tool invocations, payment evidence,
 * reconciliation events, sweeps, delegations, allowances, passports).
 *
 * Owner decision (2026-08-13, recorded on the issue): the row and ALL its
 * history stay; archiving only removes the agent from the primary list.
 * Deliberately NO ON DELETE changes here — archiving makes them moot, and
 * repointing money-path FKs is not something to do speculatively.
 *
 * The partial index serves the primary-list read (`archived_at IS NULL`
 * filtered client-side today, index-ready for a WHERE tomorrow) without
 * taxing writes for the archived tail.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_agents_user_not_archived
      ON agents (user_id)
      WHERE archived_at IS NULL
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`DROP INDEX IF EXISTS idx_agents_user_not_archived`)
  await client.query(`ALTER TABLE agents DROP COLUMN IF EXISTS archived_at`)
}
