import type { PoolClient } from 'pg'

export const version = '054_relayer_gas_events'

/**
 * Gas-cost attribution for relayer-paid operations (#717).
 *
 * Haven sponsors all gas (Safe deploys, owner-signed execs, Hybrid deploys,
 * allowance transfers, sweeps) from per-chain relayer EOAs — the product
 * model, but an open availability/DoS surface: nothing bounded how much of
 * the relayer one identity could burn, and no record existed of who spent
 * what. This table is both halves at once:
 *
 * - the RATE-LIMIT substrate: `assertRelayerBudget` counts a caller's recent
 *   rows per operation before the relayer signs anything, and
 * - the METRIC: every submitted relayer tx lands here with its receipt's
 *   gas numbers, so cost attribution exists before scaling.
 *
 * Rows are attempts that reached submission — a tx that lands-but-reverts
 * still burned relayer gas and still counts. `agent_id`/`user_id` are
 * nullable because both identity kinds spend (users deploy, agents pay), and
 * deliberately NOT foreign keys: a deleted agent's spend history must
 * survive it (attribution outlives the actor), and this table must never be
 * able to fail a money-path insert over referential drift.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS relayer_gas_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      chain_id INTEGER NOT NULL,
      operation TEXT NOT NULL,
      agent_id UUID,
      user_id UUID,
      tx_hash TEXT,
      gas_used NUMERIC,
      effective_gas_price NUMERIC,
      cost_wei NUMERIC,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  // The two window-count shapes the budget guard runs, plus the ops rollup.
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_relayer_gas_events_agent_window
      ON relayer_gas_events (agent_id, operation, created_at)
      WHERE agent_id IS NOT NULL
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_relayer_gas_events_user_window
      ON relayer_gas_events (user_id, operation, created_at)
      WHERE user_id IS NOT NULL
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_relayer_gas_events_chain_time
      ON relayer_gas_events (chain_id, created_at)
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS relayer_gas_events`)
}
