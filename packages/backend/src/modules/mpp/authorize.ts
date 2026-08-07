/**
 * `authorizeMachinePayment` orchestration (#997, epic #980 M4). Extracted
 * verbatim from `lib/machine-payments.ts`: idempotent replay of
 * pending/confirmed intents and approvals, the #993 retired-session gate, the
 * allowance-only coverage decision, the approval-queue path, and one-shot
 * authorize+execute. Behavior and ordering are unchanged from the pre-#997
 * lib file — this is the single entry point `routes/machine-payments.ts`'s
 * `POST /authorize` calls after `challenge.ts` accepts the challenge.
 *
 * Token resolution (`resolvePaymentToken`) lives in `src/domain/payment-token.ts`
 * because `modules/x402/` needs it too — folding it in here instead would
 * force x402 to deep-import a private mpp file. The rail-agnostic
 * `payment_intents`/`approval_requests` writers are `infra/repositories/`
 * functions called directly (no `createPaymentIntent`/`createMachineApproval`
 * wrapper — those were pure pass-throughs; x402's legacy rail calls the same
 * repository functions directly too, for the same reason).
 */
import { RelayerBudgetExceededError } from '../../lib/relayer-spend-guard.js'
import { ethers } from 'ethers'
import {
  confirmMachineIntent,
  failMachineIntent,
  findMachineIntentByKeyOrChallenge,
  getIntentStatus,
  insertMachineIntent,
  recordMachineIntentSignature,
  refreshMachineIntentNonce,
  type PaymentIntentRow,
} from '../../infra/repositories/payment-intents.js'
import {
  findMachineApprovalByKeyOrChallenge,
  insertMachineApproval,
  type MachineApprovalRow as ApprovalRequestRow,
} from '../../infra/repositories/approval-requests.js'
import { getX402HourlyUsage } from '../../infra/repositories/x402-authorizations.js'
import { hasTokenAllowanceConfigured } from '../../infra/repositories/agents.js'
import { type AgentContext } from '../../middleware/agentAuth.js'
import { AgentPaymentNextAction, AgentPaymentPhase } from '../../lib/agent-payment-taxonomy.js'
import {
  agentPaymentStatusHttpCode,
  getAgentPaymentStatus,
} from '../../lib/agent-payment-status.js'
import { getExplorerUrl } from '../../lib/chains.js'
import { getFiatValuesForTokenAmount } from '../../lib/fiat-values.js'
import { formatTokenValue } from '../../lib/tokens.js'
import {
  getTokenAllowance,
  getLatestBlockTimeSec,
  computeEffectiveAllowance,
  generateTransferHash,
  recoverSigner,
  executeAllowanceTransfer,
} from '../../lib/allowance-module.js'
import { tryRecordMachinePaymentEvidenceBaseById } from './evidence.js'
import { decideCoverage } from '../../lib/payment-coverage.js'
import { isAddress } from '@haven_ai/core'
import {
  isRetiredRailIntent,
  loadExecutionRailState,
  resolveExecutionRail,
  sessionRailRetired,
} from '../../lib/execution-rail.js'
import { resolvePaymentToken, ZERO_ADDRESS } from '../../domain/payment-token.js'
import {
  isMppRail,
  machineRailFields,
  approvalReasonFor,
  metadataObject,
  nullableString,
  type MachineRailContext,
} from './rail-dispatch.js'
import type { MachinePaymentRail } from './types.js'

export function normaliseAddress(addr: string): string {
  return ethers.getAddress(addr.toLowerCase())
}

export interface AuthorizeMachinePaymentInput {
  agent: AgentContext
  rail: MachinePaymentRail
  resourceUrl: string
  payTo: string
  amountAtomic: string
  asset: string
  chainId: number
  description?: string
  category?: string
  merchantPayTo?: string | null
  idempotencyKey?: string | null
  challengeId?: string | null
  metadata?: Record<string, unknown>
  signature?: string
  enforceX402RateLimit?: boolean
}

function paymentResourceUrl(intent: PaymentIntentRow): string | null {
  return intent.payment_resource_url ?? intent.x402_resource_url
}

function merchantAddress(intent: PaymentIntentRow): string | null {
  return intent.merchant_address ?? intent.x402_merchant_address
}

