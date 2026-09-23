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
    AND org.user_id = $2
    AND agents.user_id = $2
    AND agents.organization_id = org.id`

/**
 * The delete-promote's sub-organization half, split out of the former CTE
 * (round-3 review, S1): every statement is user-scoped, so a caller whose
 * id failed the ownership check cannot move SOMEONE ELSE'S children or
 * members. `deleteOrganizationPromoting` runs these before the delete and
 * throws its sentinel when the delete matched nothing, rolling the whole
 * transaction back.
 *
 * The CASE is the stored-cycle defence (round-3 review, NB1's 500): deleting
 * a member of an ALREADY-STORED cycle promotes its children to the deleted
 * folder's parent, which on a cycle can be one of the children themselves —
 * the old shape then tripped `agent_organizations_no_self_parent` (23514)
 * and the route answered 500. A child whose new parent would be itself
 * demotes to the top level instead; the delete completes and the cycle
 * breaks.
 */
export const PROMOTE_CHILD_ORGANIZATIONS_SQL = `
  UPDATE agent_organizations child
  SET parent_organization_id = CASE
        WHEN org.parent_organization_id = child.id THEN NULL
        ELSE org.parent_organization_id
      END,
      updated_at = now()
  FROM agent_organizations org
  WHERE org.id = $1
    AND org.user_id = $2
    AND child.user_id = $2
    AND child.parent_organization_id = org.id`

/** The delete itself, last — its rowCount IS the "did we remove it" answer. */
export const DELETE_ORGANIZATION_SQL = `
  DELETE FROM agent_organizations
  WHERE id = $1 AND user_id = $2
  RETURNING id`

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
 * move path's cycle walk. Runs INSIDE the per-user advisory-lock transaction
 * (`updateOrganization`), never on the pool: a walk outside the lock is exactly
 * the interleaving the crossing-move race needs (both moves read a clean
 * chain, then both write).
 *
 * `max_depth` ($3) bounds the recursion at a depth no UI tree reaches. When
 * the chain reaches the cap with an ancestor still unvisited, `truncated` is
 * true — the caller REFUSES the move (round-3 review: the old shape silently
 * DROPPED the rest of the chain at the cap and let a 67-level chain cycle).
 * Truncation also covers a cycle already stored below this point: the walk
 * would never terminate, so it hits the cap and the move is refused.
 * `ids` NULL when the id is foreign (the caller resolves the 404 itself).
 */
export const ORGANIZATION_DEPTH_LIMIT = 64

export const ANCESTOR_IDS_SQL = `
  WITH RECURSIVE chain AS (
    SELECT id, parent_organization_id, 0 AS depth
    FROM agent_organizations
    WHERE id = $1 AND user_id = $2
    UNION ALL
    SELECT o.id, o.parent_organization_id, c.depth + 1
    FROM agent_organizations o
    JOIN chain c ON o.id = c.parent_organization_id
    WHERE c.depth < $3
  )
  SELECT
    array_agg(id ORDER BY depth) FILTER (WHERE depth > 0) AS ids,
    COALESCE(bool_or(depth = $3 AND parent_organization_id IS NOT NULL), false) AS truncated
  FROM chain`

/** Does the agent belong to `userId`? The move gate, beside findAgentForUser. */
export const AGENT_IN_ORGANIZATION_SQL = `
  UPDATE agents
  SET organization_id = $3, updated_at = now()
  WHERE id = $1 AND user_id = $2
  RETURNING organization_id`

/**
 * The height of the subtree BELOW an id (levels beneath it; a leaf is 0).
 * The move path combines it with the target's depth: moving a deep subtree
 * under a deep target creates a chain NO single walk flags — no cycle, no
 * truncation — yet the total exceeds the depth limit, and the next move's
 * walk would sit truncated forever after. `truncated` (same signature as the
 * ancestor walk) refuses on a stored cycle below the node.
 */
export const SUBTREE_HEIGHT_SQL = `
  WITH RECURSIVE down AS (
    SELECT id, 0 AS depth
    FROM agent_organizations
    WHERE id = $1 AND user_id = $2
    UNION ALL
    SELECT c.id, d.depth + 1
    FROM agent_organizations c
    JOIN down d ON c.parent_organization_id = d.id
    WHERE d.depth < $3
  )
  SELECT
    COALESCE(max(depth), 0)::int AS height,
    COALESCE(bool_or(depth = $3 AND EXISTS (
      SELECT 1 FROM agent_organizations g WHERE g.parent_organization_id = down.id
    )), false) AS truncated
  FROM down`

// ── Reads ────────────────────────────────────────────────────────────────────

export async function listOrganizationsForUser(userId: string): Promise<OrganizationWithCount[]> {
  const { rows } = await pool.query<OrganizationWithCount>(LIST_ORGANIZATIONS_FOR_USER_SQL, [userId])
  return rows
}

/** The organization only when it exists AND belongs to `userId` — the 404 gate. */
export async function findOrganizationForUser(
  organizationId: string,
  userId: string,
  executor: Executor = pool,
): Promise<AgentOrganizationRow | null> {
  const { rows } = await executor.query<AgentOrganizationRow>(FIND_ORGANIZATION_FOR_USER_SQL, [
    organizationId,
    userId,
  ])
  return rows[0] ?? null
}

/**
 * The ancestor ids above `organizationId` (excluding it), nearest first, plus
 * whether the walk hit `maxDepth` with ancestors left (`truncated` — the move
 * must refuse rather than decide on a partial chain). `ids` NULL when the id
 * is foreign or unreachable.
 */
export async function ancestorIdsOf(
  organizationId: string,
  userId: string,
  maxDepth: number = ORGANIZATION_DEPTH_LIMIT,
  executor: Executor = pool,
): Promise<{ ids: string[] | null; truncated: boolean }> {
  const { rows } = await executor.query<{ ids: string[] | null; truncated: boolean }>(
    ANCESTOR_IDS_SQL,
    [organizationId, userId, maxDepth],
  )
  return { ids: rows[0]?.ids ?? null, truncated: rows[0]?.truncated ?? false }
}

export async function countMemberAgents(organizationId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(COUNT_MEMBER_AGENTS_SQL, [organizationId])
  return rows[0].n
}

/**
 * The subtree height below `organizationId` plus whether the downward walk
 * hit the cap (`truncated` — a stored cycle below the node).
 */
export async function subtreeHeightOf(
  organizationId: string,
  userId: string,
  maxDepth: number = ORGANIZATION_DEPTH_LIMIT,
  executor: Executor = pool,
): Promise<{ height: number; truncated: boolean }> {
  const { rows } = await executor.query<{ height: number; truncated: boolean }>(
    SUBTREE_HEIGHT_SQL,
    [organizationId, userId, maxDepth],
  )
  return { height: rows[0]?.height ?? 0, truncated: rows[0]?.truncated ?? false }
}

export async function countChildOrganizations(organizationId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(COUNT_CHILD_ORGANIZATIONS_SQL, [organizationId])
  return rows[0].n
}

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Create a folder. `name` is normalized (trimmed) by the CALLER — the route
 * owns input shape, this module owns storage.
 *
 * A nested create takes the same per-user advisory lock as the move path and
 * checks the parent's depth: unlimited-depth creates would otherwise stack
 * chains past the move path's limit one 64-deep request at a time. A root
 * create (parent null) needs neither. A parent that vanished between the
 * route's check and the insert fails the FK exactly as before (the route
 * maps 23503 to 404).
 */
export async function createOrganization(
  userId: string,
  input: CreateOrganizationInput,
): Promise<AgentOrganizationRow> {
  const parentId = input.parent_organization_id
  if (parentId == null) {
    const { rows } = await pool.query<AgentOrganizationRow>(INSERT_ORGANIZATION_SQL, [
      userId,
      null,
      input.name,
    ])
    return rows[0]
  }
  return withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [userId])
    const parent = await findOrganizationForUser(parentId, userId, client)
    if (parent) {
      const { ids, truncated } = await ancestorIdsOf(
        parentId,
        userId,
        ORGANIZATION_DEPTH_LIMIT,
        client,
      )
      // The limit counts NODES per root-to-leaf chain: inserting under a
      // parent whose chain already holds the maximum leaves no room.
      const parentDepth = ids ? ids.length : 0
      if (truncated || parentDepth + 2 > ORGANIZATION_DEPTH_LIMIT) {
        throw new OrganizationTooDeepError()
      }
    }
    const { rows } = await client.query<AgentOrganizationRow>(INSERT_ORGANIZATION_SQL, [
      userId,
      parentId,
      input.name,
    ])
    return rows[0]
  })
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
 * A MOVE runs inside ONE transaction serialized per user
 * (`pg_advisory_xact_lock`, #3164 round-3 review): the cycle check reads the
 * target's ancestor chain and the UPDATE writes the new parent ON THE SAME
 * LOCKED CONNECTION. Two interleaved transactions could otherwise produce
 * the classic crossing-move cycle (A under B while B moves under A —
 * measured 39/40 on a real database when the walk and the write ran as
 * separate pool queries): with the lock, the second mover's walk sees the
 * first mover's committed parent. A rename-only call skips the lock and the
 * walk entirely — it cannot change the shape of the graph.
 *
 * Cycle and depth refusals are thrown as typed errors and the transaction
 * rolls back; the route maps them to 400. Returns null when the id is
 * foreign (the 404 gate).
 */
export class OrganizationCycleError extends Error {
  constructor() {
    super('An organization cannot be moved inside one of its own sub-organizations')
    this.name = 'OrganizationCycleError'
  }
}

export class OrganizationTooDeepError extends Error {
  constructor() {
    super('This move would nest the organization deeper than the tree allows')
    this.name = 'OrganizationTooDeepError'
  }
}

export async function updateOrganization(
  organizationId: string,
  userId: string,
  fields: UpdateOrganizationInput,
): Promise<AgentOrganizationRow | null> {
  const moveMode = fields.parent_organization_id === undefined ? 'keep' : 'set'
  const params = [
    organizationId,
    userId,
    fields.name ?? null,
    moveMode,
    fields.parent_organization_id ?? null,
  ]
  if (moveMode === 'keep') {
    const { rows } = await pool.query<AgentOrganizationRow>(UPDATE_ORGANIZATION_SQL, params)
    return rows[0] ?? null
  }
  const targetId = fields.parent_organization_id ?? null
  return withTransaction(pool, async (client) => {
    // Serialize this user's org writes; every statement below runs on the
    // SAME connection the lock was taken on, so the read-then-write
    // interleave the crossing-move race needs cannot happen.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [userId])
    if (targetId !== null) {
      // The target must be this user's own folder. Resolving it INSIDE the
      // lock also means a target deleted by a concurrent request of the same
      // user is seen committed, not half-removed. A foreign or unknown target
      // writes NOTHING and returns null (the route's 404): the UPDATE's WHERE
      // is on the MOVING folder, which the caller does own, so running it
      // here would store another user's folder as the parent (#3222
      // re-review N2) — and that user's own DELETE would then 500 on RESTRICT.
      const target = await findOrganizationForUser(targetId, userId, client)
      if (!target) return null
      const { ids, truncated } = await ancestorIdsOf(
        targetId,
        userId,
        ORGANIZATION_DEPTH_LIMIT,
        client,
      )
      // A stored cycle makes the walk hit the cap with an ancestor still
      // unvisited; refuse rather than decide on a partial chain.
      if (truncated) throw new OrganizationTooDeepError()
      if (ids && ids.includes(organizationId)) throw new OrganizationCycleError()
      // Depth: the target sits `ids.length` levels down; this subtree adds
      // its height on top. Two individually-shallow chains stacked by one
      // move can exceed the limit without any walk flagging a cycle. The
      // limit counts NODES in the root-to-leaf chain: the moved subtree's
      // deepest node would sit `targetDepth + 1 + height` edges down, i.e.
      // a chain of `targetDepth + 2 + height` nodes.
      const targetDepth = ids ? ids.length : 0
      const { height, truncated: belowTruncated } = await subtreeHeightOf(
        organizationId,
        userId,
        ORGANIZATION_DEPTH_LIMIT,
        client,
      )
      if (belowTruncated || targetDepth + 2 + height > ORGANIZATION_DEPTH_LIMIT) {
        throw new OrganizationTooDeepError()
      }
    }
    // A move to the TOP LEVEL (target null) takes no walk on purpose: it
    // drops the moving node's outgoing edge, which is exactly how a stored
    // legacy cycle gets repaired — refusing it would strand the cycle.
    const { rows } = await client.query<AgentOrganizationRow>(UPDATE_ORGANIZATION_SQL, params)
    return rows[0] ?? null
  })
}

/**
 * Delete a folder, promoting its contents one level up inside ONE
 * transaction: sub-organizations and member agents take the deleted folder's
 * own parent (NULL when a root dies — the issue's "promotes its agents and
 * sub-folders one level up"). Returns whether a row was removed.
 *
 * Every statement is user-scoped (S1) and the delete runs LAST (S1's other
 * half): its rowCount is the ownership verdict, and a delete that matched
 * nothing — a foreign id, a concurrent removal — throws the sentinel below,
 * rolling the promotions back with the transaction. Under the old shape a
 * foreign id still promoted the victim's agents to root and committed. The
 * per-user advisory lock serializes this against `updateOrganization`'s
 * move path: a concurrent move into (or out of) the folder being deleted
 * cannot interleave with the promotion.
 *
 * Members are promoted by separate statements (not a cascade trigger) so the
 * promotion rule lives in one readable place and the transaction decides what
 * commits. The FK constraint is the seatbelt if a statement is ever edited
 * out of step with the others.
 */
export class OrganizationNotDeletedError extends Error {
  constructor(organizationId: string) {
    super(`Organization ${organizationId} was not deleted (foreign id or already gone)`)
    this.name = 'OrganizationNotDeletedError'
  }
}

export async function deleteOrganizationPromoting(
  organizationId: string,
  userId: string,
): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [userId])
    await client.query(PROMOTE_ORGANIZATION_MEMBERS_SQL, [organizationId, userId])
    await client.query(PROMOTE_CHILD_ORGANIZATIONS_SQL, [organizationId, userId])
    const { rowCount } = await client.query(DELETE_ORGANIZATION_SQL, [organizationId, userId])
    if (rowCount !== 1) throw new OrganizationNotDeletedError(organizationId)
    return true
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
