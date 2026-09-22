/**
 * Data access for agent organizations (#3164) — the per-user folder tree and
 * the `agents.organization_id` filing placement. Convention: `README.md` in
 * this directory.
 *
 * Scoping rules a reader must not break:
 *
 * - Every function takes the owner's `userId` and every statement filters on
 *   it. An organization id arriving on a route belongs to NOBODY until
 *   `findOrganizationForUser` says otherwise — the 404 contract is "not found
 *   or not yours", the same posture `agents.ts` and `agent-labels.ts` use.
 * - Multi-row writes (the delete-promote) run inside `withTransaction` so the
 *   graph cannot be left half-moved: every child (folder and agent) reaches
 *   its new parent or none does.
 * - These tables are DISPLAY/CATEGORIZATION ONLY. Nothing here may be called
 *   from the delegation, budget, or on-chain enforcement path — that is the
 *   design boundary the issue draws, and keeping the writes and reads in one
 *   narrow module is what makes "nothing else imports this" auditable.
 */

import pool from '../../db.js'
import { withTransaction, type Executor } from '../transaction.js'

export type { Executor }

// ── Row shapes ───────────────────────────────────────────────────────────────

/** The wire shape exactly (id, parent, name, timestamps — no user_id). */
export interface AgentOrganizationRow {
  id: string
  parent_organization_id: string | null
  name: string
  created_at: string
  updated_at: string
}

/** The list read: the wire shape plus the direct member count. */
export interface OrganizationWithCount extends AgentOrganizationRow {
  agent_count: number
}

export interface CreateOrganizationInput {
  name: string
  parent_organization_id: string | null
}

export interface UpdateOrganizationInput {
  name?: string
  parent_organization_id?: string | null
}

// ── Curated SQL (imported by tests; keep queries here, not inlined at call sites) ──

export const LIST_ORGANIZATIONS_FOR_USER_SQL = `
  SELECT o.id, o.parent_organization_id, o.name, o.created_at, o.updated_at,
         -- The wire shape's member count: agents filed DIRECTLY here. One
         -- subquery per row over an indexed FK — the list is small (folders,
         -- not payments) and the tree needs the count on every node.
         (SELECT count(*)::int FROM agents a WHERE a.organization_id = o.id) AS agent_count
  FROM agent_organizations o
  WHERE o.user_id = $1
  ORDER BY lower(o.name), o.id`

export const FIND_ORGANIZATION_FOR_USER_SQL = `
  SELECT id, parent_organization_id, name, created_at, updated_at
  FROM agent_organizations
  WHERE id = $1 AND user_id = $2`

export const INSERT_ORGANIZATION_SQL = `
  INSERT INTO agent_organizations (user_id, parent_organization_id, name)
  VALUES ($1, $2, $3)
  RETURNING id, parent_organization_id, name, created_at, updated_at`

export const UPDATE_ORGANIZATION_SQL = `
  UPDATE agent_organizations
  SET name = COALESCE($3, name),
      parent_organization_id = CASE
        WHEN $4 = 'set' THEN $5::uuid
        ELSE parent_organization_id END,
      updated_at = now()
  WHERE id = $1 AND user_id = $2
  RETURNING id, parent_organization_id, name, created_at, updated_at`

/**
 * The delete-promote. Statement order IS the algorithm:
 *
 *   1. the folder's sub-organizations move up to its parent (NULL when the
 *      deleted folder was a root — the deleted row's own value, read back via
 *      the CTE, not a frontend-supplied one);
 *   2. its member agents move up the same way ("deleting a folder promotes
 *      its contents one level up — never orphans anything");
 *   3. THEN the row itself is deleted, now childless and memberless.
 *
 * The FK on `parent_organization_id` is ON DELETE RESTRICT: if step 1 or 2
 * somehow matched nothing while children remained, step 3 fails the whole
 * transaction rather than orphaning them. `agents.organization_id`'s
 * ON DELETE SET NULL is a raw-SQL backstop that never fires on this path.
 */
export const DELETE_ORGANIZATION_PROMOTING_SQL = `
  WITH gone AS (
    DELETE FROM agent_organizations
    WHERE id = $1 AND user_id = $2
    RETURNING id, parent_organization_id
  )
  UPDATE agent_organizations child
  SET parent_organization_id = gone.parent_organization_id,
      updated_at = now()
  FROM gone
  WHERE child.parent_organization_id = gone.id`

export const PROMOTE_ORGANIZATION_MEMBERS_SQL = `
  UPDATE agents
  SET organization_id = org.parent_organization_id
  FROM agent_organizations org
  WHERE org.id = $1
    AND agents.organization_id = org.id`

export const COUNT_MEMBER_AGENTS_SQL = `
  SELECT count(*)::int AS n
  FROM agents
  WHERE organization_id = $1`

export const COUNT_CHILD_ORGANIZATIONS_SQL = `
  SELECT count(*)::int AS n
  FROM agent_organizations
  WHERE parent_organization_id = $1`

/**
 * The ancestor chain ABOVE an id (excluding it), nearest parent first — the
 * cycle guard's walk. `max_depth` (the int range cap) bounds the recursion at
 * a depth no UI tree reaches; a real cycle would hit the cap and be reported,
 * rather than recursing without bound. NULL when the id is foreign (or the
 * chain is somehow broken) — callers treat NULL as "unknown, refuse".
 */
