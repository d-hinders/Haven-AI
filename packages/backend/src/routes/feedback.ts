import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { feedbackSubmitRateLimit } from '../middleware/rate-limit.js'
import { insertFeedback, isKeyBackedAddress } from '../infra/repositories/feedback.js'
import {
  containsRecoveryPhrase,
  detectLabelledSecret,
  deriveAddressFromHexToken,
  findHexTokenCandidates,
} from '../modules/feedback/index.js'

/** Mirrors the CLI's own cap (`secret-check.ts`'s `MAX_FEEDBACK_TEXT_LENGTH`). */
export const MAX_FEEDBACK_TEXT_LENGTH = 4000
/** Fastify's 1 MB default is far more than one feedback submission needs. */
const MAX_BODY_BYTES = 16 * 1024

interface SubmitFeedbackBody {
  text: string
}

/**
 * `POST /feedback` (#3597) — `haven feedback submit "<text>"`.
 *
 * **User JWT only.** `authMiddleware` refuses an agent API key (it is not a
 * verifiable JWT) and an anonymous caller alike, with the same 401 body every
 * other owner-only route uses — no agent key, no MCP tool, no anonymous
 * caller, by owner decision (2026-10-02).
 *
 * **The backstop, not the control.** The CLI's own check
 * (`packages/cli/src/secret-check.ts`) refuses BEFORE any request carrying
 * the text is sent — this route is what catches a caller that bypasses the
 * CLI (a direct API call, a future second client). It re-runs layer 1
 * (labelled secrets) and layer 4 (recovery phrases) verbatim, and layer 3
 * (key-backed-address derivation) against the DATABASE rather than the
 * caller's own reads — see `isKeyBackedAddress`. Layer 2 (secrets this
 * machine holds) has no backend equivalent: the backend has no local
 * filesystem of agent credentials to compare against.
 *
 * A refused body is never logged (the 400 responses below carry a reason
 * code, never the text), and `redactVendorSecrets` runs again at the
 * repository's write boundary as a second backstop past this one.
 */
export default async function feedbackRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  app.post<{ Body: SubmitFeedbackBody }>(
    '/',
    {
      bodyLimit: MAX_BODY_BYTES,
      config: { ...feedbackSubmitRateLimit },
    },
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { text } = request.body

      // The spec's own schema (`minLength: 1`, `maxLength: 4000`) is enforced
      // by the request-validation plugin before this handler ever runs — a
      // non-string or over-length body never reaches here. What remains is
      // the one thing the spec does NOT express in schema: text that is
      // blank only AFTER trimming (the same split `routes/contacts.ts` draws).
      if (text.trim().length === 0) {
        return reply.code(400).send({ error: 'text is required' })
      }

      // Layer 1 — prefixed/labelled secrets.
      const labelled = detectLabelledSecret(text)
      if (labelled) {
        return reply.code(400).send({ error: 'text_refused', reason: labelled })
      }

      // Layer 3 — key-backed-address derivation, against the database. Only
      // runs when a 64-hex candidate exists, exactly like the CLI's own
      // check; a read failure fails CLOSED (refuses) rather than silently
      // skipping the check.
      const candidates = findHexTokenCandidates(text)
      if (candidates.length > 0) {
        try {
          for (const token of candidates) {
            const address = deriveAddressFromHexToken(token)
            if (!address) continue
            if (await isKeyBackedAddress(address)) {
              return reply.code(400).send({ error: 'text_refused', reason: 'private_key' })
            }
          }
        } catch {
          return reply.code(400).send({ error: 'text_refused', reason: 'address_check_unavailable' })
        }
      }

      // Layer 4 — recovery phrases.
      if (containsRecoveryPhrase(text)) {
        return reply.code(400).send({ error: 'text_refused', reason: 'recovery_phrase' })
      }

      const row = await insertFeedback(sub, text)
      return reply.code(201).send({ id: row.id, created_at: row.created_at, expires_at: row.expires_at })
    },
  )
}
