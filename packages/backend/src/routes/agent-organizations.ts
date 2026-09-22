/**
 * Agent organizations (#3164) — the per-user folder tree agents file into.
 *
 * Separate module from `routes/agents.ts` on purpose, mirroring how the
 * request-validation rollout (#3028) keys `enforcedModules` on the route
 * FILE, and how `agent-labels.ts` was born ENFORCED next to it: a new module
 * never enters shadow. Registered under its own `/organizations` prefix in
 * `src/index.ts`.
 *
 * Organizations are DISPLAY/CATEGORIZATION ONLY: they file agents in the
 * list, and nothing else. Nothing here touches delegation, budgets or
 * on-chain enforcement, and nothing in the money path reads these tables —
 * the same boundary `labels.ts` states, because the issue demands it twice.
 *
 * Semantics the spec cannot express (the plugin refuses the shapes; these
 * handlers own the meaning):
 * - names blank after trimming, and the 64-character cap (the column width
 *   the DB enforces; a clean 400 here beats Postgres's 22001 as a 500);
 * - a parent id must be an organization THIS user owns (404, not FK-500);
 * - a move cannot nest a folder inside itself or inside its own descendant
 *   (a cycle would strand every member render). The check reads the target's
 *   ancestor chain and refuses before writing; a same-millisecond two-tab
 *   race could still interleave two moves — a display-only surface, self-
 *   inflicted, and recoverable by moving one folder again. The schema's
 *   self-parent CHECK catches the trivial half structurally.
 * - DELETE promotes contents one level up (the repository owns the
 *   transaction); the response is `{ ok: true }` like the label delete.
 */
import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import {
  ancestorIdsOf,
  countMemberAgents,
  createOrganization,
  deleteOrganizationPromoting,
  findOrganizationForUser,
  isForeignKeyViolation,
  isUniqueViolation,
  listOrganizationsForUser,
  updateOrganization,
} from '../infra/repositories/agent-organizations.js'

/** The spec's own cap, restated for the handler (the column width). */
export const ORGANIZATION_NAME_MAX = 64

export default async function agentOrganizationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  // GET /organizations — the user's whole tree, flat rows with parent ids
  // (the frontend builds the tree client-side) and the direct member count.
  app.get('/', async (request) => {
    const { sub } = request.user as { sub: string }
    return { organizations: await listOrganizationsForUser(sub) }
  })

  // POST /organizations — create a folder, optionally under another one.
  app.post<{ Body: { name: string; parent_organization_id?: string | null } }>(
    '/',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { name, parent_organization_id } = request.body

      const trimmed = name.trim()
      if (trimmed.length === 0) {
        return reply.code(400).send({ error: 'Organization name cannot be empty' })
      }
      if (trimmed.length > ORGANIZATION_NAME_MAX) {
        return reply.code(400).send({ error: 'Organization name is too long' })
      }

      if (parent_organization_id != null) {
        const parent = await findOrganizationForUser(parent_organization_id, sub)
        if (!parent) {
          return reply.code(404).send({ error: 'Parent organization not found' })
        }
      }

      try {
        const created = await createOrganization(sub, {
          name: trimmed,
          parent_organization_id: parent_organization_id ?? null,
        })
        // A new folder has no members yet — the count is a constant here.
        return reply.code(201).send({ ...created, agent_count: 0 })
      } catch (err) {
        if (isUniqueViolation(err)) {
          return reply.code(409).send({
            error: 'You already have an organization with this name in that place',
          })
        }
        // The parent was deleted between the ownership check and the insert.
        if (isForeignKeyViolation(err)) {
          return reply.code(404).send({ error: 'Parent organization not found' })
        }
        throw err
      }
    },
  )

  // PUT /organizations/:id — rename and/or move. `parent_organization_id`
  // absent keeps the current parent; present (null included) moves — null is
  // the top level.
  app.put<{ Params: { id: string }; Body: { name?: string; parent_organization_id?: string | null } }>(
    '/:id',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { id } = request.params
      const { name, parent_organization_id } = request.body

      const existing = await findOrganizationForUser(id, sub)
      if (!existing) {
        return reply.code(404).send({ error: 'Organization not found' })
      }

      if (name !== undefined) {
        const trimmed = name.trim()
        if (trimmed.length === 0) {
          return reply.code(400).send({ error: 'Organization name cannot be empty' })
        }
        if (trimmed.length > ORGANIZATION_NAME_MAX) {
          return reply.code(400).send({ error: 'Organization name is too long' })
        }
      }

      if (parent_organization_id !== undefined && parent_organization_id !== null) {
        if (parent_organization_id === id) {
          return reply.code(400).send({ error: 'An organization cannot be nested inside itself' })
        }
        const target = await findOrganizationForUser(parent_organization_id, sub)
        if (!target) {
          return reply.code(404).send({ error: 'Parent organization not found' })
        }
        // Moving under a folder whose ancestor chain contains THIS folder
        // would make this folder its own ancestor — a cycle.
        const targetAncestors = await ancestorIdsOf(parent_organization_id, sub)
        if (targetAncestors && targetAncestors.includes(id)) {
          return reply.code(400).send({
            error: 'An organization cannot be moved inside one of its own sub-organizations',
          })
        }
      }

      try {
        const updated = await updateOrganization(id, sub, { name, parent_organization_id })
        if (!updated) {
          return reply.code(404).send({ error: 'Organization not found' })
        }
        return { ...updated, agent_count: await countMemberAgents(id) }
      } catch (err) {
        if (isUniqueViolation(err)) {
          return reply.code(409).send({
            error: 'You already have an organization with this name in that place',
          })
        }
        if (isForeignKeyViolation(err)) {
          return reply.code(404).send({ error: 'Parent organization not found' })
        }
        throw err
      }
    },
  )

  // DELETE /organizations/:id — the folder goes away, its contents move up
  // one level (sub-organizations and member agents take its parent). Agents
  // are never orphaned or hidden: the promotion runs in the same transaction
  // as the delete (repositories/agent-organizations.ts).
  app.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { id } = request.params

    const existing = await findOrganizationForUser(id, sub)
    if (!existing) {
      return reply.code(404).send({ error: 'Organization not found' })
    }

    await deleteOrganizationPromoting(id, sub)
    return { ok: true }
  })
}
