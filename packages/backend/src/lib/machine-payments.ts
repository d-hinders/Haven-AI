import { ethers } from 'ethers'
import pool from '../db.js'
import { type AgentContext } from '../middleware/agentAuth.js'
import { AgentPaymentNextAction, AgentPaymentPhase } from './agent-payment-taxonomy.js'
import {
  agentPaymentStatusHttpCode,
  getAgentPaymentStatus,
} from './agent-payment-status.js'
import { getChain, getExplorerUrl } from './chains.js'
import { getFiatValuesForTokenAmount } from './fiat-values.js'
import { formatTokenValue } from './tokens.js'
import {
  getTokenAllowance,
  getLatestBlockTimeSec,
  computeEffectiveAllowance,
  generateTransferHash,
  recoverSigner,
  executeAllowanceTransfer,
} from './allowance-module.js'
import { tryRecordMachinePaymentEvidenceBaseById } from './machine-payment-evidence.js'
import { decideCoverage } from './payment-coverage.js'

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export type MachinePaymentRail =
  | 'x402'
  | 'mpp_demo'
  | 'mpp_crypto'
  | 'stripe_deposit'
  | 'spt'

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

export interface PaymentIntentRow {
  id: string
  agent_id: string
  user_id: string
  safe_address: string
  chain_id: number
  token_symbol: string
  token_address: string
  to_address: string
  amount_raw: string
  amount_human: string
  delegate_address: string
  allowance_nonce: number
  sign_hash: string
  signature: string | null
  tx_hash: string | null
  status: string
  error_message: string | null
  source: string | null
  x402_resource_url: string | null
  x402_category: string | null
  x402_merchant_address: string | null
  x402_idempotency_key: string | null
  payment_rail: string | null
  payment_resource_url: string | null
  merchant_address: string | null
  machine_challenge_id: string | null
  machine_idempotency_key: string | null
  machine_metadata: unknown
  expires_at: string
}

interface ApprovalRequestRow {
  id: string
  chain_id: number
  status: string
  token_symbol: string
  token_address: string | null
  amount_human: string
  amount_raw: string | null
  expires_at: string
  tx_hash: string | null
  machine_challenge_id: string | null
  payment_rail: string | null
  payment_resource_url: string | null
  merchant_address: string | null
  machine_idempotency_key: string | null
  machine_metadata: unknown
}

export function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr)
}

export function normaliseAddress(addr: string): string {
  return ethers.getAddress(addr.toLowerCase())
}

export function resolveTokenByAddress(chainId: number, address: string) {
  const lower = address.toLowerCase()
  const chain = getChain(chainId)
  if (lower === ZERO_ADDRESS) {
    return Object.values(chain.tokens).find((t) => t.address === null) ?? null
  }
  return chain.tokenByAddress[lower] ?? null
}

export type ResolvePaymentTokenResult =
  | { ok: true; tokenConfig: NonNullable<ReturnType<typeof resolveTokenByAddress>>; tokenAddress: string }
  | { ok: false; error: string; supported: Array<{ symbol: string; address: string }> }

/**
 * Resolve a payment token from its contract address, returning the token config
 * and the AllowanceModule token address (ZERO_ADDRESS for the native asset), or
 * a structured 400-shaped error listing the chain's supported tokens. The
 * single token-resolution path for both the x402 route and the MPP core (each
 * previously had its own identical copy of this block).
 */
export function resolvePaymentToken(chainId: number, asset: string): ResolvePaymentTokenResult {
  const tokenConfig = resolveTokenByAddress(chainId, asset)
  if (!tokenConfig) {
    const chain = getChain(chainId)
    return {
      ok: false,
      error: `Unsupported token asset: ${asset}`,
      supported: Object.values(chain.tokens).map((t) => ({
        symbol: t.symbol,
        address: t.address ?? ZERO_ADDRESS,
      })),
    }
  }
  return { ok: true, tokenConfig, tokenAddress: tokenConfig.address ?? ZERO_ADDRESS }
}

