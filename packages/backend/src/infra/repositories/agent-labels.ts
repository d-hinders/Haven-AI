/**
 * Data access for agent labels (#3167) — the `agent_labels` vocabulary and
 * the `agent_label_assignments` join. Convention: `README.md` in this
 * directory.
 *
 * Scoping rules a reader must not break:
 *
 * - Every function takes the owner's `userId` and every statement filters on
 *   it (or joins through an agent the user owns). A label id arriving on a
 *   route belongs to NOBODY until `findLabelForUser` says otherwise — the 404
   * contract is "not found or not yours", the same posture `agents.ts` uses.
 * - Assignment writes run inside `withTransaction`: `PUT /agents/:id/labels`
 *   replaces the whole set, and the delete-then-insert pair must commit or
 *   roll back together.
 * - These tables are DISPLAY/CATEGORIZATION ONLY. Nothing here may be called
 *   from the delegation, budget, or on-chain enforcement path — that is the
 *   design boundary the issue draws, and keeping the writes and reads in one
 *   narrow module is what makes "nothing else imports this" auditable.
 */

import pool from '../../db.js'
import { withTransaction, type Executor } from '../transaction.js'

export type { Executor }

// ── Row shapes ───────────────────────────────────────────────────────────────

export interface AgentLabelRow {
  id: string
  name: string
  color: string
  created_at: string
}

export interface AgentLabelAssignmentRow {
  label_id: string
  agent_id: string
}

// ── Curated SQL (imported by tests; keep queries here, not inlined at call sites) ──

// Every SELECT projects the WIRE shape exactly (id, name, color, created_at —
// no user_id): the owner is the caller scoping already applied by the WHERE
// clause, and the Label schema (`openapi/spec.ts`) is closed, so an extra
// column would be an off-spec response. One projection here, not four at the
// call sites.

export const LIST_LABELS_FOR_USER_SQL = `
  SELECT id, name, color, created_at
  FROM agent_labels
  WHERE user_id = $1
  ORDER BY lower(name), id`

export const FIND_LABEL_FOR_USER_SQL = `
  SELECT id, name, color, created_at
  FROM agent_labels
  WHERE id = $1 AND user_id = $2`

export const INSERT_LABEL_SQL = `
  INSERT INTO agent_labels (user_id, name, color)
  VALUES ($1, $2, $3)
  ON CONFLICT (user_id, lower(name)) DO UPDATE
  SET color = CASE WHEN $4 THEN EXCLUDED.color ELSE agent_labels.color END
  RETURNING id, name, color, created_at`

export const UPDATE_LABEL_SQL = `
  UPDATE agent_labels
  SET name = COALESCE($3, name), color = COALESCE($4, color)
  WHERE id = $1 AND user_id = $2
  RETURNING id, name, color, created_at`

export const DELETE_LABEL_SQL = `
  DELETE FROM agent_labels
  WHERE id = $1 AND user_id = $2`

export const LIST_LABELS_FOR_AGENT_SQL = `
  SELECT l.id, l.name, l.color, l.created_at
  FROM agent_label_assignments a
  JOIN agent_labels l ON l.id = a.label_id
  WHERE a.agent_id = ANY($1::uuid[])
  ORDER BY lower(l.name), l.id`

export const REPLACE_LABELS_FOR_AGENT_SQL = `
  DELETE FROM agent_label_assignments WHERE agent_id = $1`

export const INSERT_LABEL_ASSIGNMENT_SQL = `
  INSERT INTO agent_label_assignments (agent_id, label_id)
  VALUES ($1, $2)
  ON CONFLICT (agent_id, label_id) DO NOTHING`

export const LABELS_EXIST_FOR_USER_SQL = `
  SELECT count(*)::int AS n
  FROM agent_labels
  WHERE user_id = $1 AND id = ANY($2::uuid[])`

// ── Reads ────────────────────────────────────────────────────────────────────

export async function listLabelsForUser(userId: string): Promise<AgentLabelRow[]> {
  const { rows } = await pool.query<AgentLabelRow>(LIST_LABELS_FOR_USER_SQL, [userId])
  return rows
}

/** The label only when it exists AND belongs to `userId` — the 404 gate. */
export async function findLabelForUser(labelId: string, userId: string): Promise<AgentLabelRow | null> {
  const { rows } = await pool.query<AgentLabelRow>(FIND_LABEL_FOR_USER_SQL, [labelId, userId])
  return rows[0] ?? null
}

