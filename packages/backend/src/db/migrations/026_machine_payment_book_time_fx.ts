import type { PoolClient } from 'pg'

export const version = '026_machine_payment_book_time_fx'

/**
 * Book-time FX capture for bookkeeping-ready export (epic #462, P0 #463).
 *
 * Swedish books are kept in SEK as of the booking date. A USDC payment must
 * therefore carry its SEK value *as it was at settlement* — FX moves, so this
 * cannot be recomputed later from a current rate. These columns are written once
 * when settlement evidence is first recorded and then treated as immutable
 * (the writer COALESCEs, never overwrites).
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE machine_payment_evidence
      ADD COLUMN IF NOT EXISTS amount_sek   NUMERIC(38, 4),
      ADD COLUMN IF NOT EXISTS fx_rate_sek  NUMERIC(38, 12),
      ADD COLUMN IF NOT EXISTS fx_source    VARCHAR(64),
      ADD COLUMN IF NOT EXISTS fx_at        TIMESTAMPTZ;
  `)
}