function paymentResourceUrl(intent: PaymentIntentRow): string | null {
  return intent.payment_resource_url ?? intent.x402_resource_url
}

function merchantAddress(intent: PaymentIntentRow): string | null {
  return intent.merchant_address ?? intent.x402_merchant_address
}

interface MachineMetadata {
  network?: unknown
  description?: unknown
}

interface MachineRailContext {
  resourceUrl: string | null
  merchantAddress: string | null
  amountAtomic: string | null
  asset: string | null
  network: string | null
  description: string | null
  idempotencyKey: string | null
  challengeId: string | null
}

function isMppRail(rail: string | null | undefined): boolean {
  return rail === 'mpp' || Boolean(rail?.startsWith('mpp_'))
}

function metadataObject(value: unknown): MachineMetadata {
  if (!value) return {}
  if (typeof value === 'object' && !Array.isArray(value)) return value as MachineMetadata
  if (typeof value !== 'string') return {}

  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as MachineMetadata
    }
  } catch {
    return {}
  }

  return {}
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function machineRailFields(rail: string | null | undefined, context: MachineRailContext) {
  const base = {
    amount_atomic: context.amountAtomic,
    asset: context.asset,
    network: context.network,
    description: context.description,
    idempotency_key: context.idempotencyKey,
  }

  if (!isMppRail(rail)) return base

  return {
    ...base,
    mpp: {
      ...base,
      resource_url: context.resourceUrl,
      merchant_address: context.merchantAddress,
      challenge_id: context.challengeId,
    },
  }
}

function machinePaymentResponse(
  intent: PaymentIntentRow,
  agent: AgentContext,
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
  const current = await pool.query<{ status: string }>(
    `SELECT status FROM payment_intents WHERE id = $1 AND agent_id = $2`,
    [id, agent.id],
  )
  return current.rows[0]?.status ?? 'unknown'
}

