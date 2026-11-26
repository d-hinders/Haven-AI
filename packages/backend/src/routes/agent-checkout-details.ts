import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { agentAuthMiddleware, type AgentContext } from '../middleware/agentAuth.js'
import { authMiddleware } from '../middleware/auth.js'
import { config } from '../config.js'
import {
  findAgentIdStatusForUser,
  getAgentCheckoutDetailsRow,
  setAgentCheckoutDetailsSharingEnabled,
  type AgentCheckoutDetailsRow,
} from '../infra/repositories/agents.js'
import { resolveCheckoutDetails } from '../modules/agents/index.js'

/**
 * #4871: the owner's per-agent checkout-details sharing body. The schema in
 * the OpenAPI spec (`UpsertAgentCheckoutDetailsSharingRequest`) is the only
 * shape the enforced request-validation plugin admits; this interface is the
 * handler's view of it.
 */
interface CheckoutDetailsSharingToggleBody {
  checkout_details_sharing_enabled: boolean
}

/**
 * This is an owner-only API surface: an agent's own API key must never manage
 * the sharing switch. Same named-refusal precedent as
 * `routes/agent-tax-declaration.ts`'s `refuseAgentKey` — an agent key is a
 * RECOGNISABLE kind of wrong credential, so this hook names it with its own
 * 403 before falling through to the generic 401.
 */
function refuseAgentKey(request: FastifyRequest, reply: FastifyReply, done: () => void): void {
  const authHeader = String(request.headers.authorization ?? '')
  const xApiKey = String(request.headers['x-api-key'] ?? '')
  if (authHeader.startsWith('Bearer sk_agent_') || xApiKey.startsWith('sk_agent_')) {
    reply.code(403).send({
      error: 'Agent API keys cannot manage checkout-details sharing.',
      hint: 'This route needs an owner session: sign in to the dashboard, or run `haven login`.',
    })
    return
  }
  done()
}

/**
 * A FACTORY, not a shared constant array (the #3332 round-2 M-A rule): each
 * call returns a FRESH array, so a hook pushed onto one route's options can
 * never reach another's.
 */
const ownerHooks = () => [refuseAgentKey, authMiddleware]

/**
 * The per-agent checkout-details sharing routes (#4871, epic #4868).
 *
 * Two surfaces, deliberately in ONE module so the credential each wants is
 * visible side by side:
 *
 * - `PUT /agents/:id/checkout-details-sharing` — the OWNER's switch.
 *   Route-level `onRequest: [refuseAgentKey, authMiddleware]` (the
 *   `routes/agent-tax-declaration.ts:128` pattern): the agent-key refusal is
 *   the FIRST hook, so an agent key gets its named 403 rather than the
 *   generic 401 a session check would answer, and an unauthenticated caller
 *   still gets the generic 401 from `authMiddleware`.
 * - `GET /agents/:id/checkout-details` — the AGENT's own read, behind the
 *   route-level `agentAuthMiddleware`.
 *
 * This slice READS and writes ONE boolean and returns the owner's stored
 * values to the owning agent. It sends nothing to any merchant: #4872
 * attaches the answer to the paid request. The switch grants no spending
 * authority and changes no payment term.
 *
 * NOTE the PUT must be registered on the app that mounts this module — NOT on
 * `routes/agents.ts`, whose instance-level `addHook('onRequest',
 * authMiddleware)` would run BEFORE any route-level hook here and answer an
 * agent key with the generic 401 instead of this route's named 403 (the
 * reason stated at `agent-tax-declaration.ts:123-127`).
 */
export default async function agentCheckoutDetailsRoutes(app: FastifyInstance): Promise<void> {
  // PUT /agents/:id/checkout-details-sharing — the OWNER's per-agent switch.
  //
  // Switching ON is refused with a structured 409 when the deployment flag is
  // off; switching OFF is deliberately never gated, so an owner can always
  // withdraw sharing (the same reasoning as the tax toggle and
  // `DELETE /user/company-details`). Unlike the tax toggle there is NO
  // requirement that details are stored: the switch may be on with nothing
  // saved, and the agent's read then answers `no_details` (issue #4871).
  //
  // Nothing is written on a refusal: the repository's UPDATE carries the gate
  // in its WHERE clause, so zero rows updated means zero state change.
  app.put<{ Params: { id: string }; Body: CheckoutDetailsSharingToggleBody }>(
    '/:id/checkout-details-sharing',
    { onRequest: ownerHooks() },
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { id } = request.params
      const enabled = request.body.checkout_details_sharing_enabled

      const result = await setAgentCheckoutDetailsSharingEnabled(
        id,
        sub,
        enabled,
        config.ownerCompanyDetailsEnabled,
      )
      if (!result) {
        // Either the agent is not this user's (404, the surface's uniform
        // not-yours answer) or the switch-on was refused (409 with the
        // reason). Disambiguate with a bare existence read — the same
        // two-step the tax toggle uses.
        const exists = await findAgentIdStatusForUser(id, sub)
        if (!exists) {
          return reply.code(404).send({ error: 'Agent not found' })
        }
        return reply.code(409).send({
          error: 'The company-details feature is off in this deployment.',
          reason: 'feature_disabled',
          available: false,
        })
      }
      return { id: result.id, checkout_details_sharing_enabled: result.checkout_details_sharing_enabled }
    },
  )

  // GET /agents/:id/checkout-details — the agent's own read of the details it
  // may share. The gate is AT READ TIME: the switch being on is not enough.
  // The owner switching it off, clearing the stored fields, or the deployment
  // flag going off each return the structured `{ available: false, reason }`
  // — never a cached or stale answer.
  //
  // NOTE the agent auth hook is ROUTE-level here, not module-level: the owner
  // PUT shares this module and must never meet it (an instance `addHook` runs
  // BEFORE any route-level hook, so a blanket hook would answer an owner's
  // session token with the agent 401 before this route's own named agent-key
  // refusal could run).
  app.get<{ Params: { id: string } }>(
    '/:id/checkout-details',
    { onRequest: agentAuthMiddleware },
    async (request, reply) => {
      const agent = request.agent as AgentContext

      // The agent key IS the tenant scope: the path's id must name the
      // authenticated agent itself. Reading another agent's details (even one
      // of the same owner's) through this endpoint is not a thing — the URL
      // is the agent's own, and a mismatched id is refused before any
      // company-details row is read.
      if (request.params.id !== agent.id) {
        return reply.code(403).send({
          available: false,
          reason: 'disabled',
          error: 'These checkout details belong to a different agent.',
        })
      }

      const row: AgentCheckoutDetailsRow | null = await getAgentCheckoutDetailsRow(agent.id)
      if (!row) {
        // The authenticated agent's row vanished between auth and the read
        // (a concurrent revoke). Fail closed with the owner-choice reason —
        // an agent that no longer exists has no sharing switch.
        return reply.code(200).send({ available: false, reason: 'disabled' })
      }

      const result = resolveCheckoutDetails({
        featureEnabled: config.ownerCompanyDetailsEnabled,
        sharingEnabled: row.checkout_details_sharing_enabled,
        receipt_email: row.receipt_email,
        billing_address: row.billing_address,
        shipping_address: row.shipping_address,
      })

      // 200 in BOTH branches: availability is the body, not the status code.
      // Details that are temporarily unavailable (the owner mid-toggle, or
      // nothing saved yet) are a normal state an agent polls, not an error —
      // the same convention the tax read sets.
      return reply.code(200).send(result)
    },
  )
}
