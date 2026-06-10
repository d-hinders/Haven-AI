import { FastifyInstance } from 'fastify'
import { ethers } from 'ethers'
import pool from '../db.js'
import { agentAuthMiddleware, type AgentContext } from '../middleware/agentAuth.js'
import {
  authorizeMachinePayment,
  type MachinePaymentRail,
} from '../lib/machine-payments.js'
import { getAgentPaymentStatus } from '../lib/agent-payment-status.js'
import {
  attachMachinePaymentEvidence,
  type MachinePaymentEvidenceRow,
} from '../lib/machine-payment-evidence.js'
import {
  getTokenAllowance,
  computeEffectiveAllowance,
  generateTransferHash,
} from '../lib/allowance-module.js'
import { getChain } from '../lib/chains.js'
import { AgentPaymentPhase, AgentPaymentNextAction } from '../lib/agent-payment-taxonomy.js'

interface MachinePaymentChallengeBody {
  rail: MachinePaymentRail
  version: string
  challengeId: string
  resource: string
  description: string
  network: {
    chainId: number
    name: 'base'
  }
  asset: {
    symbol: 'USDC'
    address: string
    decimals: 6
  }
  amount: {
    display: string
    atomic: string
  }
  recipient: string
  expiresAt: string
  metadata?: Record<string, unknown>
}

interface AuthorizeBody {
  challenge: MachinePaymentChallengeBody
  idempotencyKey?: string
  signature?: string
}

interface ReconciliationEventBody {
  paymentId?: string
  rail?: MachinePaymentRail
  eventType?: string
  txHash?: string
  reason?: string
  details?: Record<string, unknown>
}

interface EvidenceBody {
  paymentId?: string
  rail?: MachinePaymentRail
  txHash?: string
  resourceUrl?: string
  merchantStatus?: number
  challengePayload?: Record<string, unknown>
  selectedPayment?: Record<string, unknown>
  paymentProofHeaderName?: string
  paymentProofHeader?: string
  protocolReceiptHeaderName?: string
  protocolReceiptHeader?: string
  protocolReceiptPayload?: Record<string, unknown>
}

interface AgentAllowanceRow {
  id: string
  token_address: string
  token_symbol: string
  allowance_amount: string
  reset_period_min: number
}

interface ReconciliationPaymentRow {
  id: string
  kind: 'payment_intent' | 'approval_request'
  user_id: string
  tx_hash: string | null
  status: string
  payment_rail: string | null
  source: string | null
  payment_resource_url: string | null
  x402_resource_url: string | null
  merchant_address: string | null
  x402_merchant_address: string | null
  machine_challenge_id: string | null
  machine_idempotency_key: string | null
  x402_idempotency_key: string | null
}

interface ReconciliationEventRow {
  id: string
  status: string
  created_at: string
}

const RECONCILIATION_EVENT_TYPES = new Set([
  'merchant_retry_rejected_after_payment',
])

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

const SUPPORTED_ASSETS = ['ETH', 'USDC'] as const
type SendAsset = (typeof SUPPORTED_ASSETS)[number]

interface SendBody {
  asset: SendAsset
  recipient: string
  amount: string
  idempotency_key?: string
}

