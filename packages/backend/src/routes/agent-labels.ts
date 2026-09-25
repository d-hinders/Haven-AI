/**
 * Agent label ASSIGNMENT (#3167) — which labels an agent carries.
 *
 * Separate file from `routes/labels.ts` on purpose, mirroring how the `/agents`
 * prefix already hosts `agents.ts`, `agent-delegations.ts`, `agent-rekey.ts`
 * and `agent-passports.ts`: the request-validation rollout (#3028) keys
 * `enforcedModules` on the route FILE, and the assignment route is born
 * ENFORCED with this file's own entry rather than by flipping the whole
 * `/agents` prefix (which would enforce `agents.ts`'s shadowed residue
 * sideways).
 *
 * The mutation is the FULL REPLACEMENT form (`PUT /agents/:id/labels`): the
 * editor renders a checkbox list, so "the set the user sees" is the natural
 * unit of intent, and a replacement survives retries idempotently. The
 * issue's per-label add/remove pair (`POST/DELETE /agents/:id/labels/:labelId`)
 * is deliberately NOT built — one mutation, one editor, one seam for #3165;
 * a per-label route with no caller is surface area, not API.
 *
 * Labels ride along on every agent read (`labels[]` on the Agent schema) so
 * the cards and the detail page never need a second round trip.
 *
 * Labels are DISPLAY/CATEGORIZATION ONLY: nothing in the delegation, budget,
 * or on-chain enforcement path reads them.
 */
import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import {
  findAgentForUserAllStatuses,
} from '../infra/repositories/agents.js'
import {
  LabelNotFoundError,
  listLabelsForAgents,
  replaceAgentLabels,
} from '../infra/repositories/agent-labels.js'

/** Hard cap on labels per assignment write: the editor offers the user's whole vocabulary, and a vocabulary beyond this is a list to manage, not tag with. */
export const MAX_LABELS_PER_AGENT = 32

export default async function agentLabelRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  // PUT /agents/:id/labels — replace the agent's whole label set
  app.put<{ Params: { id: string }; Body: { label_ids: string[] } }>(
    '/:id/labels',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { id } = request.params
      const { label_ids } = request.body

      // ALL-statuses rule (#1069): archived and revoked agents are labelled
      // like any other — organizing the Removed list is a legitimate use.
      const agent = await findAgentForUserAllStatuses(id, sub)
      if (!agent) {
        return reply.code(404).send({ error: 'Agent not found' })
      }
      if (label_ids.length > MAX_LABELS_PER_AGENT) {
        return reply.code(400).send({
          error: `An agent can carry at most ${MAX_LABELS_PER_AGENT} labels`,
        })
      }

      try {
        await replaceAgentLabels(id, sub, label_ids)
      } catch (err) {
        if (err instanceof LabelNotFoundError) {
          return reply.code(404).send({ error: err.message })
        }
        throw err
      }

      const labels = (await listLabelsForAgents([id])).get(id) ?? []
      return { labels }
    },
  )
}
