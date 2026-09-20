/**
 * Labels — the agent-labelling vocabulary (#3167).
 *
 * `agent_labels` is the user's own tag list ("prod", "experimental",
 * "finance"); `routes/agent-labels.ts` attaches labels to agents. Labels are
 * DISPLAY/CATEGORIZATION ONLY: nothing here touches delegation, budgets or
 * on-chain enforcement, and nothing in the money path reads these tables.
 *
 * Born ENFORCED (#3028): every route's request schema is enforced through the
 * request-validation plugin (`enforcedModules` in `src/index.ts`), so the
 * handlers carry no type-guard ladders — a shape-refused body never reaches
 * them. What remains is the semantic guard the spec does not express:
 * names blank after trimming, and the 64-character cap (the column width the
 * DB enforces; a clean 400 here beats Postgres's 22001 as a 500).
 *
 * Name normalization: create lowercases (the unique index is on lower(name),
 * so "Prod" and "prod" are one label); rename rejects an uppercase variant
 * that collides with a DIFFERENT existing label, then lowercases on the way
 * in. Case is display-case: "Prod" stored as "prod" renders as the user
 * typed it only if they typed it lowercase — the rule the issue chose is one
 * name per user, so the stored form is canonical.
 *
 * Create-vs-existing colour (#3200): POST on a name the user already has
 * folds onto that row, and an OMITTED colour leaves the existing colour
 * alone — the editor's inline-create sends only a name, so without this
 * guard every quiet fold would sweep the label to neutral. An explicit
 * colour still recolours (that is the "or set" half of create-or-set).
 */
import { FastifyInstance } from 'fastify'
import { LABEL_COLORS, DEFAULT_LABEL_COLOR, isLabelColor } from '@haven_ai/core'
import { authMiddleware } from '../middleware/auth.js'
import {
  createLabel,
  deleteLabel,
  findLabelForUser,
  listLabelsForUser,
  updateLabel,
  type AgentLabelRow,
} from '../infra/repositories/agent-labels.js'

/** The spec's own caps, restated for the handlers (the plugin refuses the rest). */
export const LABEL_NAME_MAX = 64

/** Postgres 23505 — unique_violation, the collision the rename path can hit. */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505'
}

export default async function labelRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  // GET /labels — the user's label vocabulary
  app.get('/', async (request) => {
    const { sub } = request.user as { sub: string }
    return { labels: await listLabelsForUser(sub) }
  })

  // POST /labels — create one label (or fold onto the same-named one)
  app.post<{ Body: { name: string; color?: string } }>('/', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { name, color } = request.body

    // The spec enforces shape; blank-after-trim is the semantic guard the
    // schema cannot express (same split as contacts.ts).
    const trimmed = name.trim()
    if (trimmed.length === 0) {
      return reply.code(400).send({ error: 'Label name cannot be empty' })
    }
    if (color !== undefined && !isLabelColor(color)) {
      return reply.code(400).send({ error: 'Unknown label color' })
    }

    // Omitted colour: a NEW row takes the palette default, but a row that
    // already exists keeps its colour (#3200) — the fold must not recolour
    // what the caller never named. Only an explicit colour recolours.
    const explicitColor = color !== undefined
    const labelColor = explicitColor ? color : DEFAULT_LABEL_COLOR
    const label = await createLabel(sub, trimmed.toLowerCase(), labelColor, explicitColor)
    return reply.code(201).send(label)
  })

  // PUT /labels/:id — rename and/or recolor
  app.put<{ Params: { id: string }; Body: { name?: string; color?: string } }>(
    '/:id',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { id } = request.params
      const { name, color } = request.body

      const existing = await findLabelForUser(id, sub)
      if (!existing) {
        return reply.code(404).send({ error: 'Label not found' })
      }
      if (name !== undefined) {
        const trimmed = name.trim()
        if (trimmed.length === 0) {
          return reply.code(400).send({ error: 'Label name cannot be empty' })
        }
        if (trimmed.length > LABEL_NAME_MAX) {
          return reply.code(400).send({ error: 'Label name is too long' })
        }
      }
      if (color !== undefined && !isLabelColor(color)) {
        return reply.code(400).send({ error: 'Unknown label color' })
      }

      // The unique index fires on lower(name): renaming onto a name another
      // of the user's labels holds is a 409, not a 500. Only labels this
      // user owns can collide (the WHERE clause above).
      let updated: AgentLabelRow | null
      try {
        updated = await updateLabel(id, sub, {
          name: name === undefined ? undefined : name.trim().toLowerCase(),
          color,
        })
      } catch (err) {
        if (isUniqueViolation(err)) {
          return reply.code(409).send({ error: 'A label with this name already exists' })
        }
        throw err
      }
      if (!updated) {
        return reply.code(404).send({ error: 'Label not found' })
      }
      return updated
    },
  )

  // DELETE /labels/:id — delete one label; assignments cascade (migration
  // 090), agents are untouched. The response says what the user's agents
  // keep, because the management UI's confirm dialog promises exactly that.
  app.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { id } = request.params

    const deleted = await deleteLabel(id, sub)
    if (!deleted) {
      return reply.code(404).send({ error: 'Label not found' })
    }
    return { ok: true }
  })
}

// Re-exported so the palette the routes accept stays ONE list (`LABEL_COLORS`
// is core's data; this line documents that routes/labels.ts adds no colours).
export { LABEL_COLORS }
