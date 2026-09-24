/**
 * GET /payments/:id/sign-context — the byte-free signing handoff for a DIRECT
 * delegation-rail payment (#3271).
 *
 * #1263 built this handoff for x402 (`GET /x402/:id/sign-context`) so a local
 * signer could fetch exact bytes by `payment_id` instead of an agent
 * relaying a multi-KB EIP-712 payload by hand. `POST /payments` never had a
 * sibling: the old signer refused every non-x402 `payment_id`
 * (`sign_context_unavailable`, still served with the same code and the same
 * typed_data_b64 instruction by `modules/x402/sign-context.ts` for old
 * signers), which forced the hand
 * relay this issue traces to a live `AA24 signature error` — one corrupted
 * character in the relayed blob produced a valid-looking signature over the
 * wrong digest.
 *
 * Deliberately NOT `rebuildDelegationSignContext` (`x402/replay.ts`): that
 * helper mints an x402 EXPECTED CONTEXT keyed on `resource_url`, which is
 * null for a direct intent. `buildDirectSignData` below is the direct
 * sibling — it reuses exactly the reconstruction `replayIntentBody`
 * (`routes/payments.ts`) already performs for a POST /payments idempotent
 * replay, so both surfaces serve identical bytes for the same row by
 * construction rather than by two hand-kept-in-sync copies.
 *
 * Trust model unchanged: this constructs nothing new. It re-derives the
 * EXACT signing payload for the stored `prepared_user_op` — same UserOp, same
 * nonce, same gas — and the account's own on-chain validation is what
 * authorizes execution, not this response.
 */
import type { AgentContext } from '../../middleware/agentAuth.js'
import {
  findIntentForAgent,
  expirePendingIntent,
  type PaymentIntentRow,
} from '../../infra/repositories/payment-intents.js'
import {
  deserializeUserOp,
  isRetiredRailIntent,
  isRetiredAllowanceIntent,
  sessionRailRetired,
  allowanceModuleRailRetired,
} from '../../rails/execution-rail.js'
import { userOpTypedData } from '../../rails/delegation-rail.js'
import { computeHybridAccountAddress } from '../../rails/hybrid-provisioning.js'
// #3271 acceptance criterion 1: `direct_sign_context_version` is
// `DIRECT_SIGN_CONTEXT_VERSION`, the SDK constant every client's
// `assertUserOpTypedDataBinding` is pinned against
// (`packages/sdk/src/userop-binding.ts`). Backend already imports
// `@haven_ai/sdk` cleanly elsewhere in `modules/**`
// (e.g. `modules/payments/receipt.ts`), so this is a normal workspace import,
// not a literal needing a comment-pinned test.
import { DIRECT_SIGN_CONTEXT_VERSION } from '@haven_ai/sdk'

export interface DirectSignContextResult {
  code: number
  body: Record<string, unknown>
}

/**
 * The `sign_data` block for a direct delegation-rail intent, rebuilt from the
 * stored `prepared_user_op` — the #961 discipline (never a fresh estimation,
 * which would carry a different nonce/gas than what the intent pinned).
 *
 * Shared by `replayIntentBody`'s idempotent-replay branch (`routes/
 * payments.ts`) and `getDirectSignContext` below so the two surfaces cannot
 * drift into serving different bytes for the same row.
 */
export async function buildDirectSignData(
  pi: Pick<PaymentIntentRow, 'prepared_user_op' | 'sign_hash' | 'chain_id'>,
  agent: Pick<AgentContext, 'delegate_address'>,
): Promise<{
  hash: string
  signature_scheme: 'eip712_userop'
  typed_data: unknown
  /** The delegator account the UserOperation runs on — callers building the
   *  wider `replayIntentBody`/`SignablePaymentIntent` `components` shape need
   *  it too; the sign-context response itself does not surface it. */
  accountAddress: `0x${string}`
}> {
  const state = deserializeUserOp(pi.prepared_user_op) as Record<string, unknown>
  const accountAddress = await computeHybridAccountAddress(pi.chain_id, {
    ownerAddress: agent.delegate_address as `0x${string}`,
  })
  return {
    hash: pi.sign_hash,
    signature_scheme: 'eip712_userop',
    typed_data: userOpTypedData(state, accountAddress as `0x${string}`, pi.chain_id),
    accountAddress: accountAddress as `0x${string}`,
  }
}

/**
 * `GET /payments/:id/sign-context`. Read-only: writes nothing except the same
 * lazy-expire `GET /x402/:id/sign-context` performs on a stale pending row.
 */
export async function getDirectSignContext(
  agent: AgentContext,
  paymentId: string,
): Promise<DirectSignContextResult> {
  const existing = await findIntentForAgent(paymentId, agent.id)
  // Not found and not-yours are the same answer on purpose — same #1263
  // discipline as the x402 sibling: an id enumerator learns nothing about
  // other agents' intents.
  if (!existing) {
    return { code: 404, body: { error: 'Payment intent not found' } }
  }
  if (existing.x402_resource_url || existing.payment_resource_url) {
    return {
      code: 409,
      body: {
        error:
          'This is an x402/machine payment intent — the direct sign-context serves a plain ' +
          'POST /payments intent only. Fetch GET /x402/:id/sign-context instead.',
        error_code: 'sign_context_unavailable',
      },
    }
  }
  // Retired-rail rows, whatever their status: the same 410 tombstone
  // `POST /payments/:id/sign` answers, checked BEFORE any status/expiry
  // branch (#993's "before the expiry flip" discipline) since a retired row
  // must never see this new route as an alternate path back to signability.
  if (isRetiredRailIntent(existing.execution_rail)) {
    const retired = sessionRailRetired('intent')
    return { code: retired.statusCode, body: retired.body }
  }
  if (isRetiredAllowanceIntent(existing.execution_rail)) {
    const retired = allowanceModuleRailRetired('intent')
    return { code: retired.statusCode, body: retired.body }
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
  if (new Date(existing.expires_at) < new Date()) {
    // Same lazy-expire discipline as the #961 replay / the x402 sibling: a
    // stale pending row holds the idempotency key until something flips its
    // status.
    await expirePendingIntent(existing.id, agent.id)
    return {
      code: 410,
      body: {
        payment_id: existing.id,
        status: 'expired',
        error: 'Payment window expired — re-run POST /payments with the same idempotency key',
        error_code: 'expired',
      },
    }
  }
  // The reachable fallback: `execution_rail === 'delegation'` is implied by
  // the two retired-rail checks above covering every other value, but a row
  // missing `prepared_user_op` (never observed on a live delegation-rail
  // intent, mirrored here defensively the same way the x402 sibling guards
  // its own legacy-rail rows) has no stored signing payload to serve.
  if (existing.execution_rail !== 'delegation' || existing.prepared_user_op == null) {
    return {
      code: 409,
      body: {
        payment_id: existing.id,
        error: 'No stored signing payload for this intent',
        error_code: 'sign_context_unavailable',
      },
    }
  }
  const { hash, signature_scheme, typed_data } = await buildDirectSignData(existing, agent)
  return {
    code: 200,
    body: {
      payment_id: existing.id,
      status: existing.status,
      expires_at: existing.expires_at,
      direct_sign_context_version: DIRECT_SIGN_CONTEXT_VERSION,
      sign_data: { hash, signature_scheme, typed_data },
    },
  }
}
