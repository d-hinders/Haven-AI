import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { agentAuthMiddleware, type AgentContext } from '../middleware/agentAuth.js'
import { authMiddleware } from '../middleware/auth.js'
import { config } from '../config.js'
import {
  findAgentIdStatusForUser,
  getAgentTaxDeclarationRow,
  setAgentTaxDeclarationEnabled,
  type AgentTaxDeclarationRow,
} from '../infra/repositories/agents.js'
import { getOwnerCompanyDetails } from '../infra/repositories/owner-company-details.js'
import {
  resolveTaxDeclaration,
  TAX_DECLARATION_MAX_VIES_AGE_MS,
  TAX_DECLARATION_MAX_WINDOW_MS,
  type TaxDeclarationUnavailableReason,
} from '../modules/agents/index.js'

/**
 * #3426: the owner's per-agent tax-declaration opt-in body. The schema in
 * the OpenAPI spec (`UpsertAgentTaxDeclarationRequest`) is the only shape
 * the enforced request-validation plugin admits; this interface is the
 * handler's view of it.
 */
interface TaxDeclarationToggleBody {
  tax_declaration_enabled: boolean
}

/**
 * The toggle's structured 409 reasons, in the same closed vocabulary as the
 * agent content endpoint's `reason` (`TaxDeclarationUnavailableReason`).
 * `disabled` cannot occur on this route (the toggle writes the bit), so the
 * map narrows to the three that can — the type says so by construction.
 */
const TAX_TOGGLE_ERRORS: Record<Exclude<TaxDeclarationUnavailableReason, 'disabled'>, string> = {
  feature_disabled: 'The company-details feature is off in this deployment.',
  no_company_details:
    'Save your company details with a VAT number before opting an agent in to tax declarations.',
  vies_not_valid:
    'Your VAT number is not VIES-valid right now, so agents cannot be opted in to tax declarations.',
}

/**
 * Reads the owner's company-details facts and returns WHY an opt-in is not
 * currently possible — the same priority order `resolveTaxDeclaration` uses,
 * minus the opt-in bit this route is itself writing. Passing the flag in
 * (not reading config here) keeps the rule testable the same way.
 */
async function taxToggleRefusalReason(
  userId: string,
  featureEnabled: boolean,
): Promise<Exclude<TaxDeclarationUnavailableReason, 'disabled'>> {
  if (!featureEnabled) return 'feature_disabled'
  const row = await getOwnerCompanyDetails(userId)
  if (!row || row.vat_number === null || row.vat_number === '') return 'no_company_details'
  return 'vies_not_valid'
}

/**
 * This is an owner-only API surface: an agent's own API key must never
 * manage tax declaration settings. Same named-refusal precedent as
 * `routes/owner-company-details.ts`'s `refuseAgentKey` — an agent key is a
 * RECOGNISABLE kind of wrong credential, so this hook names it with its own
 * 403 before falling through to the generic 401.
 */