interface SendPaymentIntentRow {
  id: string
  status: string
  expires_at: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function mapEvidence(row: MachinePaymentEvidenceRow) {
  return {
    id: row.id,
    payment_id: row.payment_intent_id ?? row.approval_request_id,
    payment_intent_id: row.payment_intent_id,
    approval_request_id: row.approval_request_id,
    rail: row.rail,
    proof_status: row.proof_status,
    tx_hash: row.tx_hash,
    chain_id: row.chain_id,
    resource_url: row.resource_url,
    merchant_address: row.merchant_address,
    payer_address: row.payer_address,
    settlement_address: row.settlement_address,
    token_symbol: row.token_symbol,
    token_address: row.token_address,
    amount_raw: row.amount_raw,
    amount_human: row.amount_human,
    challenge_id: row.challenge_id,
    idempotency_key: row.idempotency_key,
    challenge_payload: row.challenge_payload,
    selected_payment: row.selected_payment,
    payment_proof_header_name: row.payment_proof_header_name,
    protocol_receipt_header_name: row.protocol_receipt_header_name,
    protocol_receipt_payload: row.protocol_receipt_payload,
    merchant_status: row.merchant_status,
    confirmed_at: row.confirmed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function validateMppDemoChallenge(challenge: MachinePaymentChallengeBody): string | null {
  if (!challenge || typeof challenge !== 'object') return 'challenge is required'
  if (challenge.rail !== 'mpp_demo') return 'Only mpp_demo challenges are supported'
  if (!challenge.challengeId || typeof challenge.challengeId !== 'string') return 'challengeId is required'
  if (!challenge.resource || typeof challenge.resource !== 'string') return 'resource is required'
  if (challenge.network?.chainId !== 8453 || challenge.network?.name !== 'base') {
    return 'MPP demo payments must use Base'
  }
  if (
    challenge.asset?.symbol !== 'USDC' ||
    challenge.asset?.decimals !== 6 ||
    challenge.asset?.address?.toLowerCase() !== '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
  ) {
    return 'MPP demo payments must use Base USDC'
  }
  if (challenge.amount?.atomic !== '10000' || challenge.amount?.display !== '0.01') {
    return 'MPP demo payments are fixed at 0.01 USDC'
  }
  if (!challenge.expiresAt || typeof challenge.expiresAt !== 'string') {
    return 'expiresAt must be a valid ISO timestamp'
  }
  const expiresAtMs = new Date(challenge.expiresAt).getTime()
  if (!Number.isFinite(expiresAtMs)) {
    return 'expiresAt must be a valid ISO timestamp'
  }
  if (expiresAtMs <= Date.now()) {
    return 'MPP demo challenge has expired'
  }
  return null
}

function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr)
}

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

export default async function machinePaymentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', agentAuthMiddleware)

  app.get('/agent', async (request) => {
    const agent = request.agent as AgentContext

    return {
      id: agent.id,
      name: agent.name,
      status: agent.status,
      safe_address: agent.safe_address,
      delegate_address: agent.delegate_address,
      chain_id: agent.chain_id,
    }
  })

