import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { config } from '../config.js'
import { authMiddleware, OWNER_UNAUTHORIZED_BODY } from '../middleware/auth.js'
import {
  readCompanyDetails,
  recheckIfStalePending,
  removeCompanyDetails,
  triggerManualRecheck,
  writeCompanyDetails,
  type CompanyDetailsValidationError,
} from '../modules/owner-profile/index.js'
import type { OwnerCompanyDetailsRow } from '../infra/repositories/owner-company-details.js'

interface UpsertBody {
  legal_name: string
  country: string
  org_number: string
  vat_number?: string | null
}

/**
 * Shape (lengths, ISO2 country, VAT/org-number pattern) is the spec's,
 * enforced before the handler — this module is born ENFORCED
 * (`index.ts`'s `enforcedModules`). What remains here is semantic: blank-
 * after-trim, the VAT-number normalisation, and the VIES-status transition,
 * none of which a JSON-Schema pattern alone can express.
 */
const VALIDATION_MESSAGES: Record<CompanyDetailsValidationError, string> = {
  invalid_legal_name: 'Enter a legal name using 200 characters or fewer.',
  invalid_country: 'Country must be a two-letter ISO 3166-1 code, e.g. "SE".',
  invalid_org_number: 'Enter an organisation number using 32 characters or fewer.',
  invalid_vat_number: 'Enter a VAT number as a two-letter country prefix followed by up to 20 letters or digits.',
}

function toWireRow(row: OwnerCompanyDetailsRow) {
  return {
    legal_name: row.legal_name,
    country: row.country,
    org_number: row.org_number,
    vat_number: row.vat_number,
    vies_status: row.vies_status,
    vies_checked_at: row.vies_checked_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/**
 * Behind the flag, EVERY route in this module answers 404 — not just the
 * dashboard form. #3332 gates the feature, not only its UI: a deployment
 * with the flag off must behave as though `parties.buyer` and this whole
 * settings surface do not exist.
 */
function requireFeatureEnabled(request: FastifyRequest, reply: FastifyReply, done: () => void): void {
  if (!config.ownerCompanyDetailsEnabled) {
    reply.code(404).send({ error: 'Not found' })
    return
  }
  done()
}

/**
 * This is a dashboard-only settings surface: an agent's own API key must
 * never manage its owner's company details. `authMiddleware` already refuses
 * a non-JWT bearer token with 401 (the same body a bad session token gets),
 * which conflates "wrong kind of credential" with "no credential at all".
 * An agent key is a RECOGNISABLE kind of wrong credential, so this route
 * names it with its own 403 before falling through to the generic 401 —
 * matching `middleware/agentAuth.ts`'s own precedent of a NAMED refusal
 * rather than the generic one wherever the caller's mistake is legible.
 */
function refuseAgentKey(request: FastifyRequest, reply: FastifyReply, done: () => void): void {
  // `String(undefined)` is `"undefined"`, which does not start with either
  // prefix below — no `typeof` narrowing needed for what is, either way, a
  // best-effort heuristic refusal (the real refusal is `authMiddleware`'s
  // `jwtVerify`, which follows this hook).
  const authHeader = String(request.headers.authorization ?? '')
  const xApiKey = String(request.headers['x-api-key'] ?? '')
  const looksLikeAgentKey = authHeader.startsWith('Bearer sk_agent_') || xApiKey.startsWith('sk_agent_')
  if (looksLikeAgentKey) {
    reply.code(403).send({
      error: 'Agent API keys cannot manage owner company details.',
      hint: 'This route needs an owner session: sign in to the dashboard, or run `haven login`.',
    })
    return
  }
  done()
}

export default async function ownerCompanyDetailsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireFeatureEnabled)
  app.addHook('onRequest', refuseAgentKey)
  app.addHook('onRequest', authMiddleware)

  // GET /user/company-details
  app.get('/company-details', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    // Re-trigger a stuck `pending` check as a side effect of the read (see
    // the route's own OpenAPI description for the tradeoff against a
    // background sweep) — fire-and-forget, never blocks this response.
    void recheckIfStalePending(sub)
    const row = await readCompanyDetails(sub)
    if (!row) return reply.code(404).send({ error: 'No company details saved' })
    return toWireRow(row)
  })

  // PUT /user/company-details
  app.put<{ Body: UpsertBody }>('/company-details', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const result = await writeCompanyDetails(sub, {
      legal_name: request.body.legal_name,
      country: request.body.country,
      org_number: request.body.org_number,
      vat_number: request.body.vat_number ?? null,
    })
    if (!result.ok) {
      return reply.code(400).send({ error: VALIDATION_MESSAGES[result.error] })
    }
    return toWireRow(result.row)
  })

  // DELETE /user/company-details
  app.delete('/company-details', async (request) => {
    const { sub } = request.user as { sub: string }
    await removeCompanyDetails(sub)
    return { ok: true }
  })

  // POST /user/company-details/vies-check
  app.post('/company-details/vies-check', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const pending = await triggerManualRecheck(sub)
    if (!pending) {
      return reply.code(404).send({ error: 'No VAT number saved to check' })
    }
    return toWireRow(pending)
  })
}

// Re-exported for the unauthorized-body identity check in tests, and so a
// future caller cannot drift from `middleware/auth.ts`'s own constant.
export { OWNER_UNAUTHORIZED_BODY }
