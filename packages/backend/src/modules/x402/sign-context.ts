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
  findIntentStatusRow,
  expirePendingIntent,
} from '../../infra/repositories/payment-intents.js'
import { isFundedX402AwaitingMerchantLeg } from '../payments/agent-payment-status.js'
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
  // #2290: the one confirmed state that still has work left to do. #2145
  // taught `haven_get_payment_status` to answer `retry_original_x402_request`
  // for a funded eip3009 intent whose merchant leg was never delivered, then
  // left every route that could rebuild the merchant header shut — the
  // diagnosis shipped without the cure. The permission is read from the SAME
  // predicate that emits the remedy, over the SAME derived row, so the two
  // cannot drift apart into a promise nothing can keep.
  //
  // This widens WHO MAY FETCH a context, never what the signer will sign
  // without one: `assertExpectedBinding` and the digest re-derivation are
  // untouched. It cannot re-fund — the funding UserOp is spent and Haven
  // refuses a second submit — and it writes nothing.
  //
  // Scoped to `confirmed` so the ordinary pending_signature fetch keeps its
  // single read: the predicate cannot hold for any other status.
  const fundedMerchantRetry =
    existing.status === 'confirmed' && (await isFundedMerchantRetry(paymentId, agent))
  if (fundedMerchantRetry) {
    const rebuilt = await rebuildDelegationSignContext(existing, agent, {
      fundedMerchantRetry: true,
    })
    // A null rebuild is the legacy-rail row with no stored signing payload;
    // it falls through to that refusal below rather than growing a second
    // wording for the same condition.
    if (rebuilt) return signContextResponse(rebuilt, existing)
  }
  if (existing.status === 'confirmed' && existing.tx_hash && !fundedMerchantRetry) {
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
  const rebuilt = fundedMerchantRetry ? null : await rebuildDelegationSignContext(existing, agent)
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
  return signContextResponse(rebuilt, existing)
}

/**
 * #2290: true when this confirmed intent is the funded-but-undelivered
 * eip3009 state. Reads the DERIVED row — `merchant_leg_reported` and
 * `funded_but_unsettled` are joins over evidence and reconciliation events,
 * not columns on `payment_intents` — so this is the identical input
 * `haven_get_payment_status` judges, run through the identical predicate.
 */
async function isFundedMerchantRetry(paymentId: string, agent: AgentContext): Promise<boolean> {
  const statusRow = await findIntentStatusRow(paymentId, agent.id)
  return statusRow !== null && isFundedX402AwaitingMerchantLeg(statusRow)
}

function signContextResponse(
  rebuilt: X402HandlerResult,
  existing: Record<string, unknown>,
): X402HandlerResult {
  // The rebuild is shared with the idempotent replay, which stamps
  // `idempotent_replay: true`; this surface is a read, not a replay.
  const body = { ...(rebuilt.body as Record<string, unknown>) }
  delete body.idempotent_replay
  // #1355: re-serve the 402 PaymentRequired persisted at authorize time, so a
  // signer fetching by payment_id can build the merchant header without the
  // agent relaying the blob. Absent on pre-#1355 rows (the signer then
  // requires the caller-supplied copy). Not authority: whichever copy the
  // signer uses is verified against the Haven-signed expected context.
  //
  // #2290: this is also what carries the merchant's `accepts[].extra` (the
  // USDC EIP-712 domain `{name, version}`) into a funded retry. The stored
  // blob is re-served verbatim, so the domain the signer builds against is
  // the merchant's own — never a library default guessed from the network.
  const storedPaymentRequired = storedPaymentRequiredFromMetadata(existing.machine_metadata)
  if (storedPaymentRequired) body.payment_required = storedPaymentRequired
  return { code: 200, body }
}

function storedPaymentRequiredFromMetadata(metadata: unknown): Record<string, unknown> | null {
  let parsed: unknown = metadata
  if (typeof metadata === 'string') {
    try {
      parsed = JSON.parse(metadata)
    } catch {
      return null
    }
  }
  if (!parsed || typeof parsed !== 'object') return null
  const stored = (parsed as Record<string, unknown>).payment_required
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return null
  return stored as Record<string, unknown>
}
