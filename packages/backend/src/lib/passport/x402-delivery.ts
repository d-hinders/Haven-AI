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

import * as repo from '../../infra/repositories/agent-passports.js'
import type { Executor } from '../../infra/repositories/agent-passports.js'
import { isReceiptSigningConfigured } from './receipt.js'

/** The compact reference an agent can present. Absent is a normal answer. */
export interface PassportReference {
  /** EAS attestation UID — the thing a merchant verifies against. */
  attestation_uid: string
  /** Chain the attestation lives on; a UID is meaningless without it. */
  chain_id: number
  /**
   * A CONVENIENCE link to Haven's verifier, not a root of trust.
   *
   * This whole object reaches a merchant by way of the AGENT — Haven returns it
   * on the settle response, the agent forwards it over whatever channel it
   * likes. So every field here is agent-controlled by construction, `verify_url`
   * included: an agent can substitute a URL it operates and have it answer
   * `{ found: true }` for anything. A merchant that resolves the supplied URL is
   * asking the subject to vouch for itself.
   *
   * The only sound merchant behaviour is to take `attestation_uid` + `chain_id`
   * and resolve them against a verifier it ALREADY knows — its own pinned Haven
   * base URL, or EAS on that chain directly. The UID and chain id are safe to
   * accept from the agent precisely because they are checkable against a source
   * the agent does not control; the URL is not. Same reasoning as the
   * `X-PAYMENT` header note above: the trust boundary is what the merchant can
   * verify independently, not what it was handed.
   *
   * Kept because it is genuinely useful for humans and for agents fetching
   * their own standing (live standing goes beyond the anchor — a revoke does
   * not un-attest). OPTIONAL, and omitted rather than guessed: no configured
   * base URL, or a deployment whose verifier is switched off, means no field.
   */
  verify_url?: string
}

/**
 * The verify link, or null when this deployment should not emit one.
 *
 * Two conditions, and each removes a different way the link can lie:
 *
 * 1. **An env-configured base URL.** `agent-connection-setups.ts` has a
 *    near-identical helper that falls back to the request's `Host` header, and
 *    that fallback is exactly what must NOT happen here. This link travels to a
 *    merchant through the agent, and `Host` is set by the caller — deriving the
 *    URL from it would let an agent point a merchant at a host of its choosing
 *    while the value still looked server-issued.
 * 2. **A live verifier.** `PASSPORT_RECEIPT_SIGNING_KEY` is independent of the
 *    schema UID that lets issuance anchor, so a deployment can hold anchored
 *    passports while `GET /passport/verify` 503s (`passport-verify.ts` fails
 *    closed rather than serve an unsigned receipt). Emitting a link that always
 *    fails is worse than emitting none: absence is a documented normal answer,
 *    a dead link reads as a broken or fraudulent agent.
 *
 * Omitting costs nothing that matters. `attestation_uid` + `chain_id` are what
 * a merchant should be resolving anyway — against a verifier it already pins,
 * or against EAS directly.
 */
function verifyUrlFor(attestationUid: string): string | null {
  const env = process.env.HAVEN_API_URL ?? process.env.PUBLIC_API_URL
  if (!env || !isReceiptSigningConfigured()) return null
  return `${env.replace(/\/+$/, '')}/passport/verify?uid=${attestationUid}`
}

/**
 * The reference for an agent, or null when there is nothing presentable.
 *
 * ONLY an anchored passport with a UID qualifies, matching the verifier's own
 * `WHERE p.status = 'anchored'` filter. The status enum is
 * `pending | anchored | failed`, so in practice this rejects `pending` and
 * `failed` rows; `anchored` without a UID is DB-impossible (migration 048's
 * `CHECK (status <> 'anchored' OR attestation_uid IS NOT NULL)`) and the check
 * is kept only as a type narrowing. A non-anchored passport is deliberately
 * indistinguishable from no passport here: handing an agent a reference to
 * something a merchant cannot verify would produce a failed lookup that looks
 * like a revoked agent.
 *
 * NEVER THROWS. This is decoration on a payment response — the payment has
 * already been authorised and signed by the time we get here, and a lookup
 * ERROR must not turn a good payment into an error. Absence is the graceful
 * degradation the acceptance criteria ask for, and it is also the failure mode.
 * Note the scope: this covers a throw, not an unbounded hang. There is no
 * timeout here, and the caller handles that case by ordering — see the comment
 * at the call site in `routes/x402.ts`.
 *
 * The swallowed error is REPORTED through `log`, and that is not decoration
 * either. "Absence is normal" and "the lookup broke" produce the identical
 * `null` on the wire, so without this line a database outage on the passport
 * table is indistinguishable, from outside, from every agent simply not having
 * a passport. It also gives the null-because-error path an observable of its
 * own, which is what lets a test tell the two apart.
 */
export async function passportReferenceFor(
  agentId: string,
  opts: {
    db?: Executor
    /** Fastify's `request.log` satisfies this. */
    log?: { warn: (obj: Record<string, unknown>, msg: string) => void }
  } = {},
): Promise<PassportReference | null> {
  try {
    const row = await repo.findByAgent(agentId, opts.db)
    if (!row || row.status !== 'anchored' || !row.attestation_uid) return null
    const verifyUrl = verifyUrlFor(row.attestation_uid)
    return {
      attestation_uid: row.attestation_uid,
      chain_id: row.chain_id,
      ...(verifyUrl ? { verify_url: verifyUrl } : {}),
    }
  } catch (err) {
    // Swallowed on purpose — see above. The payment is what matters; the
    // reference is not. Logged so the swallow is not also a silence.
    opts.log?.warn(
      { err: err instanceof Error ? err.message : String(err), agent_id: agentId },
      'passport reference lookup failed; settle response degrades to passport: null',
    )
    return null
  }
}