export function machinePaymentResponse(
  intent: PaymentIntentRow,
  agent: Pick<AgentContext, 'chain_id'>,
  txHash?: string,
) {
  const resolvedTxHash = txHash ?? intent.tx_hash
  const rail = intent.payment_rail ?? intent.source
  const metadata = metadataObject(intent.machine_metadata)
  const resourceUrl = paymentResourceUrl(intent)
  const merchant = merchantAddress(intent)
  return {
    success: resolvedTxHash ? true : undefined,
    payment_id: intent.id,
    status: intent.status,
    tx_hash: resolvedTxHash ?? undefined,
    chain_id: intent.chain_id ?? agent.chain_id,
    safe_address: intent.safe_address,
    payer: intent.safe_address,
    token: intent.token_symbol,
    amount: intent.amount_human,
    to: intent.to_address,
    merchant_to: merchant,
    merchant_address: merchant,
    resource_url: resourceUrl,
    rail,
    challenge_id: intent.machine_challenge_id,
    explorer_url: resolvedTxHash
      ? getExplorerUrl(intent.chain_id ?? agent.chain_id, 'tx', resolvedTxHash)
      : undefined,
    ...machineRailFields(rail, {
      resourceUrl,
      merchantAddress: merchant,
      amountAtomic: intent.amount_raw,
      asset: intent.token_address,
      network: nullableString(metadata.network),
      description: nullableString(metadata.description),
      idempotencyKey: intent.machine_idempotency_key ?? intent.x402_idempotency_key,
      challengeId: intent.machine_challenge_id,
    }),
  }
}

async function currentPaymentIntentStatus(id: string, agent: AgentContext): Promise<string> {
  return getIntentStatus(id, agent.id)
}

function signData(intent: PaymentIntentRow, hash = intent.sign_hash, nonce = intent.allowance_nonce) {
  // Legacy AllowanceModule shape (import-only accounts, #834 owner decision).
  // Session-rail intents are retired and refused before sign_data is built.
  return {
    hash,
    components: {
      safe: intent.safe_address,
      token: intent.token_address,
      to: intent.to_address,
      amount: intent.amount_raw,
      payment_token: ZERO_ADDRESS,
      payment: '0',
      nonce,
    },
    instructions:
      'Sign the hash with your delegate private key using raw ECDSA (not eth_sign). ' +
      `Then POST /payments/${intent.id}/sign with { signature } to execute, ` +
      'or re-call the rail authorization endpoint with the signature field included for one-shot execution.',
  }
}

function pendingApprovalResponse(
  approval: ApprovalRequestRow,
  remainingHuman: string | null,
  rail: MachinePaymentRail,
  context?: MachineRailContext,
) {
  const metadata = metadataObject(approval.machine_metadata)
  const railContext: MachineRailContext = context ?? {
    resourceUrl: approval.payment_resource_url,
    merchantAddress: approval.merchant_address,
    amountAtomic: approval.amount_raw,
    asset: approval.token_address,
    network: nullableString(metadata.network),
    description: nullableString(metadata.description),
    idempotencyKey: approval.machine_idempotency_key,
    challengeId: approval.machine_challenge_id,
  }

  return {
    statusCode: 202,
    body: {
      payment_id: approval.id,
      kind: 'approval_request',
      status: 'pending_approval',
      phase: AgentPaymentPhase.UserApprovalRequired,
      next_action: AgentPaymentNextAction.WaitForUserApproval,
      message: `Payment of ${approval.amount_human} ${approval.token_symbol} exceeds the remaining on-chain allowance. Queued for owner approval.`,
      remaining: remainingHuman,
      requested: approval.amount_human,
      token: approval.token_symbol,
      expires_at: approval.expires_at,
      rail,
      challenge_id: approval.machine_challenge_id,
      resource_url: railContext.resourceUrl,
      merchant_address: railContext.merchantAddress,
      chain_id: approval.chain_id,
      ...machineRailFields(rail, railContext),
    },
  }
}

async function findExistingIntent(
  agent: AgentContext,
  rail: MachinePaymentRail,
  idempotencyKey?: string | null,
  challengeId?: string | null,
): Promise<PaymentIntentRow | null> {
  if (!idempotencyKey && !challengeId) return null

  return findMachineIntentByKeyOrChallenge(
    agent.id,
    idempotencyKey ?? null,
    challengeId ?? null,
    rail,
  )
}

