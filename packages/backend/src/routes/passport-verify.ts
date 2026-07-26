/**
 * L0 Agent Passport — the public verification endpoint (#974, epic #970).
 *
 * **Unauthenticated by design.** The caller is a merchant deciding whether to
 * serve an agent; it has no Haven account and cannot be asked to get one. That
 * makes the disclosure boundary the only protection, which is why the receipt
 * carries booleans and public on-chain addresses and nothing else — see
 * `lib/passport/verification.ts`.
 *
 * ## Perimeter
 *
 * This answers a question about an agent's GOVERNANCE STATUS. It verifies no
 * payment and settles nothing — see the note in `verification.ts` before
 * growing it.
 */

import type { FastifyInstance } from 'fastify'
import { isAddress } from '@haven_ai/core'
import { publicIssuerRateLimit, publicVerifyRateLimit } from '../middleware/rate-limit.js'
import {
  verifyPassport,
  isReceiptSigningConfigured,
  receiptIssuerAddress,
  RECEIPT_TTL_SECONDS,
  RECEIPT_VERSION,
} from '../lib/passport/index.js'

const UID_RE = /^0x[0-9a-fA-F]{64}$/

export default async function passportVerifyRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The issuer a merchant pins to verify receipts offline.
   *
   * Published so pinning is a one-time setup step rather than something a
   * merchant has to extract from a receipt it has not yet verified — trusting
   * the issuer field of an unverified artifact is circular.
   */
  app.get('/issuer', { config: publicIssuerRateLimit }, async (_request, reply) => {
    const issuer = receiptIssuerAddress()
    if (!issuer) {
      return reply.code(503).send({ error: 'Passport verification is not configured on this deployment' })
    }
    return reply.send({
      issuer,
      version: RECEIPT_VERSION,
      receipt_ttl_seconds: RECEIPT_TTL_SECONDS,
      signature_scheme: 'eip191-personal-sign-over-canonical-json',
    })
  })

  /**
   * `GET /passport/verify?address=0x…` or `?uid=0x…`
   *
   * Returns a signed receipt. An agent with no passport returns 200 with
   * `found: false` — a normal answer, not a 404: issuance is opt-in, so most
   * agents have none, and an error status invites integrations to treat a
   * lookup failure as a pass.
   */
  app.get<{ Querystring: { address?: string; uid?: string } }>(
    '/verify',
    { config: publicVerifyRateLimit },
    async (request, reply) => {
      const { address, uid } = request.query

      if (!isReceiptSigningConfigured()) {
        // Fail closed rather than serving an unsigned receipt: an artifact a
        // merchant cannot authenticate is worse than no artifact, because it
        // still looks like an answer. Same posture as the schema UID.
        return reply
          .code(503)
          .send({ error: 'Passport verification is not configured on this deployment' })
      }

      if ((address && uid) || (!address && !uid)) {
        return reply.code(400).send({ error: 'Provide exactly one of `address` or `uid`' })
      }
      if (address && !isAddress(address)) {
        return reply.code(400).send({ error: 'Invalid address' })
      }
      if (uid && !UID_RE.test(uid)) {
        return reply.code(400).send({ error: 'Invalid attestation UID' })
      }

      const result = await verifyPassport(address ? { address } : { attestationUid: uid as string })

      if (!result.found) {
        // No cache: "no passport today" can become "passport tomorrow", and a
        // cached negative would keep a newly-issued agent locked out.
        reply.header('cache-control', 'no-store')
        return reply.send({ found: false, reason: result.reason })
      }

      // The receipt carries its own signed freshness envelope, so an HTTP cache
      // must never outlive it. Kept short of the TTL so a cached copy cannot be
      // served at the moment it expires.
      reply.header('cache-control', `public, max-age=${Math.floor(RECEIPT_TTL_SECONDS / 2)}`)
      return reply.send({ found: true, ...result.signed })
    },
  )
}
