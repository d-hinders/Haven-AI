import pool from '../../db.js'
import type { Executor } from '../transaction.js'

export type { Executor }

/**
 * Data access for `attention_dismissals` (#3813, #4324) — the server-saved
 * dismissals and acknowledgements behind the dashboard's "Needs attention"
 * items.
 *
 * Two families share the table:
 *
 * - PERMANENT dismissals (#3813): `no-backup` per account and `needs-setup`
 *   per agent. Each has its own write and its own 111 partial unique index
 *   as the ON CONFLICT arbiter; a re-dismiss is a no-op returning the stored
 *   row.
 * - ACKNOWLEDGEMENTS (#4324, migration 118): the event-driven kinds. A row
 *   says "the user has seen this up to `acknowledged_at`", and the rules
 *   re-show the item when a newer event arrives. Re-acknowledging UPDATES
 *   `acknowledged_at` (and `acknowledged_period_end` for `budget-usage`), so
 *   the newest acknowledgement is the one that counts. Per-agent kinds and
 *   user-level kinds have one write each, each targeting its own 118 index.
 *
 * Every write selects through an ownership EXISTS (a row for an account or
 * agent the caller does not own is never written — the route answers 404).
 * Reads are whole-list per user; the dashboard maps rows to rule-item ids
 * client-side (`useAttentionDismissals.ts`). There is no undismiss.
 */

/** The permanent kinds (#3813). */
export type AttentionDismissalPermanentKind = 'no-backup' | 'needs-setup'
/** #4324: acknowledged per agent until the agent's next event of that kind. */
export type AttentionAgentAcknowledgementKind =
  | 'budget-reached'
  | 'budget-usage'
  | 'budget-scope'
  | 'payments-failed'
/** #4324: acknowledged once per user (no agent attribution). */
export type AttentionUserAcknowledgementKind = 'haven-paused' | 'payments-failed'

export type AttentionDismissalKind =
  | AttentionDismissalPermanentKind
  | AttentionAgentAcknowledgementKind
  | AttentionUserAcknowledgementKind

export interface AttentionDismissalRow {
  id: string
  user_id: string
  item_kind: AttentionDismissalKind
  account_id: string | null
  agent_id: string | null
  created_at: string
  acknowledged_at: string
  acknowledged_period_end: string | null
}

const RETURNING_COLUMNS = `id, user_id, item_kind, account_id, agent_id, created_at, acknowledged_at, acknowledged_period_end`

export const LIST_ATTENTION_DISMISSALS_SQL = `
  SELECT ${RETURNING_COLUMNS}
    FROM attention_dismissals
   WHERE user_id = $1
   ORDER BY created_at ASC`

export async function listAttentionDismissals(
  userId: string,
  db: Executor = pool,
): Promise<AttentionDismissalRow[]> {
  const result = await db.query<AttentionDismissalRow>(LIST_ATTENTION_DISMISSALS_SQL, [userId])
  return result.rows
}

/**
 * The arbiter clause of the no-backup partial unique index — spelled out as
 * a constant so the ON CONFLICT target cannot silently drift from the index
 * the migration created. The DO UPDATE arm is a deliberate no-op (the row is
 * set to the value it already has): unlike DO NOTHING it RETURNS the stored
 * row, so a re-dismiss from a second device or a retried request answers the
 * same 201 as the first write instead of looking like a miss.
 */
const BACKUP_ARBITER = `ON CONFLICT (user_id, account_id) WHERE item_kind = 'no-backup' DO UPDATE SET item_kind = EXCLUDED.item_kind`

export const DISMISS_BACKUP_SIGNER_SQL = `
  INSERT INTO attention_dismissals (user_id, item_kind, account_id, agent_id)
  SELECT $1, 'no-backup', $2, NULL
  WHERE EXISTS (SELECT 1 FROM smart_accounts WHERE id = $2 AND user_id = $1)
  ${BACKUP_ARBITER}
  RETURNING ${RETURNING_COLUMNS}`

/**
 * Dismiss the "No backup signer" item for one account. Idempotent: a row
 * already dismissed returns the STORED row (see the arbiter note), so the
 * route answers 201 on a retry too. A foreign or unknown account returns
 * null — the route maps that to 404.
 */
