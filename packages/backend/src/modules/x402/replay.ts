/**
 * Delegation-rail idempotent-replay resumption (#961), extracted verbatim
 * from `routes/x402.ts`'s authorize handler. Reconstructs the signing payload
 * from stored intent state instead of re-running a sponsored estimation, so a
 * retried authorize call never dead-ends and never double-spends the hourly
 * cap or the bundler budget.
 */
import { expirePendingIntent } from '../../infra/repositories/payment-intents.js'
import { signX402ExpectedContext, x402PayerContextFields, x402PayerWireFields } from '../../infra/chain/x402-binding-signer.js'
import type { AgentContext } from '../../middleware/agentAuth.js'
import { getExplorerUrl } from '../../domain/chains.js'
import { delegationSigningPayload } from '../../rails/delegation-policy.js'
import { userOpTypedData } from '../../rails/delegation-rail.js'
import { computeHybridAccountAddress } from '../../rails/hybrid-provisioning.js'
import { deserializeUserOp } from '../../rails/execution-rail.js'
import { typedDataDigest } from './x402-delegation.js'
import { existingX402IntentMismatch, x402MetadataNetwork } from './helpers.js'
import type { X402HandlerResult } from './types.js'

/**
 * Idempotent replay must RESUME, never dead-end: reconstruct the signing
 * payload from stored state instead of re-running an estimation. The unique
 * index excludes rows whose STATUS is failed/expired — a past-expires_at row
 * still holds the key until something flips its status, so the replay path
 * lazily expires it (below) to free the key for a fresh create.
 *
 * Returns `null` when the caller should fall through and create a fresh
 * intent (no matching row, lazily-expired row, or unresolvable state).
 */
export async function delegationReplay(
  existing: Record<string, unknown>,
  agent: AgentContext,
  request: {
    url: string
    payTo: string
    merchantPayTo?: string
    amountRaw: bigint
    tokenAddress: string
    tokenSymbol: string
    network: string
    facilitatorAddresses?: string[]
  },
): Promise<X402HandlerResult | null> {
  if (existing.status === 'confirmed' && existing.tx_hash) {
    return {
      code: 200,
      body: {
        success: true,
        payment_id: existing.id,
        status: existing.status,
        tx_hash: existing.tx_hash,
        chain_id: existing.chain_id ?? agent.chain_id,
        safe_address: existing.safe_address,
        payer: existing.safe_address,
        token: existing.token_symbol,
        amount: existing.amount_human,
        to: existing.to_address,
        merchant_to: existing.x402_merchant_address,
        resource_url: existing.x402_resource_url,
        explorer_url: getExplorerUrl(
          (existing.chain_id as number) ?? agent.chain_id, 'tx', existing.tx_hash as string,
        ),
      },
    }
  }
  if (existing.status !== 'pending_signature') return null
  if (new Date(existing.expires_at as string) < new Date()) {
    // Lazy-expire: nothing else on the authorize path flips a stale
    // pending row, and until its status changes the partial unique
    // index still holds the idempotency key — every retry would loop
    // on a bare 409 (found by review, #961 M2).
    await expirePendingIntent(existing.id as string, agent.id)
    return null
  }
  const mismatch = existingX402IntentMismatch(existing, {
    resourceUrl: request.url,
    fundingTo: request.payTo,
    merchantTo: request.merchantPayTo?.toLowerCase() ?? request.payTo.toLowerCase(),
    amountRaw: request.amountRaw.toString(),
    tokenAddress: request.tokenAddress,
    network: request.network,
    facilitatorAddresses: request.facilitatorAddresses,
  })
  if (mismatch) {
    return {
      code: 409,
      body: {
        payment_id: existing.id,
        status: existing.status,
        error: `idempotencyKey already belongs to a different x402 ${mismatch}`,
      },
    }
  }
  if (existing.prepared_user_op == null) return null
  return rebuildDelegationSignContext(existing, agent)
}

/**
 * Rebuild the EXACT signing payload + a freshly Haven-signed expected context
 * for a stored delegation-rail x402 intent, purely from the row (#1263).
 *
 * Shared by two consumers with different framing:
 * - the #961 idempotent replay (after its status/mismatch checks), and
 * - `GET /x402/:id/sign-context`, the byte-free handoff for local signers —
 *   an agent passes only `payment_id` and the signer fetches these bytes
 *   itself instead of asking a language model to re-emit them verbatim
 *   (the #1255/#1263 failure mode).
 *
 * Every input is the STORED row; there is no request to disagree with. The
 * commitment is re-derived from the reconstructed typed data, exactly like
 * the replay always did, so the signer's digest re-derivation (#1138) keeps
 * working unchanged against this surface.
 */