  app.get('/allowances', async (request, reply) => {
    const agent = request.agent as AgentContext
    const result = await pool.query<AgentAllowanceRow>(
      `SELECT id, token_address, token_symbol, allowance_amount, reset_period_min
       FROM agent_allowances
       WHERE agent_id = $1
       ORDER BY created_at ASC`,
      [agent.id],
    )

    const allowances = []
    for (const row of result.rows) {
      try {
        const onchain = await getTokenAllowance(
          agent.chain_id,
          agent.safe_address,
          agent.delegate_address,
          row.token_address,
        )
        const effective = computeEffectiveAllowance(onchain)

        allowances.push({
          id: row.id,
          token_address: row.token_address,
          token_symbol: row.token_symbol,
          configured_amount: row.allowance_amount,
          reset_period_min: row.reset_period_min,
          onchain: {
            amount: onchain.amount.toString(),
            spent: onchain.spent.toString(),
            remaining: effective.remaining.toString(),
            effective_spent: effective.effectiveSpent.toString(),
            reset_time_min: onchain.resetTimeMin,
            last_reset_min: onchain.lastResetMin,
            nonce: onchain.nonce,
            is_reset_pending: effective.isResetPending,
          },
        })
      } catch (err) {
        return reply.code(502).send({
          error: 'Failed to read on-chain allowance',
          token_address: row.token_address,
          details: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return {
      agent_id: agent.id,
      safe_address: agent.safe_address,
      delegate_address: agent.delegate_address,
      chain_id: agent.chain_id,
      allowances,
    }
  })

  app.get<{ Querystring: { limit?: string } }>('/receipts', async (request, reply) => {
    const agent = request.agent as AgentContext
    const parsedLimit = request.query.limit ? Number(request.query.limit) : 25
    const limit = Number.isInteger(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 100)
      : 25

    const result = await pool.query<MachinePaymentEvidenceRow>(
      `SELECT *
       FROM machine_payment_evidence
       WHERE agent_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [agent.id, limit],
    )

    return reply.send({
      receipts: result.rows.map(mapEvidence),
    })
  })

  app.get<{ Params: { id: string } }>('/:id/status', async (request, reply) => {
    const agent = request.agent as AgentContext
    const status = await getAgentPaymentStatus(agent, request.params.id)

    if (!status) {
      return reply.code(404).send({ error: 'Payment or approval request not found' })
    }

    return reply.send(status)
  })

  // ── POST /send — Plain transfer (asset/recipient naming convention) ─────────

  app.post<{ Body: SendBody }>('/send', async (request, reply) => {
    const agent = request.agent as AgentContext
    const { asset, recipient, amount } = request.body

    // 1. Validate inputs
    if (!asset || !SUPPORTED_ASSETS.includes(asset as SendAsset)) {
      return reply.code(400).send({
        error: 'asset must be one of: ETH, USDC',
        supported: SUPPORTED_ASSETS,
      })
    }
    if (!recipient || !isValidAddress(recipient)) {
      return reply.code(400).send({ error: 'Valid recipient address is required' })
    }
    if (!amount || typeof amount !== 'string' || isNaN(Number(amount)) || Number(amount) <= 0) {
      return reply.code(400).send({ error: 'amount must be a positive number' })
    }

    // 2. Resolve asset to token config
    const tokenConfig = resolveAsset(agent.chain_id, asset)
    if (!tokenConfig) {
      return reply.code(400).send({ error: `Unsupported asset ${asset} on chain ${agent.chain_id}` })
    }

    const tokenAddress = tokenConfig.address ?? ZERO_ADDRESS

    // 3. Convert human amount to raw units
    let amountRaw: bigint
    try {
      amountRaw = ethers.parseUnits(amount, tokenConfig.decimals)
    } catch {
      return reply.code(400).send({ error: `Invalid amount for ${tokenConfig.symbol}` })
    }

    if (amountRaw <= 0n) {
      return reply.code(400).send({ error: 'amount must be greater than zero' })
    }

    // 4. Policy check: agent must have this token configured
    const dbAllowance = await pool.query<{ allowance_amount: string }>(
      `SELECT allowance_amount FROM agent_allowances
       WHERE agent_id = $1 AND LOWER(token_address) = LOWER($2)`,
      [agent.id, tokenAddress],
    )
    if (dbAllowance.rows.length === 0) {
      return reply.code(403).send({
        error: `Agent is not configured for ${tokenConfig.symbol} transfers`,
      })
    }

    // 5. On-chain allowance check
    let onChainAllowance
    try {
      onChainAllowance = await getTokenAllowance(
        agent.chain_id,
        agent.safe_address,
        agent.delegate_address,
        tokenAddress,
      )
    } catch (err) {
      return reply.code(502).send({
        error: 'Failed to read on-chain allowance',
        details: err instanceof Error ? err.message : String(err),
      })
    }

    const effective = computeEffectiveAllowance(onChainAllowance)

    // 5a. Queue for approval when amount exceeds remaining on-chain allowance
    if (amountRaw > effective.remaining) {
      const remainingHuman = ethers.formatUnits(effective.remaining, tokenConfig.decimals)
      const approvalReason =
        `Exceeds remaining allowance (${amount} ${tokenConfig.symbol} requested, ${remainingHuman} available)`

      const approvalResult = await pool.query<{ id: string; status: string; expires_at: string }>(
        `INSERT INTO approval_requests (
          agent_id, user_id, safe_address, chain_id, token_symbol, token_address,
          to_address, amount_raw, amount_human, reason, status, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending',
          NOW() + interval '24 hours')
        RETURNING id, status, expires_at`,
        [
          agent.id,
          agent.user_id,
          agent.safe_address,
          agent.chain_id,
          tokenConfig.symbol,
          tokenAddress,
          recipient.toLowerCase(),
          amountRaw.toString(),
          amount,
          approvalReason,
        ],
      )

      const approval = approvalResult.rows[0]
      return reply.code(202).send({
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
      })
    }

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
      return reply.code(502).send({
        error: 'Failed to generate transfer hash',
        details: err instanceof Error ? err.message : String(err),
      })
    }

    // 7. Store the payment intent
    const result = await pool.query<SendPaymentIntentRow>(
      `INSERT INTO payment_intents (
        agent_id, user_id, safe_address, chain_id, token_symbol, token_address,
        to_address, amount_raw, amount_human, delegate_address,
        allowance_nonce, sign_hash, status, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pending_signature',
        NOW() + interval '10 minutes')
      RETURNING id, status, expires_at`,
      [
        agent.id,
        agent.user_id,
        agent.safe_address,
        agent.chain_id,
        tokenConfig.symbol,
        tokenAddress,
        recipient.toLowerCase(),
        amountRaw.toString(),
        amount,
        agent.delegate_address,
        onChainAllowance.nonce,
        signHash,
      ],
    )

    const intent = result.rows[0]

    return reply.code(201).send({
      payment_id: intent.id,
      status: intent.status,
      expires_at: intent.expires_at,
      asset,
      amount,
      recipient: recipient.toLowerCase(),
      sign_data: {
        hash: signHash,
        components: {
          safe: agent.safe_address,
          token: tokenAddress,
          to: recipient.toLowerCase(),
          amount: amountRaw.toString(),
          payment_token: ZERO_ADDRESS,
          payment: '0',
          nonce: onChainAllowance.nonce,
        },
        instructions:
          'Sign the hash with your delegate private key using raw ECDSA (not eth_sign). ' +
          'The signature must be 65 bytes: r (32) + s (32) + v (1), where v is 27 or 28.',
      },
    })
  })

  app.post<{ Body: AuthorizeBody }>('/authorize', async (request, reply) => {
    const agent = request.agent as AgentContext
    const { challenge, signature } = request.body

    const validationError = validateMppDemoChallenge(challenge)
    if (validationError) {
      return reply.code(400).send({ error: validationError })
    }

    const idempotencyKey = request.body.idempotencyKey
    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
      return reply.code(400).send({ error: 'idempotencyKey is required' })
    }

    const result = await authorizeMachinePayment({
      agent,
      rail: 'mpp_demo',
      resourceUrl: challenge.resource,
      payTo: challenge.recipient,
      merchantPayTo: challenge.recipient,
      amountAtomic: challenge.amount.atomic,
      asset: challenge.asset.address,
      chainId: challenge.network.chainId,
      description: challenge.description,
      challengeId: challenge.challengeId,
      idempotencyKey,
      metadata: {
        ...(challenge.metadata ?? {}),
        protocol: 'mpp',
        network: challenge.network.name,
        description: challenge.description,
      },
      signature,
      // TODO: add a per-rail rate limit before exposing machine payments beyond this internal demo.
    })

    return reply.code(result.statusCode).send(result.body)
  })

  app.post<{ Body: EvidenceBody }>('/evidence', async (request, reply) => {
    const agent = request.agent as AgentContext
    const body = request.body

    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ error: 'Evidence body is required' })
    }
    if (!body.paymentId || typeof body.paymentId !== 'string') {
      return reply.code(400).send({ error: 'paymentId is required' })
    }
    if (!body.rail || typeof body.rail !== 'string') {
      return reply.code(400).send({ error: 'rail is required' })
    }
    if (!body.txHash || typeof body.txHash !== 'string') {
      return reply.code(400).send({ error: 'txHash is required' })
    }
    if (body.resourceUrl !== undefined && typeof body.resourceUrl !== 'string') {
      return reply.code(400).send({ error: 'resourceUrl must be a string' })
    }
    if (
      body.paymentProofHeaderName !== undefined &&
      typeof body.paymentProofHeaderName !== 'string'
    ) {
      return reply.code(400).send({ error: 'paymentProofHeaderName must be a string' })
    }
    if (
      body.paymentProofHeader !== undefined &&
      typeof body.paymentProofHeader !== 'string'
    ) {
      return reply.code(400).send({ error: 'paymentProofHeader must be a string' })
    }
    if (
      body.protocolReceiptHeaderName !== undefined &&
      typeof body.protocolReceiptHeaderName !== 'string'
    ) {
      return reply.code(400).send({ error: 'protocolReceiptHeaderName must be a string' })
    }
    if (
      body.protocolReceiptHeader !== undefined &&
      typeof body.protocolReceiptHeader !== 'string'
    ) {
      return reply.code(400).send({ error: 'protocolReceiptHeader must be a string' })
    }
    if (
      body.challengePayload !== undefined &&
      !isPlainObject(body.challengePayload)
    ) {
      return reply.code(400).send({ error: 'challengePayload must be an object' })
    }
    if (
      body.selectedPayment !== undefined &&
      !isPlainObject(body.selectedPayment)
    ) {
      return reply.code(400).send({ error: 'selectedPayment must be an object' })
    }
    if (
      body.protocolReceiptPayload !== undefined &&
      !isPlainObject(body.protocolReceiptPayload)
    ) {
      return reply.code(400).send({ error: 'protocolReceiptPayload must be an object' })
    }

    try {
      const evidence = await attachMachinePaymentEvidence({
        agentId: agent.id,
        paymentId: body.paymentId,
        rail: body.rail,
        txHash: body.txHash,
        resourceUrl: body.resourceUrl,
        merchantStatus: body.merchantStatus,
        challengePayload: body.challengePayload,
        selectedPayment: body.selectedPayment,
        paymentProofHeaderName: body.paymentProofHeaderName,
        paymentProofHeader: body.paymentProofHeader,
        protocolReceiptHeaderName: body.protocolReceiptHeaderName,
        protocolReceiptHeader: body.protocolReceiptHeader,
        protocolReceiptPayload: body.protocolReceiptPayload,
      })

      if (!evidence) {
        return reply.code(404).send({ error: 'Payment not found' })
      }

      return reply.code(202).send({ evidence: mapEvidence(evidence) })
    } catch (err) {
      const marker = err instanceof Error ? err.message : String(err)
      if (marker === 'payment_not_confirmed') {
        return reply.code(409).send({ error: 'Evidence requires a confirmed payment' })
      }
      if (marker === 'tx_hash_mismatch') {
        return reply.code(409).send({ error: 'txHash does not match payment intent' })
      }
      if (marker === 'rail_mismatch') {
        return reply.code(409).send({ error: 'rail does not match payment intent' })
      }
      if (marker === 'resource_mismatch') {
        return reply.code(409).send({ error: 'resourceUrl does not match payment intent' })
      }
      if (marker === 'unsupported_rail') {
        return reply.code(400).send({ error: 'Unsupported evidence rail' })
      }
      if (marker === 'tx_hash_invalid') {
        return reply.code(400).send({ error: 'txHash must be a 0x-prefixed transaction hash' })
      }
      if (marker === 'merchant_status_invalid') {
        return reply.code(400).send({ error: 'merchantStatus must be an HTTP status code' })
      }

      throw err
    }
  })

  app.post<{ Body: ReconciliationEventBody }>('/reconciliation-events', async (request, reply) => {
    const agent = request.agent as AgentContext
    const {
      paymentId,
      rail,
      eventType,
      txHash,
      reason,
      details,
    } = request.body

    if (!paymentId || typeof paymentId !== 'string') {
      return reply.code(400).send({ error: 'paymentId is required' })
    }
    if (!rail || typeof rail !== 'string') {
      return reply.code(400).send({ error: 'rail is required' })
    }
    if (!eventType || !RECONCILIATION_EVENT_TYPES.has(eventType)) {
      return reply.code(400).send({ error: 'Unsupported reconciliation event type' })
    }
    if (txHash !== undefined && (
      typeof txHash !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(txHash)
    )) {
      return reply.code(400).send({ error: 'txHash must be a 0x-prefixed transaction hash' })
    }
    if (reason !== undefined && typeof reason !== 'string') {
      return reply.code(400).send({ error: 'reason must be a string' })
    }
    if (details !== undefined && (
      !details ||
      typeof details !== 'object' ||
      Array.isArray(details)
    )) {
      return reply.code(400).send({ error: 'details must be an object' })
    }

    const paymentResult = await pool.query<ReconciliationPaymentRow>(
      `SELECT 'payment_intent'::TEXT AS kind,
              id, user_id, tx_hash, status, payment_rail, source,
              payment_resource_url, x402_resource_url,
              merchant_address, x402_merchant_address,
              machine_challenge_id, machine_idempotency_key, x402_idempotency_key
       FROM payment_intents
       WHERE id = $1 AND agent_id = $2
       LIMIT 1`,
      [paymentId, agent.id],
    )
    let payment = paymentResult.rows[0]
    if (!payment) {
      const approvalResult = await pool.query<ReconciliationPaymentRow>(
        `SELECT 'approval_request'::TEXT AS kind,
                id, user_id, tx_hash, status, payment_rail, source,
                payment_resource_url, x402_resource_url,
                merchant_address, NULL::TEXT AS x402_merchant_address,
                machine_challenge_id, machine_idempotency_key, NULL::TEXT AS x402_idempotency_key
         FROM approval_requests
         WHERE id = $1 AND agent_id = $2
         LIMIT 1`,
        [paymentId, agent.id],
      )
      payment = approvalResult.rows[0]
    }
    if (!payment) {
      return reply.code(404).send({ error: 'Payment not found' })
    }

    const expectedStatus = payment.kind === 'approval_request' ? 'executed' : 'confirmed'
    if (payment.status !== expectedStatus || !payment.tx_hash) {
      return reply.code(409).send({
        error: 'Reconciliation events require a confirmed payment',
        status: payment.status,
      })
    }

    if (txHash && payment.tx_hash.toLowerCase() !== txHash.toLowerCase()) {
      return reply.code(409).send({ error: 'txHash does not match payment intent' })
    }

    const paymentRail = payment.payment_rail ?? payment.source
    if (paymentRail !== rail) {
      return reply.code(409).send({ error: 'rail does not match payment intent' })
    }

    const paymentIntentId = payment.kind === 'payment_intent' ? payment.id : null
    const approvalRequestId = payment.kind === 'approval_request' ? payment.id : null
    const conflictColumn = payment.kind === 'approval_request' ? 'approval_request_id' : 'payment_intent_id'

    const result = await pool.query<ReconciliationEventRow>(
      `INSERT INTO machine_payment_reconciliation_events (
        agent_id, user_id, payment_intent_id, approval_request_id, rail, event_type, tx_hash,
        resource_url, merchant_address, machine_challenge_id, machine_idempotency_key,
        reason, details
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (${conflictColumn}, event_type)
        WHERE ${conflictColumn} IS NOT NULL
      DO UPDATE SET
        tx_hash = EXCLUDED.tx_hash,
        resource_url = EXCLUDED.resource_url,
        merchant_address = EXCLUDED.merchant_address,
        machine_challenge_id = EXCLUDED.machine_challenge_id,
        machine_idempotency_key = EXCLUDED.machine_idempotency_key,
        reason = EXCLUDED.reason,
        details = EXCLUDED.details,
        status = 'open',
        updated_at = NOW()
      WHERE machine_payment_reconciliation_events.status <> 'resolved'
      RETURNING id, status, created_at`,
      [
        agent.id,
        payment.user_id,
        paymentIntentId,
        approvalRequestId,
        rail,
        eventType,
        payment.tx_hash.toLowerCase(),
        payment.payment_resource_url ?? payment.x402_resource_url,
        payment.merchant_address ?? payment.x402_merchant_address,
        payment.machine_challenge_id,
        payment.machine_idempotency_key ?? payment.x402_idempotency_key,
        reason ?? null,
        details ? JSON.stringify(details) : null,
      ],
    )

    let event = result.rows[0]
    if (!event) {
      const existingResult = await pool.query<ReconciliationEventRow>(
        `SELECT id, status, created_at
         FROM machine_payment_reconciliation_events
         WHERE ${conflictColumn} = $1
           AND agent_id = $2
           AND event_type = $3
         LIMIT 1`,
        [payment.id, agent.id, eventType],
      )
      event = existingResult.rows[0]
    }
    if (!event) throw new Error('reconciliation_event_conflict_not_found')

    return reply.code(202).send({
      event_id: event.id,
      status: event.status,
      payment_id: payment.id,
      rail,
      event_type: eventType,
      created_at: event.created_at,
    })
  })
}