function refuseAgentKey(request: FastifyRequest, reply: FastifyReply, done: () => void): void {
  const authHeader = String(request.headers.authorization ?? '')
  const xApiKey = String(request.headers['x-api-key'] ?? '')
  if (authHeader.startsWith('Bearer sk_agent_') || xApiKey.startsWith('sk_agent_')) {
    reply.code(403).send({
      error: 'Agent API keys cannot manage tax declaration settings.',
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
 * The x402 buyer-side tax declaration routes (#3426, wg-tax #5 §2.1).
 *
 * Two surfaces, deliberately in ONE module so the credential each wants is
 * visible side by side:
 *
 * - `PUT /agents/:id/tax-declaration` — the OWNER's toggle. Route-level
 *   `onRequest: [refuseAgentKey, authMiddleware]` (the
 *   `routes/owner-company-details.ts:124` pattern): the agent-key refusal is
 *   the FIRST hook, so an agent key gets its named 403 rather than the
 *   generic 401 a session check would answer, and an unauthenticated caller
 *   still gets the generic 401 from `authMiddleware`.
 * - `GET /agents/:id/tax-declaration` — the AGENT's own read, behind the
 *   module-level `agentAuthMiddleware`.
 *
 * This slice READS and writes ONE boolean. The declaration is never signed
 * and never sent from here: #3427 signs it (EIP-712, same key as the
 * EIP-3009 payment authorization) and carries it on EIP-3009 payments only.
 * The response is the UNSIGNED §2.1 content and nothing else — no
 * `signature`, no `principalId`, no `principalAttributionHash` (the SDK
 * computes those locally), and none of the company-details fields the
 * declaration does not state.
 */
export default async function agentTaxDeclarationRoutes(app: FastifyInstance): Promise<void> {
  // PUT /agents/:id/tax-declaration — the OWNER's per-agent opt-in. The
  // refusal for a not-yet-allowed opt-in is a structured 409, not a boolean
  // error: `{ error, reason, available: false }` with the same closed reason
  // vocabulary the agent content read uses, so the dashboard can show WHY
  // the switch is off. Nothing is written on any refusal: the repository's
  // UPDATE carries the whole gate in its WHERE clause, so zero rows updated
  // means zero state change — a VIES transition racing the route's reason
  // read lands on the UPDATE's answer, never on the stale read.
  //
  // Switching OFF is deliberately never gated: an owner whose VIES result
  // dropped is exactly the owner who needs to withdraw the opt-in, and
  // gating the OFF switch on the very fact that dropped would trap it.
  //
  // NOTE this PUT must be registered on the app that mounts this module —
  // NOT on `routes/agents.ts`, whose instance-level
  // `addHook('onRequest', authMiddleware)` would run BEFORE any route-level
  // hook here and answer an agent key with the generic 401 instead of this
  // route's named 403.
  app.put<{ Params: { id: string }; Body: TaxDeclarationToggleBody }>(
    '/:id/tax-declaration',
    { onRequest: ownerHooks() },
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { id } = request.params
      const enabled = request.body.tax_declaration_enabled

      const result = await setAgentTaxDeclarationEnabled(id, sub, enabled, config.ownerCompanyDetailsEnabled)
      if (!result) {
        // Either the agent is not this user's (404, the surface's uniform
        // not-yours answer) or the opt-in was refused (409 with the reason).
        // Disambiguate with a bare existence read — the same two-step the
        // PUT /:id profile edit uses for its FK guard.
        const exists = await findAgentIdStatusForUser(id, sub)
        if (!exists) {
          return reply.code(404).send({ error: 'Agent not found' })
        }
        const reason = await taxToggleRefusalReason(sub, config.ownerCompanyDetailsEnabled)
        return reply.code(409).send({ error: TAX_TOGGLE_ERRORS[reason], reason, available: false })
      }
      return { id: result.id, tax_declaration_enabled: result.tax_declaration_enabled }
    },
  )

  // GET /agents/:id/tax-declaration — the agent's own read of its
  // declaration content. The gate is AT READ TIME: the opt-in bit being on
  // is not enough. VIES dropping to `invalid`/`not_verifiable`/`pending`,
  // the owner switching the toggle off, clearing the VAT number, or the
  // deployment flag going off each return the structured
  // `{ available: false, reason }` — never a cached or stale declaration.
  //
  // NOTE the agent auth hook is ROUTE-level here, not module-level: the
  // owner PUT shares this module and must never meet it (an instance
  // `addHook` runs BEFORE any route-level hook, so a blanket hook would
  // answer an owner's session token with the agent 401 before this route's
  // own named agent-key refusal could run).
  app.get<{ Params: { id: string } }>(
    '/:id/tax-declaration',
    { onRequest: agentAuthMiddleware },
    async (request, reply) => {
      const agent = request.agent as AgentContext

      // The agent key IS the tenant scope: the path's id must name the
      // authenticated agent itself. Reading another agent's declaration
      // (even one of the same owner's) through this endpoint is not a thing
      // — the URL is the agent's own, and a mismatched id is refused before
      // any company-details row is read.
      if (request.params.id !== agent.id) {
        return reply.code(403).send({
          available: false,
          reason: 'disabled',
          error: 'This tax declaration belongs to a different agent.',
        })
      }

      const row: AgentTaxDeclarationRow | null = await getAgentTaxDeclarationRow(agent.id)
      if (!row) {
        // The authenticated agent's row vanished between auth and the read
        // (a concurrent revoke). Fail closed with the owner-choice reason —
        // an agent that no longer exists has no opt-in.
        return reply.code(200).send({ available: false, reason: 'disabled' })
      }

      const result = resolveTaxDeclaration({
        featureEnabled: config.ownerCompanyDetailsEnabled,
        taxDeclarationEnabled: row.tax_declaration_enabled,
        country: row.country,
        vat_number: row.vat_number,
        vies_status: row.vies_status,
        vies_checked_at: row.vies_checked_at,
        nowMs: Date.now(),
      })

      // 200 in BOTH branches: availability is the body, not the status code.
      // A declaration that is temporarily unavailable (VIES pending, an
      // operator mid-toggle) is a normal state an agent polls, not an
      // error — the same convention GET /user/company-details sets with its
      // 200-and-null "nothing saved" (a 404 there means ONLY "flag off").
      return reply.code(200).send(result)
    },
  )
}

// Re-exported so the OpenAPI description and the tests quote the same two
// bounds the implementation uses — a future caller cannot drift from them.
export { TAX_DECLARATION_MAX_WINDOW_MS, TAX_DECLARATION_MAX_VIES_AGE_MS }
