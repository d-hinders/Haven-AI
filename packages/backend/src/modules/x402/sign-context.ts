/**
 * GET /x402/:id/sign-context — the byte-free signing handoff (#1263).
 *
 * A delegation-rail x402 signing payload is a multi-KB EIP-712 structure. The
 * hosted-MCP → local-signer contract used to require the AGENT (a language
 * model) to re-emit it verbatim between two tool calls; runtimes that elide
 * long tool results structurally cannot do that, so valid intents died at the
 * signer's (correct) digest refusal — #1255's transport hardening was
 * necessary but not sufficient. This read-only endpoint lets the local signer
 * fetch the exact bytes itself, authenticated with the agent credential it
 * already stores locally: the model relays only `payment_id`.
 *
 * Trust model unchanged: this constructs nothing new — it re-serves what the
 * #961 replay always could rebuild from the stored row, with a fresh
 * Haven-signed expected context committing to the same typed-data digest. The
 * signer's re-derivation (#1138) and binding verification run against this
 * response exactly as they do against an authorize response.
 */
import type { AgentContext } from '../../middleware/agentAuth.js'
import {
  findIntentForAgent,
  expirePendingIntent,
} from '../../infra/repositories/payment-intents.js'
import { rebuildDelegationSignContext } from './replay.js'
import type { X402HandlerResult } from './types.js'

export async function getX402SignContext(
  agent: AgentContext,
  paymentId: string,
): Promise<X402HandlerResult> {
  const existing = (await findIntentForAgent(paymentId, agent.id)) as
    | Record<string, unknown>
    | null
  // Not found and not-yours are the same answer on purpose: an id enumerator
  // learns nothing about other agents' intents.
  if (!existing) {
    return { code: 404, body: { error: 'Payment intent not found' } }
  }
  if (!existing.x402_resource_url && !existing.payment_resource_url) {
    return {
      code: 409,
      body: {
        error:
          'Not an x402 intent — sign-context serves the x402 signing handoff only. ' +
          'For a direct payment, sign the typed_data_b64 from the haven_pay/haven_send result instead.',
        error_code: 'sign_context_unavailable',
      },
    }
  }
  if (existing.status === 'confirmed' && existing.tx_hash) {
    return {
      code: 409,
      body: {
        payment_id: existing.id,
        status: existing.status,
        tx_hash: existing.tx_hash,
        error: 'Payment already executed — nothing left to sign',
        error_code: 'already_executed',
      },
    }
  }
  if (existing.status !== 'pending_signature') {
    return {
      code: 409,
      body: {
        payment_id: existing.id,
        status: existing.status,
        error: `Payment is ${existing.status}, not pending_signature`,
        error_code: 'not_signable',
      },
    }
  }
  if (new Date(existing.expires_at as string) < new Date()) {
    // Same lazy-expire discipline as the #961 replay: a stale pending row
    // holds the idempotency key until something flips its status.
    await expirePendingIntent(existing.id as string, agent.id)
    return {
      code: 410,
      body: {
        payment_id: existing.id,
        status: 'expired',
        error: 'Payment window expired — re-run the quote with the same idempotency key',
        error_code: 'expired',
      },
    }
  }
  const rebuilt = await rebuildDelegationSignContext(existing, agent)
  if (!rebuilt) {
    // Legacy-rail x402 stores no prepared op; its sign_data is the short hash
    // from the original authorize response, which never needed this handoff.
    return {
      code: 409,
      body: {
        payment_id: existing.id,
        error:
          'No stored signing payload for this intent — legacy-rail x402 signs the ' +
          'payload_hash from the original authorize/quote response',
        error_code: 'sign_context_unavailable',
      },
    }
  }
  // The rebuild is shared with the idempotent replay, which stamps
  // `idempotent_replay: true`; this surface is a read, not a replay.
  const body = { ...(rebuilt.body as Record<string, unknown>) }
  delete body.idempotent_replay
  return { code: 200, body }
}