function signData(intent: PaymentIntentRow, hash = intent.sign_hash, nonce = intent.allowance_nonce) {
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
  const railContext = context ?? {
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

  const result = await pool.query<PaymentIntentRow>(
    `SELECT *
     FROM payment_intents
     WHERE agent_id = $1
       AND status NOT IN ('failed', 'expired')
       AND COALESCE(payment_rail, source) = $4
       AND (
         ($2::TEXT IS NOT NULL AND (
           machine_idempotency_key = $2
           OR x402_idempotency_key = $2
         ))
         OR (
           $3::TEXT IS NOT NULL
           AND machine_challenge_id = $3
           AND payment_rail = $4
         )
       )
     ORDER BY created_at DESC
     LIMIT 1`,
    [agent.id, idempotencyKey ?? null, challengeId ?? null, rail],
  )

  return result.rows[0] ?? null
}

async function findExistingApproval(
  agent: AgentContext,
  rail: MachinePaymentRail,
  idempotencyKey?: string | null,
  challengeId?: string | null,
): Promise<ApprovalRequestRow | null> {
  if (!idempotencyKey && !challengeId) return null

  const result = await pool.query<ApprovalRequestRow>(
    `SELECT id, chain_id, status, token_symbol, token_address, amount_human,
            amount_raw, expires_at, tx_hash, machine_challenge_id, payment_rail,
            payment_resource_url, merchant_address, machine_idempotency_key,
            machine_metadata
     FROM approval_requests
     WHERE agent_id = $1
       AND status <> 'expired'
       AND (
         ($2::TEXT IS NOT NULL AND machine_idempotency_key = $2)
         OR (
           $3::TEXT IS NOT NULL
           AND machine_challenge_id = $3
           AND payment_rail = $4
         )
       )
     ORDER BY created_at DESC
     LIMIT 1`,
    [agent.id, idempotencyKey ?? null, challengeId ?? null, rail],
  )

  return result.rows[0] ?? null
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

      const refreshedResult = await pool.query<{ id: string }>(
        `UPDATE payment_intents
         SET allowance_nonce = $1,
             sign_hash = $2,
             expires_at = NOW() + interval '10 minutes'
         WHERE id = $3
           AND agent_id = $4
           AND COALESCE(payment_rail, source) = $5
           AND status = 'pending_signature'
           AND tx_hash IS NULL
         RETURNING id`,
        [existingNonce, existingHash, existing.id, agent.id, rail],
      )
      if (refreshedResult.rows.length === 0) {
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

export interface CreateMachineApprovalInput {
  agent: Pick<AgentContext, 'id' | 'user_id' | 'safe_address' | 'chain_id'>
  rail: MachinePaymentRail
  payTo: string
  tokenSymbol: string
  tokenAddress: string
  amountRaw: bigint
  amountHuman: string
  reason: string
  resourceUrl: string
  merchantAddress: string | null
  challengeId: string | null
  idempotencyKey: string | null
  /** Plain object — serialised to JSON here; pass null to store SQL NULL. */
  metadata: unknown | null
}

/**
 * Insert a pending `approval_requests` row for an over-allowance machine
 * payment. This is the single, rail-agnostic writer for the approval row —
 * both `authorizeMachinePayment` (MPP rails) and the x402 route call it so the
 * column set, `ON CONFLICT` target, and `'pending'` / 24h-expiry semantics
 * cannot drift between paths.
 *
 * Returns the inserted row, or `null` when the `ON CONFLICT … DO NOTHING`
 * clause suppresses the insert (an idempotent replay). Callers own the reload
 * of the pre-existing row and the HTTP response shaping, which differ per path.
 *
 * `source` and `payment_rail` are both set from `rail`; for x402, `challengeId`
 * is `null` (x402 dedupes on `idempotencyKey`, not a challenge).
 */
export async function createMachineApproval(
  input: CreateMachineApprovalInput,
): Promise<ApprovalRequestRow | null> {
  const {
    agent, rail, payTo, tokenSymbol, tokenAddress, amountRaw, amountHuman,
    reason, resourceUrl, merchantAddress, challengeId, idempotencyKey, metadata,
  } = input

  const result = await pool.query<ApprovalRequestRow>(
    `INSERT INTO approval_requests (
      agent_id, user_id, safe_address, chain_id, token_symbol, token_address,
      to_address, amount_raw, amount_human, reason, source, x402_resource_url,
      payment_rail, payment_resource_url, merchant_address, machine_challenge_id,
      machine_idempotency_key, machine_metadata, status, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
      $13, $14, $15, $16, $17, $18, 'pending', NOW() + interval '24 hours')
    ON CONFLICT (agent_id, machine_idempotency_key)
      WHERE machine_idempotency_key IS NOT NULL
        AND status NOT IN ('expired')
    DO NOTHING
    RETURNING id, chain_id, status, token_symbol, token_address, amount_human,
              amount_raw, expires_at, tx_hash, machine_challenge_id, payment_rail,
              payment_resource_url, merchant_address, machine_idempotency_key,
              machine_metadata`,
    [
      agent.id, agent.user_id, agent.safe_address, agent.chain_id,
      tokenSymbol, tokenAddress, payTo.toLowerCase(),
      amountRaw.toString(), amountHuman, reason, rail,
      rail === 'x402' ? resourceUrl : null,
      rail, resourceUrl, merchantAddress?.toLowerCase() ?? null, challengeId ?? null,
      idempotencyKey ?? null, metadata != null ? JSON.stringify(metadata) : null,
    ],
  )

  return result.rows[0] ?? null
}

export interface CreatePaymentIntentInput {
  agent: Pick<AgentContext, 'id' | 'user_id' | 'safe_address' | 'chain_id' | 'delegate_address'>
  rail: MachinePaymentRail
  payTo: string
  tokenSymbol: string
  tokenAddress: string
  amountRaw: bigint
  amountHuman: string
  allowanceNonce: number
  signHash: string
  resourceUrl: string
  category: string | null
  merchantAddress: string | null
  challengeId: string | null
  idempotencyKey: string | null
  /** Plain object — serialised to JSON here; pass null to store SQL NULL. */
  metadata: unknown | null
  /**
   * Which partial-unique index enforces idempotent dedup for this rail. x402
   * dedupes on `x402_idempotency_key`; MPP rails on `machine_idempotency_key`.
   * Both columns are written (x402 fills both), so the choice only selects the
   * conflict arbiter — it does not change the stored row.
   */
  conflictTarget: 'machine_idempotency_key' | 'x402_idempotency_key'
}

/**
 * Insert a `pending_signature` payment_intents row. The single, rail-agnostic
 * writer for the intent row (mirrors createMachineApproval for approvals) so the
 * column set, status, and 10-minute expiry cannot drift between the x402 route
 * and the MPP core.
 *
 * Returns the inserted row, or `null` when ON CONFLICT … DO NOTHING suppresses
 * the insert (idempotent replay). Callers own the reload of the pre-existing
 * row and response shaping. The conflict arbiter is parameterised so each rail
 * keeps its exact dedup semantics.
 */
export async function createPaymentIntent(
  input: CreatePaymentIntentInput,
): Promise<PaymentIntentRow | null> {
  const {
    agent, rail, payTo, tokenSymbol, tokenAddress, amountRaw, amountHuman,
    allowanceNonce, signHash, resourceUrl, category, merchantAddress,
    challengeId, idempotencyKey, metadata, conflictTarget,
  } = input

  // conflictTarget is a strict union mapped through an allowlist — never raw
  // input — so interpolating it into the ON CONFLICT clause is injection-safe.
  const conflictColumn =
    conflictTarget === 'x402_idempotency_key' ? 'x402_idempotency_key' : 'machine_idempotency_key'

  const result = await pool.query<PaymentIntentRow>(
    `INSERT INTO payment_intents (
      agent_id, user_id, safe_address, chain_id, token_symbol, token_address,
      to_address, amount_raw, amount_human, delegate_address,
      allowance_nonce, sign_hash, status, source, x402_resource_url, x402_category,
      x402_merchant_address, x402_idempotency_key,
      payment_rail, payment_resource_url, merchant_address, machine_challenge_id,
      machine_idempotency_key, machine_metadata, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
      'pending_signature', $13, $14, $15, $16, $17,
      $18, $19, $20, $21, $22, $23, NOW() + interval '10 minutes')
    ON CONFLICT (agent_id, ${conflictColumn})
      WHERE ${conflictColumn} IS NOT NULL
        AND status NOT IN ('failed', 'expired')
    DO NOTHING
    RETURNING *`,
    [
      agent.id, agent.user_id, agent.safe_address, agent.chain_id,
      tokenSymbol, tokenAddress, payTo.toLowerCase(),
      amountRaw.toString(), amountHuman, agent.delegate_address,
      allowanceNonce, signHash,
      rail, rail === 'x402' ? resourceUrl : null, category ?? null,
      rail === 'x402' ? merchantAddress?.toLowerCase() ?? null : null,
      rail === 'x402' ? idempotencyKey ?? null : null,
      rail, resourceUrl, merchantAddress?.toLowerCase() ?? null, challengeId ?? null,
      idempotencyKey ?? null, metadata != null ? JSON.stringify(metadata) : null,
    ],
  )

  return result.rows[0] ?? null
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
  if (!payTo || !isValidAddress(payTo)) {
    return { statusCode: 400, body: { error: 'Valid payTo address is required' } }
  }
  payTo = normaliseAddress(payTo)

  if (merchantPayTo !== null) {
    if (!merchantPayTo || !isValidAddress(merchantPayTo)) {
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

  const dbAllowance = await pool.query<{ allowance_amount: string }>(
    `SELECT allowance_amount FROM agent_allowances
     WHERE agent_id = $1 AND LOWER(token_address) = LOWER($2)`,
    [agent.id, tokenAddress],
  )
  if (dbAllowance.rows.length === 0) {
    return {
      statusCode: 403,
      body: { error: `Agent is not configured for ${tokenConfig.symbol} payments` },
    }
  }

  if (enforceX402RateLimit) {
    const agentConfig = await pool.query(
      `SELECT max_x402_per_hour FROM agents WHERE id = $1`,
      [agent.id],
    )
    // 100 = default max x402 calls per hour (rate limit), NOT chain 100.
    const maxPerHour = agentConfig.rows[0]?.max_x402_per_hour ?? 100

    const recentCount = await pool.query(
      `SELECT COUNT(*) as cnt FROM payment_intents
       WHERE agent_id = $1 AND source = 'x402' AND created_at > NOW() - interval '1 hour'`,
      [agent.id],
    )
    if (Number(recentCount.rows[0].cnt) >= maxPerHour) {
      return {
        statusCode: 429,
        body: {
          error: `Rate limit exceeded: max ${maxPerHour} x402 payments per hour`,
          retry_after_seconds: 60,
        },
      }
    }
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
  // variant lives in the route. See lib/payment-coverage.decideCoverage.
  const coverage = decideCoverage('allowance-only', {
    amount: amountRaw,
    remaining: effective.remaining,
  })
  if (coverage.kind === 'queue') {
    const remainingHuman = ethers.formatUnits(effective.remaining, tokenConfig.decimals)
    const merchantPart = merchantPayTo ? ` to merchant ${merchantPayTo}` : ''
    const approvalReason =
      rail === 'x402'
        ? `x402 payment for ${resourceUrl}${merchantPart}${category ? ` (${category})` : ''} — exceeds remaining allowance (${amountHuman} ${tokenConfig.symbol} requested, ${remainingHuman} available)`
        : `Machine payment demo for ${resourceUrl}${merchantPart} — exceeds remaining allowance (${amountHuman} ${tokenConfig.symbol} requested, ${remainingHuman} available)`

    let approval = await createMachineApproval({
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

  let intent = await createPaymentIntent({
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

  const signatureResult = await pool.query<{ id: string }>(
    `UPDATE payment_intents
     SET signature = $1, signed_at = NOW()
     WHERE id = $2
       AND agent_id = $3
       AND payment_rail = $4
       AND status = 'pending_signature'
       AND tx_hash IS NULL
     RETURNING id`,
    [signature, intent.id, agent.id, rail],
  )
  if (signatureResult.rows.length === 0) {
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
    )

    const fiatValues = await getFiatValuesForTokenAmount(
      tokenConfig.symbol,
      amountHuman,
    )

    const confirmedResult = await pool.query<{ id: string }>(
      `UPDATE payment_intents
       SET status = 'confirmed',
           tx_hash = $1,
           submitted_at = NOW(),
           confirmed_at = NOW(),
           usd_value = $3,
           eur_value = $4
       WHERE id = $2
         AND agent_id = $5
         AND payment_rail = $6
         AND status = 'pending_signature'
         AND tx_hash IS NULL
       RETURNING id`,
      [txHash, intent.id, fiatValues.usd, fiatValues.eur, agent.id, rail],
    )

    if (confirmedResult.rows.length === 0) {
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
    const errorMsg = err instanceof Error ? err.message : String(err)
    await pool.query(
      `UPDATE payment_intents
       SET status = 'failed', error_message = $1
       WHERE id = $2
         AND agent_id = $3
         AND payment_rail = $4
         AND status = 'pending_signature'
         AND tx_hash IS NULL`,
      [errorMsg, intent.id, agent.id, rail],
    )
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
