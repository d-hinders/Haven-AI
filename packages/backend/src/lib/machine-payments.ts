import { ethers } from 'ethers'
import pool from '../db.js'
import { type AgentContext } from '../middleware/agentAuth.js'
import { getChain, getExplorerUrl } from './chains.js'
import { getFiatValuesForTokenAmount } from './fiat-values.js'
import { formatTokenValue } from './tokens.js'
import {
  getTokenAllowance,
  computeEffectiveAllowance,
  generateTransferHash,
  recoverSigner,
  executeAllowanceTransfer,
} from './allowance-module.js'
import { tryRecordMachinePaymentEvidenceBaseById } from './machine-payment-evidence.js'

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

interface PaymentIntentRow {
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
  x402_merchant_address: string | null
  x402_idempotency_key: string | null
  payment_rail: string | null
  payment_resource_url: string | null
  merchant_address: string | null
  machine_challenge_id: string | null
  machine_idempotency_key: string | null
  expires_at: string
}

interface ApprovalRequestRow {
  id: string
  status: string
  token_symbol: string
  amount_human: string
  expires_at: string
  tx_hash: string | null
  machine_challenge_id: string | null
  payment_rail: string | null
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

function paymentResourceUrl(intent: PaymentIntentRow): string | null {
  return intent.payment_resource_url ?? intent.x402_resource_url
}

function merchantAddress(intent: PaymentIntentRow): string | null {
  return intent.merchant_address ?? intent.x402_merchant_address
}

function machinePaymentResponse(
  intent: PaymentIntentRow,
  agent: AgentContext,
  txHash?: string,
) {
  const resolvedTxHash = txHash ?? intent.tx_hash
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
    merchant_to: merchantAddress(intent),
    resource_url: paymentResourceUrl(intent),
    rail: intent.payment_rail ?? intent.source,
    challenge_id: intent.machine_challenge_id,
    explorer_url: resolvedTxHash
      ? getExplorerUrl(intent.chain_id ?? agent.chain_id, 'tx', resolvedTxHash)
      : undefined,
  }
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
) {
  return {
    statusCode: 202,
    body: {
      payment_id: approval.id,
      status: 'pending_approval',
      message: `Payment of ${approval.amount_human} ${approval.token_symbol} exceeds the remaining on-chain allowance. Queued for owner approval.`,
      remaining: remainingHuman,
      requested: approval.amount_human,
      token: approval.token_symbol,
      expires_at: approval.expires_at,
      rail,
      challenge_id: approval.machine_challenge_id,
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
    `SELECT id, status, token_symbol, amount_human, expires_at, tx_hash,
            machine_challenge_id, payment_rail
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

      await pool.query(
        `UPDATE payment_intents
         SET allowance_nonce = $1,
             sign_hash = $2,
             expires_at = NOW() + interval '10 minutes'
         WHERE id = $3`,
        [existingNonce, existingHash, existing.id],
      )
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

  const chain = getChain(agent.chain_id)
  const tokenConfig = resolveTokenByAddress(agent.chain_id, asset)
  if (!tokenConfig) {
    return {
      statusCode: 400,
      body: {
        error: `Unsupported token asset: ${asset}`,
        supported: Object.values(chain.tokens).map((t) => ({
          symbol: t.symbol,
          address: t.address ?? ZERO_ADDRESS,
        })),
      },
    }
  }

  const tokenAddress = tokenConfig.address ?? ZERO_ADDRESS

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
  if (existingIntent) return returnExistingIntent(existingIntent, agent)

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
  try {
    onChainAllowance = await getTokenAllowance(
      agent.chain_id,
      agent.safe_address,
      agent.delegate_address,
      tokenAddress,
    )
  } catch (err) {
    return {
      statusCode: 502,
      body: {
        error: 'Failed to read on-chain allowance',
        details: err instanceof Error ? err.message : String(err),
      },
    }
  }

  const effective = computeEffectiveAllowance(onChainAllowance)
  if (amountRaw > effective.remaining) {
    const remainingHuman = ethers.formatUnits(effective.remaining, tokenConfig.decimals)
    const merchantPart = merchantPayTo ? ` to merchant ${merchantPayTo}` : ''
    const approvalReason =
      rail === 'x402'
        ? `x402 payment for ${resourceUrl}${merchantPart}${category ? ` (${category})` : ''} — exceeds remaining allowance (${amountHuman} ${tokenConfig.symbol} requested, ${remainingHuman} available)`
        : `Machine payment demo for ${resourceUrl}${merchantPart} — exceeds remaining allowance (${amountHuman} ${tokenConfig.symbol} requested, ${remainingHuman} available)`

    const approvalResult = await pool.query<ApprovalRequestRow>(
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
      RETURNING id, status, token_symbol, amount_human, expires_at, tx_hash,
                machine_challenge_id, payment_rail`,
      [
        agent.id, agent.user_id, agent.safe_address, agent.chain_id,
        tokenConfig.symbol, tokenAddress, payTo.toLowerCase(),
        amountRaw.toString(), amountHuman, approvalReason, rail,
        rail === 'x402' ? resourceUrl : null,
        rail, resourceUrl, merchantPayTo?.toLowerCase() ?? null, challengeId ?? null,
        idempotencyKey ?? null, metadata ? JSON.stringify(metadata) : null,
      ],
    )

    let approval: ApprovalRequestRow | null = approvalResult.rows[0] ?? null
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
        tx_hash: null,
        machine_challenge_id: challengeId ?? null,
        payment_rail: rail,
      },
      remainingHuman,
      rail,
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

  const intentResult = await pool.query<PaymentIntentRow>(
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
    ON CONFLICT (agent_id, machine_idempotency_key)
      WHERE machine_idempotency_key IS NOT NULL
        AND status NOT IN ('failed', 'expired')
    DO NOTHING
    RETURNING *`,
    [
      agent.id, agent.user_id, agent.safe_address, agent.chain_id,
      tokenConfig.symbol, tokenAddress, payTo.toLowerCase(),
      amountRaw.toString(), amountHuman, agent.delegate_address,
      onChainAllowance.nonce, signHash,
      rail, rail === 'x402' ? resourceUrl : null, category ?? null,
      rail === 'x402' ? merchantPayTo?.toLowerCase() ?? null : null,
      rail === 'x402' ? idempotencyKey ?? null : null,
      rail, resourceUrl, merchantPayTo?.toLowerCase() ?? null, challengeId ?? null,
      idempotencyKey ?? null, metadata ? JSON.stringify(metadata) : null,
    ],
  )
  let intent = intentResult.rows[0]
  if (!intent) {
    const existing = await findExistingIntent(agent, rail, idempotencyKey, challengeId)
    if (existing) return returnExistingIntent(existing, agent)
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

  await pool.query(
    `UPDATE payment_intents SET signature = $1, signed_at = NOW(), status = 'submitted', submitted_at = NOW() WHERE id = $2`,
    [signature, intent.id],
  )

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

    await pool.query(
      `UPDATE payment_intents
       SET status = 'confirmed',
           tx_hash = $1,
           confirmed_at = NOW(),
           usd_value = $3,
           eur_value = $4
       WHERE id = $2`,
      [txHash, intent.id, fiatValues.usd, fiatValues.eur],
    )

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
      `UPDATE payment_intents SET status = 'failed', error_message = $1 WHERE id = $2`,
      [errorMsg, intent.id],
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
