/**
 * Delegation-rail idempotent-replay resumption (#961), extracted verbatim
 * from `routes/x402.ts`'s authorize handler. Reconstructs the signing payload
 * from stored intent state instead of re-running a sponsored estimation, so a
 * retried authorize call never dead-ends and never double-spends the hourly
 * cap or the bundler budget.
 */
import { expirePendingIntent } from '../../infra/repositories/payment-intents.js'
import { signX402ExpectedContext } from '../../infra/chain/x402-binding-signer.js'
import type { AgentContext } from '../../middleware/agentAuth.js'
import { getExplorerUrl } from '../../lib/chains.js'
import { delegationSigningPayload } from '../../lib/delegation-policy.js'
import { userOpTypedData } from '../../lib/delegation-rail.js'
import { computeHybridAccountAddress } from '../../lib/hybrid-provisioning.js'
import { deserializeUserOp } from '../../lib/execution-rail.js'
import { typedDataDigest } from '../../lib/x402-delegation.js'
import { existingX402IntentMismatch } from './helpers.js'
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
  const replayExpectedAuth = await signX402ExpectedContext({
    paymentId: existing.id as string,
    payloadHash: existing.sign_hash as string,
    resourceUrl: request.url,
    merchantTo: (existing.x402_merchant_address as string | null) ?? request.payTo.toLowerCase(),
    amount: request.amountRaw.toString(),
    asset: request.tokenAddress,
    network: request.network,
    expiresAt: existing.expires_at as string,
    // #1138: a replay re-issues the SAME sign_data, so it must re-issue
    // the same commitment — otherwise a replayed delegation-rail intent
    // would hand back a v1 binding the signer refuses to sign under.
    typedDataHash: typedDataDigest(sign_data.typed_data),
  })
  return {
    code: 201,
    body: {
      payment_id: existing.id,
      status: existing.status,
      expires_at: existing.expires_at,
      chain_id: agent.chain_id,
      safe_address: agent.safe_address,
      payer: agent.safe_address,
      token: request.tokenSymbol,
      amount: existing.amount_human,
      to: existing.to_address,
      merchant_to: existing.x402_merchant_address ?? null,
      resource_url: existing.x402_resource_url ?? request.url,
      x402_expected_auth: replayExpectedAuth,
      idempotent_replay: true,
      sign_data,
    },
  }
}
