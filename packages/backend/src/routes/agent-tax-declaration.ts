import { FastifyInstance } from 'fastify'
import { agentAuthMiddleware, type AgentContext } from '../middleware/agentAuth.js'
import { config } from '../config.js'
import {
  getAgentTaxDeclarationRow,
  type AgentTaxDeclarationRow,
} from '../infra/repositories/agents.js'
import {
  resolveTaxDeclaration,
  TAX_DECLARATION_MAX_VIES_AGE_MS,
  TAX_DECLARATION_MAX_WINDOW_MS,
} from '../modules/agents/index.js'

/**
 * GET /agents/:id/tax-declaration — the AGENT's own read of its x402
 * buyer-side tax declaration content (#3426, wg-tax #5 §2.1).
 *
 * This slice READS only. The declaration is never signed and never sent
 * from here: #3427 signs it (EIP-712, same key as the EIP-3009 payment
 * authorization) and carries it on EIP-3009 payments only. The response is
 * the UNSIGNED §2.1 content — `version`, `jurisdiction`, `taxableStatus`,
 * `taxId`, `validUntil` — and nothing else: no `signature` (this slice
 * signs nothing), no `principalId`, no `principalAttributionHash` (the SDK
 * computes those locally, #3427), and none of the company-details fields
 * the declaration does not state (`legal_name`, `org_number`,
 * `vies_status`, `vies_checked_at`).
 *
 * Auth is the module-level `agentAuthMiddleware`: an agent key authenticates
 * exactly one agent, and the handler scopes every read to `request.agent`.
 * The agent can only ever read ITS OWN owner's declaration — the id in the
 * path is the agent the key belongs to, and the read runs on
 * `agent.user_id`'s company-details row, never on a caller-chosen owner.
 *
 * The gate is AT READ TIME: the opt-in bit being on is not enough. VIES
 * dropping to `invalid`/`not_verifiable`/`pending`, the owner switching the
 * toggle off, clearing the VAT number, or the deployment flag going off each
 * return the structured `{ available: false, reason }` — never a cached or
 * stale declaration. The four reasons are the issue's closed list; the
 * priority order (flag → opt-in → VAT number → VIES) is
 * `resolveTaxDeclaration`'s, so the same facts always produce the same
 * single reason.
 *
 * `validUntil` is integer milliseconds, double-bounded by
 * `now + TAX_DECLARATION_MAX_WINDOW_MS` and
 * `vies_checked_at + TAX_DECLARATION_MAX_VIES_AGE_MS` — the check's own
 * freshness caps the declaration, because §2.1's facts rest on the check.
 */
export default async function agentTaxDeclarationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', agentAuthMiddleware)

  app.get<{ Params: { id: string } }>('/:id/tax-declaration', async (request, reply) => {
    const agent = request.agent as AgentContext

    // The agent key IS the tenant scope: the path's id must name the
    // authenticated agent itself. Reading another agent's declaration (even
    // one of the same owner's) through this endpoint is not a thing — the
    // URL is the agent's own, and a mismatched id is refused before any
    // company-details row is read.
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
    // operator mid-toggle) is a normal state an agent polls, not an error —
    // the same convention GET /user/company-details sets with its
    // 200-and-null "nothing saved" (a 404 there means ONLY "flag off").
    return reply.code(200).send(result)
  })
}

// Re-exported so the OpenAPI description and the tests quote the same two
// bounds the implementation uses — a future caller cannot drift from them.
export { TAX_DECLARATION_MAX_WINDOW_MS, TAX_DECLARATION_MAX_VIES_AGE_MS }
