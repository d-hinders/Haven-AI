import pool from '../../db.js'
import type { Executor } from '../transaction.js'

export type { Executor }

/**
 * Data access for `attention_dismissals` (#3813) — the server-saved
 * dismissals behind the dashboard's recurring "Needs you" items.
 *
 * Exactly two items are dismissible and their shapes differ, so the two
 * writes are two functions with two SQL statements rather than one statement
 * with optional columns: each INSERT selects through an ownership EXISTS
 * (a dismissal row for an account or agent the caller does not own is never
 * written — the route answers 404), and each targets its own partial unique
 * index (migration 111) as the ON CONFLICT arbiter, so a re-dismiss from a
 * second device or a retried request is a no-op row count, not a duplicate.
 *
 * Reads are whole-list per user — the dashboard fetches every dismissal on
 * load and maps rows to rule-item ids client-side
 * (`useAttentionDismissals.ts`). There is no undismiss (#3813 scope): the
 * backup recommendation stays visible on the account page and a budget-less
 * agent's state on the agent page.
 */

export type AttentionDismissalKind = 'no-backup' | 'needs-setup'

export interface AttentionDismissalRow {
  id: string
  user_id: string
  item_kind: AttentionDismissalKind
  account_id: string | null
  agent_id: string | null
  created_at: string
}

export const LIST_ATTENTION_DISMISSALS_SQL = `
  SELECT id, user_id, item_kind, account_id, agent_id, created_at
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
  RETURNING id, user_id, item_kind, account_id, agent_id, created_at`

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
  RETURNING id, user_id, item_kind, account_id, agent_id, created_at`

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
