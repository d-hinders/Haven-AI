import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { config } from '../config.js'
import { authMiddleware, OWNER_UNAUTHORIZED_BODY } from '../middleware/auth.js'
import { ownerProfileRateLimit } from '../middleware/rate-limit.js'
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
 * #3332 review: this module is born ENFORCED (`index.ts`'s `enforcedModules`),
 * so `UpsertCompanyDetailsRequest`'s field LENGTHS (`legal_name` ≤ 200,
 * `country` exactly 2 characters, `org_number`/`vat_number` ≤ 32) are checked
 * before the handler runs. The spec's request schema does NOT carry an ISO2
 * or VAT-shape pattern (deliberately: `validateCompanyDetailsInput` below
 * accepts lowercase and internally-spaced input — `'se 5566 7788 9901'` — and
 * normalises it, so a pre-handler pattern strict enough to name the FINAL
 * shape would reject requests this route is meant to accept). What remains
 * here is therefore everything semantic: blank-after-trim, case/whitespace
 * normalisation, the actual `^[A-Z]{2}$` / VAT-shape checks, and the
 * VIES-status transition.
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
 * Behind the flag, GET/PUT/POST all answer 404 — not just a future settings
 * UI. #3332 gates the feature itself: a deployment with the flag off must
 * behave as though `parties.buyer` and this whole surface do not exist.
 *
 * DELETE is the one exception (#3332 review, owner-privacy default): erasure
 * must work regardless of the flag, so an owner who saved details while the
 * feature was on can still remove them after an operator turns it back off —
 * see `ownerCompanyDetailsRoutes`'s own comment on the DELETE route for why
 * this hook is not registered on it.
 */
function requireFeatureEnabled(request: FastifyRequest, reply: FastifyReply, done: () => void): void {
  if (!config.ownerCompanyDetailsEnabled) {
    reply.code(404).send({ error: 'Not found' })
    return
  }
  done()
}

/**
 * This is an owner-only API surface: an agent's own API key must never
 * manage its owner's company details. `authMiddleware` already refuses
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

/**
 * #3332 review: `requireFeatureEnabled` is NOT a blanket `addHook` — it is
 * listed per-route below, everywhere except DELETE, so erasure keeps working
 * with the flag off. `refuseAgentKey` and `authMiddleware` still run on every
 * route including DELETE: an agent key must never manage (or erase) its
 * owner's details, flag or no flag.
 *
 * #3332 review round 2 (M-A): a FACTORY, not a shared constant array. Fastify
 * route options are mutated in place by plugins that hook onto them —
 * `@fastify/rate-limit`'s `onRoute` listener (`addRouteRateHook` in
 * `@fastify/rate-limit`) does `routeOptions.onRequest.push(hookHandler)` on
 * the EXACT array object a route was registered with, when that route's
 * `config.rateLimit` is set. `GET`, `PUT` and `POST` used to share one
 * `GATED` array reference: registering the limiter on `PUT`'s `config` alone
 * still pushed its rate-limit hook onto the same array `GET` (which has no
 * `config.rateLimit` at all) was ALSO registered with — so an unlimited GET
 * silently inherited PUT's limiter and bucket, and GET/PUT/POST all shared
 * ONE counter instead of each having its own. Each call below must return a
 * FRESH array so a hook pushed onto one route's hooks can never reach
 * another's.
 */
const gatedHooks = () => [requireFeatureEnabled, refuseAgentKey, authMiddleware]
const ungatedHooks = () => [refuseAgentKey, authMiddleware]

export default async function ownerCompanyDetailsRoutes(app: FastifyInstance): Promise<void> {
  // GET /user/company-details
  app.get('/company-details', { onRequest: gatedHooks() }, async (request, reply) => {
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
  app.put<{ Body: UpsertBody }>(
    '/company-details',
    { onRequest: gatedHooks(), config: { ...ownerProfileRateLimit } },
    async (request, reply) => {
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
    },
  )

  // DELETE /user/company-details — deliberately NOT gated by the flag
  // (`ungatedHooks()`, no `requireFeatureEnabled`): erasure is the owner's,
  // always, regardless of whether the feature is currently on (#3332 review,
  // owner-privacy default). `removeCompanyDetails`'s `DELETE ... WHERE
  // user_id` has nothing else to gate on either way — it is a no-op when
  // there is no row, on or off.
  app.delete('/company-details', { onRequest: ungatedHooks() }, async (request) => {
    const { sub } = request.user as { sub: string }
    await removeCompanyDetails(sub)
    return { ok: true }
  })

  // POST /user/company-details/vies-check
  app.post(
    '/company-details/vies-check',
    { onRequest: gatedHooks(), config: { ...ownerProfileRateLimit } },
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const pending = await triggerManualRecheck(sub)
      if (!pending) {
        return reply.code(404).send({ error: 'No VAT number saved to check' })
      }
      return toWireRow(pending)
    },
  )
}

// Re-exported for the unauthorized-body identity check in tests, and so a
// future caller cannot drift from `middleware/auth.ts`'s own constant.
export { OWNER_UNAUTHORIZED_BODY }
