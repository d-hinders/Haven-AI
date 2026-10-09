import type { PoolClient } from 'pg'

/**
 * 110 — server-saved dismissals for the dashboard's recurring "Needs you"
 * items (#3813).
 *
 * The only dismissal that existed before was `RecoveryNudge`'s
 * browser-storage key (`haven.recovery-nudge.dismissed`), which came back on
 * every new device or browser. This table stores dismissals PER ACCOUNT on
 * the server (owner decisions, 2026-10-09): permanent — not a snooze — and
 * visible from every device of the same user.
 *
 * Exactly two items are dismissible, and their shapes differ:
 *
 * - `no-backup` ("No backup signer") is per ACCOUNT: one row per
 *   (user, account). A single-signer account is allowed and never gated, so
 *   a user who chose one must not see the backup item for that account
 *   forever — but an account funded LATER still raises its own item, because
 *   the dismissal belongs to the account it was made on.
 * - `needs-setup` ("Needs setup", an agent kept without a budget on purpose)
 *   is per AGENT: one row per (user, agent). The agent's account is implied
 *   by the agent itself and is not stored twice.
 *
 * "Low balance", "Budget reached" and "Payments failed" offer no dismiss —
 * the CHECK below refuses any other kind, so a future dismissible kind has
 * to extend the constraint in a new migration rather than sneaking in here.
 *
 * The two PARTIAL unique indexes are the write-side contract, not just
 * hygiene: they are the ON CONFLICT arbiters the repository's idempotent
 * INSERTs target, so re-dismissing (two devices, a retried request) is a
 * no-op instead of a duplicate row. A dismissal row that outlives its
 * account or agent is meaningless (the item can no longer fire), hence the
 * cascades.
 *
 * Dismissals are never read by the payment path: they gate dashboard
 * presentation only, and carry no authority or custody weight. There is no
 * undismiss (#3813 scope): a user sees the backup recommendation again on
 * the account page, and a budget-less agent's state on the agent page.
 */
export const version = '110_attention_dismissals'

export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS attention_dismissals (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_kind   VARCHAR(32) NOT NULL,
      account_id  UUID REFERENCES smart_accounts(id) ON DELETE CASCADE,
      agent_id    UUID REFERENCES agents(id) ON DELETE CASCADE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT attention_dismissals_kind_shape CHECK (
        (item_kind = 'no-backup'   AND account_id IS NOT NULL AND agent_id IS NULL) OR
        (item_kind = 'needs-setup' AND agent_id IS NOT NULL)
      )
    )
  `)
  // The write arbiters — see the header. Partial so the two kinds can share
  // one table without NULL columns defeating uniqueness.
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_attention_dismissals_backup_per_account
      ON attention_dismissals (user_id, account_id)
      WHERE item_kind = 'no-backup'
  `)
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_attention_dismissals_setup_per_agent
      ON attention_dismissals (user_id, agent_id)
      WHERE item_kind = 'needs-setup'
  `)
  // The read is the user's whole dismissal list on every dashboard load.
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_attention_dismissals_user
      ON attention_dismissals (user_id)
  `)
}

/** Structural down (#1139): drops exactly what this migration created. */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS attention_dismissals`)
}
