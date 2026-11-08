import type { PoolClient } from 'pg'

export const version = '124_user_visits'

/**
 * 124 — the "Since your last visit" marker on `users` (#4709, epic #4701
 * decision 4).
 *
 * ## Why
 *
 * The dashboard's one line under the heading ("Since Tuesday, Research agent
 * made 3 payments for $4.20.") needs to know when this person was last here.
 * No such marker exists: `agents.last_seen_at` (016) is the AGENT's, and
 * `users` has no visit column. Owner decision 4 puts the marker on the SERVER
 * so a phone and a laptop agree — a browser-local marker would let each device
 * claim its own window.
 *
 * ## What this adds
 *
 * Three NULLABLE columns on `users`, all additive:
 *
 * - `visit_current_at` — the instant the current entry opened. NULL until the
 *   first entry, which is what makes "first ever visit" a state the route can
 *   see rather than infer.
 * - `visit_previous_at` — the instant the PREVIOUS entry opened. The window a
 *   line describes is `(visit_previous_at, visit_current_at]`, so the two
 *   bounds are stored together and a payment on a boundary is counted exactly
 *   once across two consecutive entries.
 * - `visit_entry_id` — the client-generated id of the entry that wrote the
 *   marker. A retry carrying the same id returns the stored bounds without
 *   moving the marker; a different id opens a new entry.
 *
 * No index: the marker is read and written by `users.id`, the primary key.
 * No backfill: a NULL marker is the honest state for every existing account —
 * the first entry writes it, and the first visit shows no line.
 *
 * ## Money path
 *
 * The marker is never read by a payment path. It records when a person opened
 * the dashboard; it changes no balance, no budget, no delegation and no
 * settlement fact. The columns are display-only.
 */
export async function up(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS visit_current_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS visit_previous_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS visit_entry_id UUID;
  `)
}

export async function down(client: PoolClient): Promise<void> {
  await client.query(`
    ALTER TABLE users
      DROP COLUMN IF EXISTS visit_entry_id,
      DROP COLUMN IF EXISTS visit_previous_at,
      DROP COLUMN IF EXISTS visit_current_at;
  `)
}
