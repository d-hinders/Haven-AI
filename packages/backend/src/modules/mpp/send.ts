/**
 * `POST /send` orchestration (#997, epic #980 M4) — the plain-transfer flow
 * (asset/recipient naming convention, distinct from the challenge-based mpp
 * rails). Extracted verbatim from `routes/machine-payments.ts`: the #993
 * retired-rail gate, the #961-adjacent idempotency handling (replay lookup
 * BEFORE the on-chain read, and the unique-violation race replay after a
 * lost insert), and the within-allowance / over-allowance coverage split.
 * `routes/machine-payments.ts` keeps only request-shape validation.
 */
import { mppNotOnDelegationRail, resolveExecutionRail, sessionRailRetired } from '../../rails/execution-rail.js'
import {
  findSendIntentByIdempotencyKey,
  insertSendIntent,
} from '../../infra/repositories/payment-intents.js'
import {
  findSendApprovalByIdempotencyKey,
  insertSendApproval,
} from '../../infra/repositories/approval-requests.js'
import { hasTokenAllowanceConfigured } from '../../infra/repositories/agents.js'
import type { AgentContext } from '../../middleware/agentAuth.js'
import { getAgentPaymentStatus, agentPaymentStatusHttpCode } from '../payments/index.js'
import { formatTokenAmount, parseTokenAmount } from '@haven_ai/core'
import {
  getTokenAllowance,
  getLatestBlockTimeSec,
  computeEffectiveAllowance,
  generateTransferHash,
} from '../../rails/allowance-module.js'
import {
  readSharedWatermark,
  waitForFreshAllowanceNonce,
} from '../../rails/allowance-nonce-coordinator.js'
import { getChain } from '../../domain/chains.js'
import { AgentPaymentPhase, AgentPaymentNextAction } from '../../domain/agent-payment-taxonomy.js'
import { ZERO_ADDRESS } from '../../domain/payment-token.js'
import type { MppHandlerResult, SendAsset, SendBody } from './types.js'

const PG_UNIQUE_VIOLATION = '23505'

const SEND_SIGN_INSTRUCTIONS =
  'Sign the hash with your delegate private key using raw ECDSA (not eth_sign). ' +
  'The signature must be 65 bytes: r (32) + s (32) + v (1), where v is 27 or 28.'

/**
 * Resolve a SendAsset enum value to the token config for a given chain.
 * 'ETH' resolves to the chain's native token; 'USDC' resolves by symbol match.
 */
function resolveAsset(chainId: number, asset: SendAsset) {
  const chain = getChain(chainId)
  const tokens = chain.tokens
  // Native ETH/xDAI = any token with address null
  if (asset === 'ETH') {
    return Object.values(tokens).find((t) => t.address === null) ?? null
  }
  // USDC = find by uppercase symbol prefix
  for (const cfg of Object.values(tokens)) {
    if (cfg.symbol.toUpperCase().startsWith('USDC')) return cfg
  }
  return null
}

/**
 * Build the AllowanceModule `sign_data` payload returned by /send.
 *
 * Shared by the create path and the idempotent-replay path so a retried request
 * can never receive a structurally different hash/components than its original
 * 201 — the retry path is exactly what idempotency exists to protect.
 */
function buildSendSignData(
  hash: string,
  components: { safe: string; token: string; to: string; amount: string; nonce: number },
) {
  return {
    hash,
    components: {
      safe: components.safe,
      token: components.token,
      to: components.to,
      amount: components.amount,
      payment_token: ZERO_ADDRESS,
      payment: '0',
      nonce: components.nonce,
    },
    instructions: SEND_SIGN_INSTRUCTIONS,
  }
}

interface SendReplay {
  code: number
  body: Record<string, unknown>
}

/**
 * Build the canonical status response for an already-progressed payment, so a
 * replay of a settled/approved/submitted send reports its *real* state rather
 * than re-emitting the create-time "sign this" / "waiting for approval" framing.
 * Mirrors what GET status / haven_get_payment_status returns for the same id.
 */
async function replayStatusOf(agent: AgentContext, paymentId: string): Promise<SendReplay> {
  const status = await getAgentPaymentStatus(agent, paymentId)
  if (status) {
    return { code: agentPaymentStatusHttpCode(status), body: { ...status, idempotent_replay: true } }
  }
  return {
    code: 409,
    body: { payment_id: paymentId, error: 'Payment already exists but could not be loaded', idempotent_replay: true },
  }
}

/**
 * Resolve an existing /send result for an idempotency key, if one exists.
 *
 * A send lands as either a signable payment intent (within allowance) or a
 * queued approval (over allowance), so both tables are checked. A replay returns
 * the original *signable* response only while the row is still actionable
 * (intent pending_signature / approval pending); once it has progressed it
 * returns the row's real status instead, so an agent that retries after the
 * payment already settled is not told to sign or wait again. Returns null when
 * the key has never been seen (or its prior row reached a terminal state
 * excluded by the unique index and is therefore reusable).
 */