export async function dismissBackupSigner(
  userId: string,
  accountId: string,
  db: Executor = pool,
): Promise<AttentionDismissalRow | null> {
  const result = await db.query<AttentionDismissalRow>(DISMISS_BACKUP_SIGNER_SQL, [
    userId,
    accountId,
  ])
  return result.rows[0] ?? null
}

const SETUP_ARBITER = `ON CONFLICT (user_id, agent_id) WHERE item_kind = 'needs-setup' DO UPDATE SET item_kind = EXCLUDED.item_kind`

export const DISMISS_NEEDS_SETUP_SQL = `
  INSERT INTO attention_dismissals (user_id, item_kind, account_id, agent_id)
  SELECT $1, 'needs-setup', NULL, $2
  WHERE EXISTS (SELECT 1 FROM agents WHERE id = $2 AND user_id = $1)
  ${SETUP_ARBITER}
  RETURNING ${RETURNING_COLUMNS}`

/**
 * Dismiss the "Needs setup" item for one agent, per agent within its
 * account (owner decision, 2026-10-09). Same contract as
 * `dismissBackupSigner`.
 */
export async function dismissNeedsSetup(
  userId: string,
  agentId: string,
  db: Executor = pool,
): Promise<AttentionDismissalRow | null> {
  const result = await db.query<AttentionDismissalRow>(DISMISS_NEEDS_SETUP_SQL, [
    userId,
    agentId,
  ])
  return result.rows[0] ?? null
}

/**
 * #4324: the per-agent acknowledgement arbiter — migration 118's
 * `idx_attention_ack_per_agent`, predicate spelled out so the target cannot
 * drift from the index. Unlike the permanent kinds' no-op arms, this one
 * MOVES `acknowledged_at` forward: acknowledging again after a newer event
 * is exactly what the user did.
 */
const AGENT_ACK_ARBITER = `ON CONFLICT (user_id, item_kind, agent_id)
  WHERE agent_id IS NOT NULL AND item_kind IN ('budget-reached', 'budget-usage', 'budget-scope', 'payments-failed')
  DO UPDATE SET acknowledged_at = NOW(), acknowledged_period_end = EXCLUDED.acknowledged_period_end`

export const ACKNOWLEDGE_AGENT_ITEM_SQL = `
  INSERT INTO attention_dismissals (user_id, item_kind, account_id, agent_id, acknowledged_period_end)
  SELECT $1, $2, NULL, $3, $4::timestamptz
  WHERE EXISTS (SELECT 1 FROM agents WHERE id = $3 AND user_id = $1)
  ${AGENT_ACK_ARBITER}
  RETURNING ${RETURNING_COLUMNS}`

/**
 * Acknowledge one per-agent item. `periodEnd` is the firing budget's
 * `period_end` for `budget-usage` (the table's CHECK requires it there and
 * refuses it elsewhere). A foreign or unknown agent returns null.
 */
export async function acknowledgeAgentItem(
  userId: string,
  kind: AttentionAgentAcknowledgementKind,
  agentId: string,
  periodEnd: string | null,
  db: Executor = pool,
): Promise<AttentionDismissalRow | null> {
  const result = await db.query<AttentionDismissalRow>(ACKNOWLEDGE_AGENT_ITEM_SQL, [
    userId,
    kind,
    agentId,
    periodEnd,
  ])
  return result.rows[0] ?? null
}

/** #4324: migration 118's `idx_attention_ack_per_user`. */
const USER_ACK_ARBITER = `ON CONFLICT (user_id, item_kind)
  WHERE agent_id IS NULL AND account_id IS NULL
  DO UPDATE SET acknowledged_at = NOW()`

export const ACKNOWLEDGE_USER_ITEM_SQL = `
  INSERT INTO attention_dismissals (user_id, item_kind, account_id, agent_id)
  VALUES ($1, $2, NULL, NULL)
  ${USER_ACK_ARBITER}
  RETURNING ${RETURNING_COLUMNS}`

/**
 * Acknowledge one user-level item (`haven-paused`, or the unattributed
 * `payments-failed`). No id to own-check: the row belongs to the JWT
 * subject by construction.
 */
export async function acknowledgeUserItem(
  userId: string,
  kind: AttentionUserAcknowledgementKind,
  db: Executor = pool,
): Promise<AttentionDismissalRow> {
  const result = await db.query<AttentionDismissalRow>(ACKNOWLEDGE_USER_ITEM_SQL, [userId, kind])
  return result.rows[0]
}
