import type { PoolClient } from 'pg'

export const version = '076_via_marker'

/**
 * Agent hand-off attribution (#2522, B2 of the agent-first epic #2519).
 *
 * Every hand-off link the agent runbook publishes carries `via=agent`. These
 * two columns are where that lands, so "how much of the funnel did an agent
 * drive" is a queryable fact rather than an inference — which is what D1
 * (#2529) measures from.
 *
 * `via` is deliberately NOT the same shape as the neighbouring `source`
 * column (migration 074). `source` is a free slug naming WHERE a setup came
 * from; `via` answers one closed question — did an agent produce this link —
 * and is sanitised to the enum `agent` or NULL at the route. A free-text
 * column here would let a link author write anything into the metric that
 * segments the funnel.
 *
 * Why a column and not the user agent: a user agent says what the CLIENT
 * claimed to be, which is trivially spoofed and, more importantly, wrong by
 * construction here — the human who follows the link arrives in an ordinary
 * browser. `via` records what the agent PASTED.
 *
 * Nullable, no default: absence means "not agent-driven", which is the normal
 * case and identical to every row written before this migration. Additive and
 * non-destructive — no existing row is read or rewritten.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS via TEXT;
  `)
  await client.query(`
    ALTER TABLE agent_connection_setups
      ADD COLUMN IF NOT EXISTS via TEXT;
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE users
      DROP COLUMN IF EXISTS via;
  `)
  await client.query(`
    ALTER TABLE agent_connection_setups
      DROP COLUMN IF EXISTS via;
  `)
}