async function findExistingSend(
  agent: AgentContext,
  idempotencyKey: string,
  asset: SendAsset,
): Promise<SendReplay | null> {
  const pi = await findSendIntentByIdempotencyKey(agent.id, idempotencyKey)
  if (pi) {
    // Already submitted/confirmed — report the real state, not a stale sign request.
    if (pi.status !== 'pending_signature') {
      return replayStatusOf(agent, pi.id)
    }
    return {
      code: 201,
      body: {
        payment_id: pi.id,
        status: pi.status,
        expires_at: pi.expires_at,
        asset,
        amount: pi.amount_human,
        recipient: pi.to_address,
        idempotent_replay: true,
        sign_data: buildSendSignData(pi.sign_hash, {
          safe: agent.safe_address,
          token: pi.token_address,
          to: pi.to_address,
          amount: pi.amount_raw,
          nonce: pi.allowance_nonce,
        }),
      },
    }
  }

  const ar = await findSendApprovalByIdempotencyKey(agent.id, idempotencyKey)
  if (ar) {
    // Owner has approved / executed it — report the real state, not "still waiting".
    if (ar.status !== 'pending') {
      return replayStatusOf(agent, ar.id)
    }
    return {
      code: 202,
      body: {
        payment_id: ar.id,
        kind: 'approval_request',
        status: 'pending_approval',
        phase: AgentPaymentPhase.UserApprovalRequired,
        next_action: AgentPaymentNextAction.WaitForUserApproval,
        message: `Transfer of ${ar.amount_human} ${ar.token_symbol} is queued for owner approval.`,
        requested: ar.amount_human,
        asset,
        expires_at: ar.expires_at,
        idempotent_replay: true,
      },
    }
  }

  return null
}

/**
 * `POST /send` orchestration. `routes/machine-payments.ts` validates request
 * shape (asset enum, recipient address, amount, idempotency_key length) and
 * hands the parsed fields here.
 */
