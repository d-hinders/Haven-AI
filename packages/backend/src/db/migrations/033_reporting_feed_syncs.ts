import type { PoolClient } from 'pg'

export const version = '033_reporting_feed_syncs'

/**
 * Dedup ledger for the reporting feed (epic #491, P1 #497).
 *
 * Records what's been fed to which provider so re-syncs, backfills, and retries
 * never double-post into the customer's accounting tool. Keyed uniquely on
 * (provider, payment_id, user_id) — the same idempotent-on-payment-id pattern as
 * `payment_fees`. A row that reached `pushed` (with an external_ref) short-
 * circuits any re-push.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS reporting_feed_syncs (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider     TEXT NOT NULL,
      payment_id   TEXT NOT NULL,
      external_ref TEXT NULL,
      status       TEXT NOT NULL,
      error        TEXT NULL,
      attempts     INTEGER NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (provider, payment_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_reporting_feed_syncs_user
      ON reporting_feed_syncs(user_id, updated_at DESC);
  `)
}
