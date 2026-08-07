/**
 * POST /x402/:id/settle orchestration (delegation rail, #830). Extracted
 * verbatim from `routes/x402.ts`: the agent has signed the settlement child
 * (EIP-712); assemble the X-PAYMENT header and hand it back — the MERCHANT
 * redeems the [child, budget] chain, Haven submits nothing and holds no key.
 * The intent flips to 'submitted'; final settlement is observed via the
 * merchant/receipt path.
 */
import type { FastifyBaseLogger } from 'fastify'
import { findSettleIntent } from '../../infra/repositories/x402-authorizations.js'
import type { AgentContext } from '../../middleware/agentAuth.js'
import { redactVendorSecrets, deserializeUserOp } from '../../rails/execution-rail.js'
import { recoverDelegationSigner } from '../../rails/delegation-policy.js'
import {
  assembleSettlementPayload,
  encodeXPaymentHeader,
} from './x402-delegation.js'
import { passportReferenceFor } from '../passport/index.js'
import { markIntentSubmittedForSettlement } from '../../infra/repositories/x402-authorizations.js'
import type { X402HandlerResult } from './types.js'

export async function settleX402(
  agent: AgentContext,
  id: string,
  signature: string,
  log?: FastifyBaseLogger,
): Promise<X402HandlerResult> {
  const intent = await findSettleIntent(id, agent.id)
  if (!intent) return { code: 404, body: { error: 'Payment not found' } }
  if (intent.execution_rail !== 'delegation') {
    return { code: 409, body: { error: 'This payment is not a delegation-rail x402 settlement' } }
  }
  if (intent.status !== 'pending_signature') {
    return { code: 409, body: { error: `Payment is ${intent.status}, expected pending_signature` } }
  }
  if (intent.prepared_user_op == null) {
    return { code: 502, body: { error: 'Settlement state was lost — re-authorize' } }
  }

  try {
    const state = deserializeUserOp(intent.prepared_user_op) as {
      child: Parameters<typeof assembleSettlementPayload>[1]
      budget: Parameters<typeof assembleSettlementPayload>[3]
      delegateAccountAddress: `0x${string}`
      network: string
      maxTimeoutSeconds?: number
      facilitatorAddresses?: string[]
    }
    // #946 guard: a 3009-mode funding intent stores a prepared UserOp, not
    // an erc7710 {child, budget} settlement state. Refuse it here
    // structurally — otherwise a tolerant encoder could flip the intent to
    // 'submitted' with a garbage header and no funding ever executed.
    if (!state?.child || !state?.budget) {
      return {
        code: 409,
        body: {
          error:
            'This intent settles via EIP-3009 (funding leg) — sign it via POST ' +
            `/payments/${intent.id}/sign. /settle is for erc7710 direct settlement only.`,
        },
      }
    }
    // #1053 review, finding 3: the shape check above accepts any hex —
    // '0x0' included — and the flip below burns the intent (a retry 409s
    // on the status guard). Unlike payments.ts, the child delegation's
    // typed data IS fully known server-side, so recover the signer and
    // refuse a signature that is not the delegate's BEFORE anything
    // becomes unrecoverable. 400, not 502: the client signed wrong and
    // can re-sign the same sign_data.
    let signer: string
    try {
      signer = await recoverDelegationSigner(state.child, intent.chain_id, signature as `0x${string}`)
    } catch {
      return { code: 400, body: { error: 'The signature is not a valid EIP-712 signature over sign_data.typed_data' } }
    }
    if (signer.toLowerCase() !== agent.delegate_address.toLowerCase()) {
      return {
        code: 400,
        body: { error: 'The signature was not produced by this agent\'s delegate key over sign_data.typed_data' },
      }
    }

    const payload = assembleSettlementPayload(
      intent.chain_id,
      state.child,
      signature as `0x${string}`,
      state.budget,
      state.delegateAccountAddress,
    )
    const header = encodeXPaymentHeader(state.network, payload, {
      amount: intent.amount_raw,
      payTo: intent.to_address as `0x${string}`,
      asset: intent.token_address as `0x${string}`,
      // Pre-#1064 intents stored no echo value; 300 is the same default
      // the child expiry was built with, so the echo stays consistent.
      maxTimeoutSeconds: state.maxTimeoutSeconds ?? 300,
      facilitatorAddresses: state.facilitatorAddresses,
    })

    // #976: the agent's own passport reference, so it can PRESENT rather
    // than have the merchant DISCOVER. Deliberately in Haven's response and
    // NOT inside `payment_header` — that header is parsed by a merchant
    // facilitator we do not control, and an unrecognised key is a rejection
    // risk. Null when there is no anchored passport; a lookup ERROR is
    // swallowed and yields null too.
    //
    // Computed BEFORE the UPDATE, and that ordering is the point (#976
    // review). Between the UPDATE and this reply, `payment_header` is
    // UNRECOVERABLE: it is emitted from this one place, and a retry hits
    // the `status !== 'pending_signature'` guard above and 409s. There is
    // no statement_timeout and no Fastify requestTimeout, so a wedged query
    // in that window would strand a signed, submitted intent with no way to
    // get its header. The reference needs nothing the UPDATE produces, so
    // the window simply should not exist. A lookup error cannot fail the
    // payment either way; a lookup HANG is what the ordering removes.
    const passport = await passportReferenceFor(agent.id, { log })

    await markIntentSubmittedForSettlement(signature, id, agent.id)
    return {
      code: 200,
      body: {
        payment_id: id,
        status: 'submitted',
        // Retry the merchant with this header; it settles directly from your
        // budget delegation (no funding leg).
        payment_header: header,
        resource_url: intent.x402_resource_url,
        passport,
      },
    }
  } catch (err) {
    return {
      code: 502,
      body: {
        error: 'Could not assemble the settlement payload',
        details: redactVendorSecrets(err instanceof Error ? err.message : String(err)),
      },
    }
  }
}