export async function handleSend(
  agent: AgentContext,
  asset: SendAsset,
  recipient: string,
  amount: string,
  idempotencyKey: string | undefined,
): Promise<MppHandlerResult> {
  // #993 (review finding on #1120): the retired-rail refusal must hold on
  // EVERY money entry point — /send previously never consulted the seam.
  const sendRail = resolveExecutionRail({
    safeExecutionRail: agent.execution_rail ?? null,
    chainId: agent.chain_id,
  })
  if (sendRail.rail === 'retired_session') {
    const retired = sessionRailRetired('account')
    return { statusCode: retired.statusCode, body: retired.body }
  }
  if (agent.execution_rail === 'delegation') {
    // #1251: same refusal as authorize — see the note there. Raw-state check,
    // like payments.ts. Delegation accounts send via POST /payments (direct
    // delegation redemption).
    const refusal = mppNotOnDelegationRail()
    return { statusCode: refusal.statusCode, body: refusal.body }
  }

  // 2. Resolve asset to token config
  const tokenConfig = resolveAsset(agent.chain_id, asset)
  if (!tokenConfig) {
    return { statusCode: 400, body: { error: `Unsupported asset ${asset} on chain ${agent.chain_id}` } }
  }

  const tokenAddress = tokenConfig.address ?? ZERO_ADDRESS

  // 3. Convert human amount to raw units
  let amountRaw: bigint
  try {
    amountRaw = parseTokenAmount(amount, tokenConfig.decimals)
  } catch {
    return { statusCode: 400, body: { error: `Invalid amount for ${tokenConfig.symbol}` } }
  }

  if (amountRaw <= 0n) {
    return { statusCode: 400, body: { error: 'amount must be greater than zero' } }
  }

  // Idempotency replay: a retried send returns the original intent/approval
  // rather than minting a second one. Checked before the on-chain read so a
  // replay skips the RPC round trip entirely (see migration 020).
  if (idempotencyKey) {
    const replay = await findExistingSend(agent, idempotencyKey, asset)
    if (replay) return { statusCode: replay.code, body: replay.body }
  }

  // 4. Policy check: agent must have this token configured
  const allowanceConfigured = await hasTokenAllowanceConfigured(agent.id, tokenAddress)
  if (!allowanceConfigured) {
    return {
      statusCode: 403,
      body: { error: `Agent is not configured for ${tokenConfig.symbol} transfers` },
    }
  }

  // 5. On-chain allowance check. Read the allowance and chain time together:
  // the reset decision must key off chain `block.timestamp`, not wall-clock.
  let onChainAllowance
  let chainTimeSec: number
  let sharedWatermark: number | null
  try {
    ;[onChainAllowance, chainTimeSec, sharedWatermark] = await Promise.all([
      getTokenAllowance(
        agent.chain_id,
        agent.safe_address,
        agent.delegate_address,
        tokenAddress,
      ),
      getLatestBlockTimeSec(agent.chain_id),
      // Rides along with the chain reads (#1196) — a single indexed lookup
      // against reads orders of magnitude slower, so it costs nothing here and
      // would be a serial round trip anywhere else.
      readSharedWatermark(
        agent.chain_id,
        agent.safe_address,
        agent.delegate_address,
        tokenAddress,
      ),
    ])
  } catch (err) {
    return {
      statusCode: 502,
      body: {
        error: 'Failed to read on-chain allowance',
        details: err instanceof Error ? err.message : String(err),
      },
    }
  }

  const effective = computeEffectiveAllowance(onChainAllowance, chainTimeSec)

  // 5a. Queue for approval when amount exceeds remaining on-chain allowance
  if (amountRaw > effective.remaining) {
    const remainingHuman = formatTokenAmount(effective.remaining, tokenConfig.decimals)
    const approvalReason =
      `Exceeds remaining allowance (${amount} ${tokenConfig.symbol} requested, ${remainingHuman} available)`

    let approval
    try {
      approval = await insertSendApproval({
        agentId: agent.id,
        userId: agent.user_id,
        safeAddress: agent.safe_address,
        chainId: agent.chain_id,
        tokenSymbol: tokenConfig.symbol,
        tokenAddress,
        toAddress: recipient.toLowerCase(),
        amountRaw: amountRaw.toString(),
        amountHuman: amount,
        reason: approvalReason,
        sendIdempotencyKey: idempotencyKey ?? null,
      })
    } catch (err) {
      // Lost an idempotency-key race with a concurrent send — replay the winner.
      if (idempotencyKey && (err as { code?: string }).code === PG_UNIQUE_VIOLATION) {
        const replay = await findExistingSend(agent, idempotencyKey, asset)
        if (replay) return { statusCode: replay.code, body: replay.body }
      }
      throw err
    }
    return {
      statusCode: 202,
      body: {
        payment_id: approval.id,
        kind: 'approval_request',
        status: 'pending_approval',
        phase: AgentPaymentPhase.UserApprovalRequired,
        next_action: AgentPaymentNextAction.WaitForUserApproval,
        message: `Transfer of ${amount} ${tokenConfig.symbol} exceeds the remaining on-chain allowance. Queued for owner approval.`,
        remaining: remainingHuman,
        requested: amount,
        asset,
        expires_at: approval.expires_at,
      },
    }
  }

  // #1196: this path builds a sign_hash from the allowance nonce too, so it
  // needs the same stale-nonce protection x402 has had since #692 — the #693
  // preflight kept it SAFE without it, but a stale nonce still meant a revert
  // and a retry. Runs AFTER the queue branch (#1209): the approval path signs
  // nothing, so the bounded wait only runs when a hash will actually be built.
  onChainAllowance.nonce = await waitForFreshAllowanceNonce(
    agent.chain_id,
    agent.safe_address,
    agent.delegate_address,
    tokenAddress,
    onChainAllowance.nonce,
    async () =>
      (
        await getTokenAllowance(
          agent.chain_id,
          agent.safe_address,
          agent.delegate_address,
          tokenAddress,
        )
      ).nonce,
    { sharedWatermark },
  )

  // 6. Generate the AllowanceModule transfer hash
  let signHash: string
  try {
    signHash = await generateTransferHash(
      agent.chain_id,
      agent.safe_address,
      tokenAddress,
      recipient,
      amountRaw,
      ZERO_ADDRESS,
      0n,
      onChainAllowance.nonce,
    )
  } catch (err) {
    return {
      statusCode: 502,
      body: {
        error: 'Failed to generate transfer hash',
        details: err instanceof Error ? err.message : String(err),
      },
    }
  }

  // 7. Store the payment intent
  let intent
  try {
    intent = await insertSendIntent({
      agentId: agent.id,
      userId: agent.user_id,
      safeAddress: agent.safe_address,
      chainId: agent.chain_id,
      tokenSymbol: tokenConfig.symbol,
      tokenAddress,
      toAddress: recipient.toLowerCase(),
      amountRaw: amountRaw.toString(),
      amountHuman: amount,
      delegateAddress: agent.delegate_address,
      allowanceNonce: onChainAllowance.nonce,
      signHash,
      sendIdempotencyKey: idempotencyKey ?? null,
    })
  } catch (err) {
    // Lost an idempotency-key race with a concurrent send — replay the winner.
    if (idempotencyKey && (err as { code?: string }).code === PG_UNIQUE_VIOLATION) {
      const replay = await findExistingSend(agent, idempotencyKey, asset)
      if (replay) return { statusCode: replay.code, body: replay.body }
    }
    throw err
  }

  return {
    statusCode: 201,
    body: {
      payment_id: intent.id,
      status: intent.status,
      expires_at: intent.expires_at,
      asset,
      amount,
      recipient: recipient.toLowerCase(),
      sign_data: buildSendSignData(signHash, {
        safe: agent.safe_address,
        token: tokenAddress,
        to: recipient.toLowerCase(),
        amount: amountRaw.toString(),
        nonce: onChainAllowance.nonce,
      }),
    },
  }
}