async function findExistingApproval(
  agent: AgentContext,
  rail: MachinePaymentRail,
  idempotencyKey?: string | null,
  challengeId?: string | null,
): Promise<ApprovalRequestRow | null> {
  if (!idempotencyKey && !challengeId) return null

  return findMachineApprovalByKeyOrChallenge(
    agent.id,
    idempotencyKey ?? null,
    challengeId ?? null,
    rail,
  )
}

async function returnExistingIntent(
  existing: PaymentIntentRow,
  agent: AgentContext,
  rail: MachinePaymentRail,
) {
  if (existing.status === 'confirmed' && existing.tx_hash) {
    return { statusCode: 200, body: machinePaymentResponse(existing, agent) }
  }

  if (existing.status === 'pending_signature') {
    // Session-rail intents are retired (#834) — a still-pending one can no
    // longer execute; the client must re-authorize on the delegation rail.
    if (isRetiredRailIntent(existing.execution_rail)) {
      return sessionRailRetired('intent')
    }
    let existingHash = existing.sign_hash
    let existingNonce = existing.allowance_nonce
    const refreshedAllowance = await getTokenAllowance(
      agent.chain_id,
      agent.safe_address,
      agent.delegate_address,
      existing.token_address,
    )

    if (Number(refreshedAllowance.nonce) !== Number(existing.allowance_nonce)) {
      existingNonce = refreshedAllowance.nonce
      existingHash = await generateTransferHash(
        agent.chain_id,
        agent.safe_address,
        existing.token_address,
        existing.to_address,
        BigInt(existing.amount_raw),
        ZERO_ADDRESS,
        0n,
        refreshedAllowance.nonce,
      )

      const refreshed = await refreshMachineIntentNonce({
        allowanceNonce: existingNonce,
        signHash: existingHash,
        intentId: existing.id,
        agentId: agent.id,
        rail,
      })
      if (!refreshed) {
        const status = await currentPaymentIntentStatus(existing.id, agent)
        return {
          statusCode: 409,
          body: {
            payment_id: existing.id,
            status,
            error: `Machine payment is ${status}, expected pending_signature`,
          },
        }
      }
    }

    return {
      statusCode: 200,
      body: {
        ...machinePaymentResponse(existing, agent),
        success: undefined,
        sign_data: signData(existing, existingHash, existingNonce),
      },
    }
  }

  return {
    statusCode: 409,
    body: {
      payment_id: existing.id,
      status: existing.status,
      error: 'Machine payment already submitted',
    },
  }
}