export const ANCESTOR_IDS_SQL = `
  WITH RECURSIVE chain AS (
    SELECT id, parent_organization_id, 0 AS depth
    FROM agent_organizations
    WHERE id = $1 AND user_id = $2
    UNION ALL
    SELECT o.id, o.parent_organization_id, c.depth + 1
    FROM agent_organizations o
    JOIN chain c ON o.id = c.parent_organization_id
    WHERE c.depth < 64
  )
  SELECT array_agg(id ORDER BY depth) AS ids FROM chain WHERE depth > 0`

/** Does the agent belong to `userId`? The move gate, beside findAgentForUser. */
export const AGENT_IN_ORGANIZATION_SQL = `
  UPDATE agents
  SET organization_id = $3, updated_at = now()
  WHERE id = $1 AND user_id = $2
  RETURNING organization_id`

// ── Reads ────────────────────────────────────────────────────────────────────

export async function listOrganizationsForUser(userId: string): Promise<OrganizationWithCount[]> {
  const { rows } = await pool.query<OrganizationWithCount>(LIST_ORGANIZATIONS_FOR_USER_SQL, [userId])
  return rows
}

/** The organization only when it exists AND belongs to `userId` — the 404 gate. */
export async function findOrganizationForUser(
  organizationId: string,
  userId: string,
): Promise<AgentOrganizationRow | null> {
  const { rows } = await pool.query<AgentOrganizationRow>(FIND_ORGANIZATION_FOR_USER_SQL, [
    organizationId,
    userId,
  ])
  return rows[0] ?? null
}

/**
 * The ancestor ids above `organizationId` (excluding it), nearest first;
 * NULL when the id is foreign or unreachable. Bounds the cycle walk.
 */
export async function ancestorIdsOf(
  organizationId: string,
  userId: string,
): Promise<string[] | null> {
  const { rows } = await pool.query<{ ids: string[] | null }>(ANCESTOR_IDS_SQL, [
    organizationId,
    userId,
  ])
  return rows[0]?.ids ?? null
}

export async function countMemberAgents(organizationId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(COUNT_MEMBER_AGENTS_SQL, [organizationId])
  return rows[0].n
}

export async function countChildOrganizations(organizationId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(COUNT_CHILD_ORGANIZATIONS_SQL, [organizationId])
  return rows[0].n
}

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Create a folder. `name` is normalized (trimmed) by the CALLER — the route
 * owns input shape, this module owns storage.
 */
export async function createOrganization(
  userId: string,
  input: CreateOrganizationInput,
): Promise<AgentOrganizationRow> {
  const { rows } = await pool.query<AgentOrganizationRow>(INSERT_ORGANIZATION_SQL, [
    userId,
    input.parent_organization_id,
    input.name,
  ])
  return rows[0]
}

/**
 * Rename and/or move. `parent_organization_id` uses a three-state encoding
 * because "absent" and "to the top level" are different intents a JSON body
 * cannot otherwise carry on a PATCH-shaped partial update:
 *
 *   - key absent        → leave the parent as it is;
 *   - key present, null → move to the top level;
 *   - key present, uuid → nest under that folder.
 *
 * Returns null when the id is foreign (the 404 gate).
 */
export async function updateOrganization(
  organizationId: string,
  userId: string,
  fields: UpdateOrganizationInput,
): Promise<AgentOrganizationRow | null> {
  const moveMode = fields.parent_organization_id === undefined ? 'keep' : 'set'
  const { rows } = await pool.query<AgentOrganizationRow>(UPDATE_ORGANIZATION_SQL, [
    organizationId,
    userId,
    fields.name ?? null,
    moveMode,
    fields.parent_organization_id ?? null,
  ])
  return rows[0] ?? null
}

/**
 * Delete a folder, promoting its contents one level up inside ONE
 * transaction: sub-organizations and member agents take the deleted folder's
 * own parent (NULL when a root dies — the issue's "promotes its agents and
 * sub-folders one level up"). Returns whether a row was removed.
 *
 * Members are promoted by a separate statement (not a cascade trigger) so the
 * promotion rule lives in one readable place and the transaction decides what
 * commits. The FK constraint is the seatbelt if a statement is ever edited
 * out of step with the others.
 */
export async function deleteOrganizationPromoting(
  organizationId: string,
  userId: string,
): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    await client.query(PROMOTE_ORGANIZATION_MEMBERS_SQL, [organizationId])
    const { rowCount } = await client.query(DELETE_ORGANIZATION_PROMOTING_SQL, [
      organizationId,
      userId,
    ])
    return rowCount === 1
  })
}

/**
 * File an agent under an organization (or back to the top level with null).
 * Returns the agent's new placement, or null when the agent is foreign — the
 * route answers 404 on null and refuses a foreign TARGET before calling.
 */
export async function setAgentOrganization(
  agentId: string,
  userId: string,
  organizationId: string | null,
): Promise<string | null> {
  const { rows } = await pool.query<{ organization_id: string | null }>(AGENT_IN_ORGANIZATION_SQL, [
    agentId,
    userId,
    organizationId,
  ])
  return rows[0]?.organization_id ?? null
}

/** Unique-violation helper for the sibling-name index (Postgres 23505). */
export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505'
}

/** Non-sibling FK placements / broken parent links (Postgres 23503). */
export function isForeignKeyViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23503'
}

/** The CHECK-constraint class (blank names are guarded in SQL too, 23514). */
export function isCheckViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23514'
}
