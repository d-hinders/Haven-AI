/**
 * Presenting an agent's passport alongside an x402 payment (#976, epic #970).
 *
 * ## The target, and the honest shape of it
 *
 * "Present inline, verify authoritatively": the agent carries a compact
 * reference (the attestation UID) with the payment so a merchant **verifies
 * rather than discovers**. Discovery would mean the merchant querying Haven to
 * find out whether an agent has a passport at all; verification means it
 * already holds the pointer and only needs to confirm.
 *
 * That is the target. What is actually deliverable per settlement scheme is
 * narrower, and the narrowness is the point:
 *
 * | Scheme | Can the reference ride the payment? | Delivery |
 * |---|---|---|
 * | **erc7710** (direct settlement) | Best-effort | Haven's settle response carries it; the agent presents it however the channel allows. The merchant already sees the delegation during redemption, so this is a bonus, not the mechanism. |
 * | **EIP-3009** (#946, the path with real merchant reach) | **No** | The merchant sees a STANDARD header from the delegate EOA. The passport cannot ride a delegation chain that is not in the payment. `GET /passport/verify?address=…` is the ONLY delivery. |
 *
 * The 3009 row is the strongest argument for the verifier endpoint being
 * PRIMARY rather than a fallback — the scheme with actual merchant adoption
 * cannot carry the reference at all. Anything that presents inline delivery as
 * the mechanism would be describing the rarer path as if it were the common one.
 *
 * ## Why this never touches the X-PAYMENT header
 *
 * x402 does not guarantee arbitrary-metadata passthrough. The header is parsed
 * by a merchant FACILITATOR we do not control, and an unrecognised key in the
 * payload is a rejection risk — a failed payment traded for a nice-to-have.
 * So the reference rides HAVEN's own response body, where the agent reads it
 * and decides. `x402-delegation.test.ts` pins the header's key set against
 * exactly this temptation.
 */

import type { FastifyRequest } from 'fastify'
import * as repo from '../../infra/repositories/agent-passports.js'
import type { Executor } from '../../infra/repositories/agent-passports.js'

/** The compact reference an agent can present. Absent is a normal answer. */
export interface PassportReference {
  /** EAS attestation UID — the thing a merchant verifies against. */
  attestation_uid: string
  /** Chain the attestation lives on; a UID is meaningless without it. */
  chain_id: number
  /** Where to verify authoritatively. Live standing goes beyond the anchor. */
  verify_url: string
}

/**
 * Absolute base URL for links we hand to an agent. Mirrors the helper in
 * `agent-connection-setups.ts` rather than importing it — that module is a
 * route file, and a lib importing a route to get a string is worse than four
 * duplicated lines.
 */
function apiBaseUrl(request: FastifyRequest): string {
  const env = process.env.HAVEN_API_URL ?? process.env.PUBLIC_API_URL
  if (env) return env.replace(/\/+$/, '')
  const host = request.headers.host ?? `localhost:${process.env.PORT ?? 3001}`
  const proto = request.headers['x-forwarded-proto']
  const scheme = typeof proto === 'string' && proto ? proto.split(',')[0] : 'http'
  return `${scheme}://${host}`.replace(/\/+$/, '')
}

/**
 * The reference for an agent, or null when there is nothing presentable.
 *
 * ONLY an anchored passport with a UID qualifies, matching the verifier's own
 * `WHERE p.status = 'anchored'` filter. A requested-but-not-yet-anchored
 * passport is deliberately indistinguishable from no passport here: handing an
 * agent a reference to something a merchant cannot verify would produce a
 * failed lookup that looks like a revoked agent.
 *
 * NEVER THROWS. This is decoration on a payment response — the payment has
 * already been authorised and signed by the time we get here, and a passport
 * lookup failing must not turn a good payment into an error. Absence is the
 * graceful degradation the acceptance criteria ask for, and it is also the
 * failure mode.
 */
export async function passportReferenceFor(
  agentId: string,
  request: FastifyRequest,
  db?: Executor,
): Promise<PassportReference | null> {
  try {
    const row = await repo.findByAgent(agentId, db)
    if (!row || row.status !== 'anchored' || !row.attestation_uid) return null
    return {
      attestation_uid: row.attestation_uid,
      chain_id: row.chain_id,
      verify_url: `${apiBaseUrl(request)}/passport/verify?uid=${row.attestation_uid}`,
    }
  } catch {
    // Swallowed on purpose — see above. The payment is what matters; the
    // reference is not.
    return null
  }
}
