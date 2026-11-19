/**
 * GET /x402/:id/payment-required — the merchant's x402 challenge as Haven
 * stored it at authorize (#1355), for any x402 intent of the calling agent
 * (#4872 part 2b).
 *
 * The keyless hosted server needs it on the state-direct path: `haven_submit`
 * relays a plain-HTTP payment's signature and must decide the merchant's
 * checkout-details request BEFORE it spends, then hand the answer back with
 * the retry headers. A plain-HTTP intent stores no merchant call context, so
 * `GET /x402/:id/merchant-call-context` answers it 409; the local signer's
 * `GET /x402/:id/sign-context` re-serves the same challenge but is the
 * signer's handoff, and rebuilds signing state the hosted server must not
 * need.
 *
 * Trust model: this constructs nothing and authorizes nothing. It re-serves
 * merchant content the same agent credential can already read through
 * sign-context. The challenge is untrusted: the hosted server reads its
 * checkout-details entry with the SDK's parser, which treats anything
 * malformed as no request. It never carries the owner's details.
 *
 * Read-only: no lazy expiry, no write. Not found and not yours are the same
 * 404, as on the other per-intent reads.
 */
import type { AgentContext } from '../../middleware/agentAuth.js'
import { findIntentForAgent } from '../../infra/repositories/payment-intents.js'
import { storedPaymentRequiredFromMetadata } from './sign-context.js'
import type { X402HandlerResult } from './types.js'

export async function getX402StoredPaymentRequired(
  agent: AgentContext,
  paymentId: string,
): Promise<X402HandlerResult> {
  const existing = (await findIntentForAgent(paymentId, agent.id)) as Record<string, unknown> | null
  if (!existing) {
    return { code: 404, body: { error: 'Payment intent not found' } }
  }
  if (!existing.x402_resource_url && !existing.payment_resource_url) {
    return {
      code: 409,
      body: {
        error: 'Not an x402 intent — payment-required serves the stored x402 challenge only.',
        error_code: 'payment_required_unavailable',
      },
    }
  }
  return {
    code: 200,
    body: {
      payment_id: existing.id,
      // Absent on a pre-#1355 row, and on a challenge too large to store.
      payment_required: storedPaymentRequiredFromMetadata(existing.machine_metadata),
    },
  }
}