export async function authorizeMachinePayment(input: AuthorizeMachinePaymentInput) {
  const {
    agent,
    rail,
    resourceUrl,
    asset,
    chainId,
    description,
    category,
    idempotencyKey,
    challengeId,
    metadata,
    signature,
    enforceX402RateLimit = false,
  } = input

  let payTo = input.payTo
  let merchantPayTo = input.merchantPayTo ?? null

  if (!resourceUrl || typeof resourceUrl !== 'string') {
    return { statusCode: 400, body: { error: 'Resource URL is required' } }
  }
  if (!payTo || !isAddress(payTo)) {
    return { statusCode: 400, body: { error: 'Valid payTo address is required' } }
  }
  payTo = normaliseAddress(payTo)

  if (merchantPayTo !== null) {
    if (!merchantPayTo || !isAddress(merchantPayTo)) {
      return { statusCode: 400, body: { error: 'Valid merchantPayTo address is required' } }
    }
    merchantPayTo = normaliseAddress(merchantPayTo)
  }

  if (chainId !== agent.chain_id) {
    return {
      statusCode: 400,
      body: { error: `Payment chain ${chainId} does not match agent chain ${agent.chain_id}` },
    }
  }

  const tokenResult = resolvePaymentToken(agent.chain_id, asset)
  if (!tokenResult.ok) {
    return {
      statusCode: 400,
      body: { error: tokenResult.error, supported: tokenResult.supported },
    }
  }
  const { tokenConfig, tokenAddress } = tokenResult

  let amountRaw: bigint
  try {
    amountRaw = BigInt(input.amountAtomic)
  } catch {
    return { statusCode: 400, body: { error: 'Invalid amount — must be integer atomic units' } }
  }
  if (amountRaw <= 0n) {
    return { statusCode: 400, body: { error: 'Amount must be greater than zero' } }
  }

  const amountHuman = formatTokenValue(amountRaw.toString(), tokenConfig.decimals)

  const existingIntent = await findExistingIntent(agent, rail, idempotencyKey, challengeId)
  if (existingIntent) return returnExistingIntent(existingIntent, agent, rail)

  const existingApproval = await findExistingApproval(agent, rail, idempotencyKey, challengeId)
  if (existingApproval) {
    if (existingApproval.status === 'rejected') {
      return {
        statusCode: 409,
        body: {
          payment_id: existingApproval.id,
          status: existingApproval.status,
          error: 'Payment was rejected by the account owner',
        },
      }
    }

    if (existingApproval.status !== 'pending') {
      const status = await getAgentPaymentStatus(agent, existingApproval.id)
      if (!status) {
        return {
          statusCode: 409,
          body: { error: 'Machine payment approval already exists but could not be loaded' },
        }
      }
      return { statusCode: agentPaymentStatusHttpCode(status), body: status }
    }

    return pendingApprovalResponse(existingApproval, null, rail)
  }

  const allowanceConfigured = await hasTokenAllowanceConfigured(agent.id, tokenAddress)
  if (!allowanceConfigured) {
    return {
      statusCode: 403,
      body: { error: `Agent is not configured for ${tokenConfig.symbol} payments` },
    }
  }

  if (enforceX402RateLimit) {
    const { maxPerHour, recentCount } = await getX402HourlyUsage(agent.id)
    if (recentCount >= maxPerHour) {
      return {
        statusCode: 429,
        body: {
          error: `Rate limit exceeded: max ${maxPerHour} x402 payments per hour`,
          retry_after_seconds: 60,
        },
      }
    }
  }

  // ── Retired-session gate (#993) — the marking alone decides; see the seam.
  const railDecision = resolveExecutionRail({
    ...(await loadExecutionRailState(agent)),
    chainId: agent.chain_id,
  })
  if (railDecision.rail === 'retired_session') {
    // #993: retirement decided in the seam, refusal produced there too.
    return sessionRailRetired('account')
  }

  let onChainAllowance
  let chainTimeSec: number
  try {
    ;[onChainAllowance, chainTimeSec] = await Promise.all([
      getTokenAllowance(
        agent.chain_id,
        agent.safe_address,
        agent.delegate_address,
        tokenAddress,
      ),
      getLatestBlockTimeSec(agent.chain_id),
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
  // Allowance-only coverage: MPP rails route purely on the remaining on-chain
  // allowance (the delegate balance is not consulted). x402's balance-aware
  // variant lives in the x402 module. See lib/payment-coverage.decideCoverage.
  const coverage = decideCoverage('allowance-only', {
    amount: amountRaw,
    remaining: effective.remaining,
  })
  if (coverage.kind === 'queue') {
    const remainingHuman = ethers.formatUnits(effective.remaining, tokenConfig.decimals)
    const approvalReason = approvalReasonFor(rail, {
      resourceUrl,
      merchantPayTo,
      category,
      amountHuman,
      tokenSymbol: tokenConfig.symbol,
      remainingHuman,
    })

    let approval = await insertMachineApproval({
      agent,
      rail,
      payTo,
      tokenSymbol: tokenConfig.symbol,
      tokenAddress,
      amountRaw,
      amountHuman,
      reason: approvalReason,
      resourceUrl,
      merchantAddress: merchantPayTo,
      challengeId: challengeId ?? null,
      idempotencyKey: idempotencyKey ?? null,
      metadata: metadata ?? null,
    })
    if (!approval) {
      approval = await findExistingApproval(agent, rail, idempotencyKey, challengeId)
    }
    if (!approval) {
      return {
        statusCode: 409,
        body: { error: 'Machine payment approval already exists but could not be loaded' },
      }
    }
    return pendingApprovalResponse(
      {
        ...approval,
        token_symbol: tokenConfig.symbol,
        amount_human: amountHuman,
        amount_raw: amountRaw.toString(),
        token_address: tokenAddress,
        tx_hash: null,
        machine_challenge_id: challengeId ?? null,
        payment_rail: rail,
        payment_resource_url: resourceUrl,
        merchant_address: merchantPayTo?.toLowerCase() ?? null,
        machine_idempotency_key: idempotencyKey ?? null,
        machine_metadata: metadata ? JSON.stringify(metadata) : null,
        chain_id: agent.chain_id,
      },
      remainingHuman,
      rail,
      {
        resourceUrl,
        merchantAddress: merchantPayTo?.toLowerCase() ?? null,
        amountAtomic: amountRaw.toString(),
        asset: tokenAddress,
        network: nullableString(metadata?.network),
        description: description ?? nullableString(metadata?.description),
        idempotencyKey: idempotencyKey ?? null,
        challengeId: challengeId ?? null,
      },
    )
  }

  let signHash: string
  try {
    signHash = await generateTransferHash(
      agent.chain_id,
      agent.safe_address,
      tokenAddress,
      payTo,
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

  let intent = await insertMachineIntent({
    agent,
    rail,
    payTo,
    tokenSymbol: tokenConfig.symbol,
    tokenAddress,
    amountRaw,
    amountHuman,
    allowanceNonce: onChainAllowance.nonce,
    signHash,
    resourceUrl,
    category: category ?? null,
    merchantAddress: merchantPayTo,
    challengeId: challengeId ?? null,
    idempotencyKey: idempotencyKey ?? null,
    metadata: metadata ?? null,
    conflictTarget: 'machine_idempotency_key',
  })
  if (!intent) {
    const existing = await findExistingIntent(agent, rail, idempotencyKey, challengeId)
    if (existing) return returnExistingIntent(existing, agent, rail)
    return {
      statusCode: 409,
      body: { error: 'Machine payment already exists but could not be loaded' },
    }
  }

  if (!signature) {
    return {
      statusCode: 201,
      body: {
        ...machinePaymentResponse(intent, agent),
        success: undefined,
        expires_at: intent.expires_at,
        sign_data: signData(intent),
      },
    }
  }

  let recoveredAddress: string
  try {
    recoveredAddress = recoverSigner(signHash, signature)
  } catch (err) {
    return {
      statusCode: 400,
      body: {
        error: 'Invalid signature format',
        details: err instanceof Error ? err.message : String(err),
      },
    }
  }

  if (recoveredAddress.toLowerCase() !== agent.delegate_address.toLowerCase()) {
    return {
      statusCode: 403,
      body: {
        error: 'Signature does not match delegate address',
        expected: agent.delegate_address,
        recovered: recoveredAddress,
      },
    }
  }

  const signatureRecorded = await recordMachineIntentSignature(signature, intent.id, agent.id, rail)
  if (!signatureRecorded) {
    const status = await currentPaymentIntentStatus(intent.id, agent)
    return {
      statusCode: 409,
      body: {
        payment_id: intent.id,
        status,
        error: 'Payment intent changed before execution',
      },
    }
  }

  try {
    const { txHash } = await executeAllowanceTransfer(
      agent.chain_id,
      agent.safe_address,
      tokenAddress,
      payTo.toLowerCase(),
      amountRaw,
      ZERO_ADDRESS,
      0n,
      agent.delegate_address,
      signature,
      { agentId: agent.id, userId: agent.user_id },
    )

    const fiatValues = await getFiatValuesForTokenAmount(
      tokenConfig.symbol,
      amountHuman,
    )

    const confirmed = await confirmMachineIntent({
      txHash,
      intentId: intent.id,
      usdValue: fiatValues.usd,
      eurValue: fiatValues.eur,
      agentId: agent.id,
      rail,
    })

    if (!confirmed) {
      const status = await currentPaymentIntentStatus(intent.id, agent)
      return {
        statusCode: 409,
        body: {
          payment_id: intent.id,
          status,
          error: 'Payment intent changed after on-chain execution',
        },
      }
    }

    await tryRecordMachinePaymentEvidenceBaseById(intent.id, agent.id)

    return {
      statusCode: 201,
      body: {
        ...machinePaymentResponse({ ...intent, status: 'confirmed', tx_hash: txHash }, agent, txHash),
        success: true,
      },
    }
  } catch (err) {
    // #717: an over-budget refusal happened BEFORE anything was submitted —
    // 429 and leave the intent pending so a later retry can execute; burning
    // it to 'failed' would punish the caller twice.
    if (err instanceof RelayerBudgetExceededError) {
      return {
        statusCode: 429,
        body: {
          success: false,
          payment_id: intent.id,
          status: 'pending_signature',
          error: err.message,
        },
      }
    }
    const errorMsg = err instanceof Error ? err.message : String(err)
    await failMachineIntent(errorMsg, intent.id, agent.id, rail)
    return {
      statusCode: 502,
      body: {
        success: false,
        payment_id: intent.id,
        status: 'failed',
        error: 'On-chain execution failed',
        details: errorMsg,
      },
    }
  }
}