export async function listLabelsForAgents(agentIds: string[]): Promise<Map<string, AgentLabelRow[]>> {
  const byAgent = new Map<string, AgentLabelRow[]>()
  if (agentIds.length === 0) return byAgent
  const { rows } = await pool.query<AgentLabelRow & { agent_id: string }>(
    `
    SELECT a.agent_id, l.id, l.name, l.color, l.created_at
    FROM agent_label_assignments a
    JOIN agent_labels l ON l.id = a.label_id
    WHERE a.agent_id = ANY($1::uuid[])
    ORDER BY lower(l.name), l.id`,
    [agentIds],
  )
  for (const row of rows) {
    const { agent_id, ...label } = row
    const list = byAgent.get(agent_id) ?? []
    list.push(label)
    byAgent.set(agent_id, list)
  }
  return byAgent
}

/**
 * How many of `labelIds` exist AND belong to `userId`. The assign route uses
 * this to refuse a foreign label id with 404 before touching the agent — the
 * count is taken INSIDE the replace transaction so a label deleted between
 * check and insert fails the whole write instead of silently dropping.
 */
export async function countOwnedLabels(
  client: Executor,
  userId: string,
  labelIds: string[],
): Promise<number> {
  const { rows } = await client.query<{ n: number }>(LABELS_EXIST_FOR_USER_SQL, [userId, labelIds])
  return rows[0].n
}

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Create a label; name is normalized (trimmed, lowercased) by the CALLER —
 * the route owns input shape, this module owns storage. When the name
 * already exists (the unique index on lower(name)), the row is reused, not
 * 500-ed on: "create or set" is what the editor's inline-create actually
 * wants. `recolorOnConflict` decides what the reused row's colour becomes —
 * the route passes true only when the request carried an explicit colour
 * (#3200): an omitted colour must not sweep the existing one to the default.
 * A genuinely NEW row always takes `color` (the caller already resolved the
 * default for that case).
 */
export async function createLabel(
  userId: string,
  name: string,
  color: string,
  recolorOnConflict: boolean,
): Promise<AgentLabelRow> {
  const { rows } = await pool.query<AgentLabelRow>(INSERT_LABEL_SQL, [
    userId,
    name,
    color,
    recolorOnConflict,
  ])
  return rows[0]
}

export async function updateLabel(
  labelId: string,
  userId: string,
  fields: { name?: string; color?: string },
): Promise<AgentLabelRow | null> {
  const { rows } = await pool.query<AgentLabelRow>(UPDATE_LABEL_SQL, [
    labelId,
    userId,
    fields.name ?? null,
    fields.color ?? null,
  ])
  return rows[0] ?? null
}

/**
 * Delete a label. Returns whether a row was removed; assignments go with it
 * by CASCADE (migration 093) and the agents rows are untouched — the
 * acceptance criterion "deleting a label never deletes or alters agents".
 */
export async function deleteLabel(labelId: string, userId: string): Promise<boolean> {
  const { rowCount } = await pool.query(DELETE_LABEL_SQL, [labelId, userId])
  return rowCount === 1
}

/**
 * Replace one agent's whole label set inside a transaction. `labelIds` are
 * verified INSIDE the transaction (`countOwnedLabels`) so a label deleted
 * concurrently fails the write rather than inserting a row the FK would
 * reject anyway — but with a clearer 404 than a raw 23503.
 *
 * The pair PK (migration 093) makes double-tagging structurally impossible,
 * so the insert is `ON CONFLICT DO NOTHING` and idempotent under retry.
 */
export async function replaceAgentLabels(
  agentId: string,
  userId: string,
  labelIds: string[],
): Promise<void> {
  // Duplicates collapse (#3200): the spec promises it ("duplicates collapsed")
  // and the count check demands it — countOwnedLabels counts DISTINCT owned
  // rows, so [a, a] compared un-deduped reads as a missing label and 404s.
  // The pair PK makes the inserts idempotent anyway; the dedupe makes the
  // whole write honest about the set it means.
  const uniqueLabelIds = [...new Set(labelIds)]
  await withTransaction(pool, async (client) => {
    if (uniqueLabelIds.length > 0) {
      const owned = await countOwnedLabels(client, userId, uniqueLabelIds)
      if (owned !== uniqueLabelIds.length) {
        throw new LabelNotFoundError('One of the labels was not found')
      }
    }
    await client.query(REPLACE_LABELS_FOR_AGENT_SQL, [agentId])
    for (const labelId of uniqueLabelIds) {
      await client.query(INSERT_LABEL_ASSIGNMENT_SQL, [agentId, labelId])
    }
  })
}

/** Typed so the route can answer 404 (not 500) when a label id is foreign. */
export class LabelNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LabelNotFoundError'
  }
}
