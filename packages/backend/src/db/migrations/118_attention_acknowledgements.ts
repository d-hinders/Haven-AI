import type { PoolClient } from 'pg'

/**
 * 118 — "Needs attention" acknowledgements (#4324, epic #4322).
 *
 * Migration 111 stored exactly two PERMANENT dismissals: `no-backup` (per
 * account) and `needs-setup` (per agent). #4324 (owner decisions 2026-10-23,
 * reversing the parts of #3813 that made them non-dismissible) lets the user
 * ACKNOWLEDGE the event-driven items too. An acknowledgement is not a mute:
 * the item comes back when something NEW happens after it.
 *
 * The new kinds and their shapes:
 *
 * - per AGENT (`agent_id` set, `account_id` null): `budget-reached` (a budget
 *   refusal), `budget-usage` (the >= 90%-used item, now its own kind),
 *   `budget-scope` (a recipient outside the agent's rules) and
 *   `payments-failed` (an on-chain revert for that agent);
 * - per USER (both ids null): `haven-paused` (Haven's sponsorship cap) and the
 *   unattributed `payments-failed` (failed intents with no named agent).
 *
 * Two new columns:
 *
 * - `acknowledged_at` — when the user last acknowledged the item. The rules
 *   re-show an item whose latest event is AFTER it. Existing rows are
 *   backfilled to their `created_at` (a 111 dismissal was made then), and new
 *   rows default to `NOW()`. Re-acknowledging UPDATES it (the repository's
 *   upsert), so the newest acknowledgement is the one that counts.
 * - `acknowledged_period_end` — `budget-usage` only, and required there: the
 *   firing budget's `period_end` at the moment of the acknowledgement. The
 *   item re-arms once that budget's current `period_end` has moved past it,
 *   i.e. in the next budget period.
 *
 * Two new PARTIAL unique indexes, the ON CONFLICT arbiters of the
 * repository's upserts (the 111 indexes keep arbitrating their own kinds):
 *
 * - `(user_id, item_kind, agent_id)` for the four per-agent kinds;
 * - `(user_id, item_kind)` WHERE both ids are null, for the two user-level
 *   kinds. `account_id IS NULL` is part of the predicate on purpose: a
 *   `no-backup` row has no agent either, and a user has one per account, so a
 *   predicate on `agent_id IS NULL` alone would refuse a user's second backup
 *   dismissal. This does not rely on `NULLS NOT DISTINCT`.
 *
 * Presentation only, as 111: nothing on the payment path reads this table,
 * and it carries no authority or custody weight.
 */
export const version = '118_attention_acknowledgements'

const PER_AGENT_KINDS = `'budget-reached', 'budget-usage', 'budget-scope', 'payments-failed'`

export async function up(client: PoolClient): Promise<void> {
  await client.query(`ALTER TABLE attention_dismissals ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ`)
  await client.query(`UPDATE attention_dismissals SET acknowledged_at = created_at WHERE acknowledged_at IS NULL`)
  await client.query(`ALTER TABLE attention_dismissals ALTER COLUMN acknowledged_at SET DEFAULT NOW()`)
  await client.query(`ALTER TABLE attention_dismissals ALTER COLUMN acknowledged_at SET NOT NULL`)
  await client.query(
    `ALTER TABLE attention_dismissals ADD COLUMN IF NOT EXISTS acknowledged_period_end TIMESTAMPTZ`,
  )

  // The kind/shape CHECK, widened. A kind outside this list is still refused
  // at the table edge, as in 111.
  await client.query(`ALTER TABLE attention_dismissals DROP CONSTRAINT IF EXISTS attention_dismissals_kind_shape`)
  await client.query(`
    ALTER TABLE attention_dismissals ADD CONSTRAINT attention_dismissals_kind_shape CHECK (
      (item_kind = 'no-backup'   AND account_id IS NOT NULL AND agent_id IS NULL
                                 AND acknowledged_period_end IS NULL) OR
      (item_kind = 'needs-setup' AND agent_id IS NOT NULL
                                 AND acknowledged_period_end IS NULL) OR
      (item_kind IN ('budget-reached', 'budget-scope')
                                 AND agent_id IS NOT NULL AND account_id IS NULL
                                 AND acknowledged_period_end IS NULL) OR
      (item_kind = 'budget-usage' AND agent_id IS NOT NULL AND account_id IS NULL
                                 AND acknowledged_period_end IS NOT NULL) OR
      (item_kind = 'payments-failed' AND account_id IS NULL
                                 AND acknowledged_period_end IS NULL) OR
      (item_kind = 'haven-paused' AND agent_id IS NULL AND account_id IS NULL
                                 AND acknowledged_period_end IS NULL)
    )
  `)

  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_attention_ack_per_agent
      ON attention_dismissals (user_id, item_kind, agent_id)
      WHERE agent_id IS NOT NULL AND item_kind IN (${PER_AGENT_KINDS})
  `)
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_attention_ack_per_user
      ON attention_dismissals (user_id, item_kind)
      WHERE agent_id IS NULL AND account_id IS NULL
  `)
}

/**
 * Restores 111's table. The new-kind rows go FIRST: the narrow CHECK would
 * refuse them, and a down that failed on its own data would leave the schema
 * half-reverted.
 */
export async function down(client: PoolClient): Promise<void> {
  await client.query(`DELETE FROM attention_dismissals WHERE item_kind NOT IN ('no-backup', 'needs-setup')`)
  await client.query(`DROP INDEX IF EXISTS idx_attention_ack_per_user`)
  await client.query(`DROP INDEX IF EXISTS idx_attention_ack_per_agent`)
  await client.query(`ALTER TABLE attention_dismissals DROP CONSTRAINT IF EXISTS attention_dismissals_kind_shape`)
  await client.query(`
    ALTER TABLE attention_dismissals ADD CONSTRAINT attention_dismissals_kind_shape CHECK (
      (item_kind = 'no-backup'   AND account_id IS NOT NULL AND agent_id IS NULL) OR
      (item_kind = 'needs-setup' AND agent_id IS NOT NULL)
    )
  `)
  await client.query(`ALTER TABLE attention_dismissals DROP COLUMN IF EXISTS acknowledged_period_end`)
  await client.query(`ALTER TABLE attention_dismissals DROP COLUMN IF EXISTS acknowledged_at`)
}
