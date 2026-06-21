import type { PoolClient } from 'pg'

export const version = '029_payment_fees'

/**
 * Central fee ledger (epic #386 — scaffold slice).
 *
 * One row per settled payment recording Haven's per-transaction fee. This is
 * the SAFE part of the fee module: the table + a zero-fee recording path behind
 * a feature flag. No funds move — while the flag is off, `fee_amount_atomic` is
 * '0' and nothing is collected on-chain. The on-chain fee executors (x402/MPP)
 * and real pricing are deferred sub-issues of #386.
 *
 * Keyed by payment_id for idempotency — a retry never double-records. The
 * `fee_sek` column feeds the bookkeeping export (#462) once fees are live.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS payment_fees (
      payment_id        TEXT PRIMARY KEY,
      rail              VARCHAR(32),
      fee_amount_atomic NUMERIC(78, 0) NOT NULL DEFAULT 0,
      fee_token         VARCHAR(20),
      fee_sek           NUMERIC(38, 4),
      tx_ref            VARCHAR(66),
      status            VARCHAR(24) NOT NULL DEFAULT 'recorded',
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    );
  `)
}