export async function rebuildDelegationSignContext(
  existing: Record<string, unknown>,
  agent: AgentContext,
): Promise<X402HandlerResult | null> {
  if (existing.prepared_user_op == null) return null
  const url = (existing.x402_resource_url ?? existing.payment_resource_url) as string
  const amountRaw = String(existing.amount_raw)
  const tokenAddress = existing.token_address as string
  const tokenSymbol = existing.token_symbol as string
  const network = x402MetadataNetwork(existing.machine_metadata) ?? `eip155:${(existing.chain_id as number) ?? agent.chain_id}`
  const fundingTo = (existing.to_address as string).toLowerCase()
  const state = deserializeUserOp(existing.prepared_user_op) as Record<string, unknown>
  // The stored intent's chain is authoritative for the reconstructed
  // typed data — agent.chain_id happens to equal it today (the network
  // check pins it), but the sign_hash was computed against the intent.
  const intentChainId = (existing.chain_id as number) ?? agent.chain_id
  const accountAddress = await computeHybridAccountAddress(intentChainId, {
    ownerAddress: agent.delegate_address as `0x${string}`,
  })
  const isErc7710State = Boolean(state?.child && state?.budget)
  const sign_data = isErc7710State
    ? {
        hash: existing.sign_hash,
        signature_scheme: 'eip712_delegation',
        typed_data: delegationSigningPayload(
          state.child as never, intentChainId,
        ),
        instructions:
          'Sign sign_data.typed_data with your delegate (agent) key (EIP-712). Then POST ' +
          `/x402/${existing.id}/settle with { signature } to receive the X-PAYMENT header.`,
      }
    : {
        hash: existing.sign_hash,
        signature_scheme: 'eip712_userop',
        typed_data: userOpTypedData(state, accountAddress as `0x${string}`, intentChainId),
        components: {
          safe: agent.safe_address,
          account: accountAddress,
          token: existing.token_address,
          to: existing.to_address,
          amount: existing.amount_raw,
        },
        instructions:
          'Sign sign_data.typed_data with your delegate (agent) key (EIP-712). Then POST ' +
          `/payments/${existing.id}/sign with { signature } — the funding redemption moves ` +
          'the exact amount to your delegate EOA; retry the merchant with your EIP-3009 header.',
      }
  const merchantTo = (existing.x402_merchant_address as string | null) ?? fundingTo
  // #1138: a replay re-issues the SAME sign_data, so it must re-issue
  // the same commitment — otherwise a replayed delegation-rail intent
  // would hand back a v1 binding the signer refuses to sign under.
  const typedDataHash = typedDataDigest(sign_data.typed_data)
  const replayExpectedAuth = await signX402ExpectedContext({
    paymentId: existing.id as string,
    payloadHash: existing.sign_hash as string,
    resourceUrl: url,
    merchantTo,
    amount: amountRaw,
    asset: tokenAddress,
    network,
    expiresAt: existing.expires_at as string,
    typedDataHash,
    // #1690: gated payer identity — {} until X402_EMIT_PAYER_CONTEXT=1.
    ...x402PayerContextFields(agent),
  })
  // #1263: the COMPLETE expected context, field-for-field as signed above, in
  // the snake_case shape the edge signer's tool schema validates. The signer
  // fetching by payment_id passes this straight through — reconstructing it
  // from the human-facing response fields (e.g. amount_human vs atomic) is
  // exactly the kind of re-derivation that breaks binding verification.
  const x402Expected = {
    payment_id: existing.id,
    payload_hash: existing.sign_hash,
    resource_url: url,
    merchant_to: merchantTo,
    amount: amountRaw,
    asset: tokenAddress,
    network,
    expires_at: existing.expires_at,
    ...(typedDataHash ? { typed_data_hash: typedDataHash } : {}),
    // #1690: mirror the signed context exactly — when the payer fields were
    // bound above, the wire must carry them or no signer can rebuild the
    // message. Same gate, same helper, so the two cannot diverge.
    ...x402PayerWireFields(agent),
    auth: replayExpectedAuth,
  }
  return {
    code: 201,
    body: {
      payment_id: existing.id,
      status: existing.status,
      expires_at: existing.expires_at,
      chain_id: agent.chain_id,
      safe_address: agent.safe_address,
      payer: agent.safe_address,
      token: tokenSymbol,
      amount: existing.amount_human,
      to: existing.to_address,
      merchant_to: existing.x402_merchant_address ?? null,
      resource_url: url,
      x402_expected_auth: replayExpectedAuth,
      x402_expected: x402Expected,
      idempotent_replay: true,
      sign_data,
    },
  }
}
