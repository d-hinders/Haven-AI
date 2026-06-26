import { FastifyInstance } from 'fastify'
import { ethers } from 'ethers'
import pool from '../db.js'
import { agentAuthMiddleware, type AgentContext } from '../middleware/agentAuth.js'
import {
  authorizeMachinePayment,
  type MachinePaymentRail,
} from '../lib/machine-payments.js'
import { getAgentPaymentStatus, agentPaymentStatusHttpCode } from '../lib/agent-payment-status.js'
import { isAddress as isValidAddress } from '../lib/address.js'
import {
  attachMachinePaymentEvidence,
  type MachinePaymentEvidenceRow,
} from '../lib/machine-payment-evidence.js'
import {
  getTokenAllowance,
  getTokenBalance,
  getLatestBlockTimeSec,
  computeEffectiveAllowance,
  generateTransferHash,
} from '../lib/allowance-module.js'
import { getChain, getExplorerUrl } from '../lib/chains.js'
import {
  SWEEP_BASE_CHAIN_ID,
  sweepUsdcAddress,
  type SweepAuthorization,
} from '@haven_ai/sdk'
import {
  buildSweepAuthorization,
  signSweepExpectedContext,
  recoverSweepSigner,
  relaySweepAuthorization,
} from '../lib/sweep.js'
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

function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase())
}

const USDC_DECIMALS = 6

function sweepResultBody(fields: {
  txHash: string
  valueAtomic: string
  from: string
  to: string
  chainId: number
  idempotent?: boolean
}) {
  return {
    tx_hash: fields.txHash,
    asset: 'USDC',
    amount: ethers.formatUnits(BigInt(fields.valueAtomic), USDC_DECIMALS),
    amount_atomic: fields.valueAtomic,
    from_address: fields.from,
    to_address: fields.to,
    chain_id: fields.chainId,
    explorer_url: getExplorerUrl(fields.chainId, 'tx', fields.txHash),
    ...(fields.idempotent ? { idempotent_replay: true } : {}),
  }
}

interface SweepSubmitBody {
  authorization?: Partial<SweepAuthorization>
  signature?: string
}

interface DelegateSweepRow {
  id: string
  chain_id: number
  token_address: string
  from_address: string
  to_address: string
  value_atomic: string
  valid_after: string
  valid_before: string
  nonce: string
  status: string
  tx_hash: string | null
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

const PG_UNIQUE_VIOLATION = '23505'

const SEND_SIGN_INSTRUCTIONS =
  'Sign the hash with your delegate private key using raw ECDSA (not eth_sign). ' +
  'The signature must be 65 bytes: r (32) + s (32) + v (1), where v is 27 or 28.'

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
  const intent = await pool.query<{
    id: string
    status: string
    expires_at: string
    token_address: string
    to_address: string
    amount_raw: string
    amount_human: string
    allowance_nonce: number
    sign_hash: string
  }>(
    `SELECT id, status, expires_at, token_address, to_address,
            amount_raw, amount_human, allowance_nonce, sign_hash
     FROM payment_intents
     WHERE agent_id = $1 AND send_idempotency_key = $2
       AND status NOT IN ('failed', 'expired')
     ORDER BY created_at DESC
     LIMIT 1`,
    [agent.id, idempotencyKey],
  )
  const pi = intent.rows[0]
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

  const approval = await pool.query<{
    id: string
    status: string
    expires_at: string
    token_symbol: string
    amount_human: string
  }>(
    `SELECT id, status, expires_at, token_symbol, amount_human
     FROM approval_requests
     WHERE agent_id = $1 AND send_idempotency_key = $2
       AND status NOT IN ('rejected', 'expired')
     ORDER BY created_at DESC
     LIMIT 1`,
    [agent.id, idempotencyKey],
  )
  const ar = approval.rows[0]
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
        const [onchain, chainTimeSec] = await Promise.all([
          getTokenAllowance(
            agent.chain_id,
            agent.safe_address,
            agent.delegate_address,
            row.token_address,
          ),
          getLatestBlockTimeSec(agent.chain_id),
        ])
        const effective = computeEffectiveAllowance(onchain, chainTimeSec)

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

    let idempotencyKey: string | undefined
    if (request.body.idempotency_key !== undefined) {
      const key = request.body.idempotency_key
      if (typeof key !== 'string' || key.length < 1 || key.length > 128) {
        return reply.code(400).send({ error: 'idempotency_key must be a string of 1–128 characters' })
      }
      idempotencyKey = key
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

    // Idempotency replay: a retried send returns the original intent/approval
    // rather than minting a second one. Checked before the on-chain read so a
    // replay skips the RPC round trip entirely (see migration 020).
    if (idempotencyKey) {
      const replay = await findExistingSend(agent, idempotencyKey, asset)
      if (replay) return reply.code(replay.code).send(replay.body)
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

    // 5. On-chain allowance check. Read the allowance and chain time together:
    // the reset decision must key off chain `block.timestamp`, not wall-clock.
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
      return reply.code(502).send({
        error: 'Failed to read on-chain allowance',
        details: err instanceof Error ? err.message : String(err),
      })
    }

    const effective = computeEffectiveAllowance(onChainAllowance, chainTimeSec)

    // 5a. Queue for approval when amount exceeds remaining on-chain allowance
    if (amountRaw > effective.remaining) {
      const remainingHuman = ethers.formatUnits(effective.remaining, tokenConfig.decimals)
      const approvalReason =
        `Exceeds remaining allowance (${amount} ${tokenConfig.symbol} requested, ${remainingHuman} available)`

      let approvalResult
      try {
        approvalResult = await pool.query<{ id: string; status: string; expires_at: string }>(
          `INSERT INTO approval_requests (
            agent_id, user_id, safe_address, chain_id, token_symbol, token_address,
            to_address, amount_raw, amount_human, reason, send_idempotency_key, status, expires_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending',
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
            idempotencyKey ?? null,
          ],
        )
      } catch (err) {
        // Lost an idempotency-key race with a concurrent send — replay the winner.
        if (idempotencyKey && (err as { code?: string }).code === PG_UNIQUE_VIOLATION) {
          const replay = await findExistingSend(agent, idempotencyKey, asset)
          if (replay) return reply.code(replay.code).send(replay.body)
        }
        throw err
      }

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
    let result
    try {
      result = await pool.query<SendPaymentIntentRow>(
        `INSERT INTO payment_intents (
          agent_id, user_id, safe_address, chain_id, token_symbol, token_address,
          to_address, amount_raw, amount_human, delegate_address,
          allowance_nonce, sign_hash, send_idempotency_key, status, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'pending_signature',
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
          idempotencyKey ?? null,
        ],
      )
    } catch (err) {
      // Lost an idempotency-key race with a concurrent send — replay the winner.
      if (idempotencyKey && (err as { code?: string }).code === PG_UNIQUE_VIOLATION) {
        const replay = await findExistingSend(agent, idempotencyKey, asset)
        if (replay) return reply.code(replay.code).send(replay.body)
      }
      throw err
    }

    const intent = result.rows[0]

    return reply.code(201).send({
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

  // ── POST /sweep/prepare — build a gasless USDC sweep authorization ──────────
  //
  // Reads the delegate's stranded USDC and returns an EIP-3009
  // TransferWithAuthorization (delegate → the agent's own Safe) plus Haven's
  // binding signature. The edge signer signs it; /sweep/submit relays it. The
  // delegate never needs ETH and the hosted server never holds the key.
  app.post('/sweep/prepare', async (request, reply) => {
    const agent = request.agent as AgentContext

    if (agent.chain_id !== SWEEP_BASE_CHAIN_ID) {
      return reply.code(422).send({
        error: `Sweep is only supported on Base (chainId ${SWEEP_BASE_CHAIN_ID}). Agent chain is ${agent.chain_id}.`,
      })
    }
    if (!agent.delegate_address || !agent.safe_address) {
      return reply.code(422).send({ error: 'Agent is missing a delegate or Safe address.' })
    }

    const token = sweepUsdcAddress(agent.chain_id)

    let balance: bigint
    try {
      balance = await getTokenBalance(agent.chain_id, agent.delegate_address, token)
    } catch (err) {
      return reply.code(502).send({
        error: 'Failed to read delegate USDC balance',
        details: err instanceof Error ? err.message : String(err),
      })
    }

    if (balance <= 0n) {
      return reply.code(200).send({
        nothing_stranded: true,
        asset: 'USDC',
        chain_id: agent.chain_id,
        message: 'No stranded USDC on the delegate wallet — nothing to recover.',
      })
    }

    const authorization = buildSweepAuthorization({
      delegateAddress: agent.delegate_address,
      safeAddress: agent.safe_address,
      chainId: agent.chain_id,
      valueAtomic: balance,
    })

    await pool.query(
      `INSERT INTO delegate_sweeps (
        agent_id, user_id, chain_id, token_address, from_address, to_address,
        value_atomic, valid_after, valid_before, nonce, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'prepared')`,
      [
        agent.id,
        agent.user_id,
        authorization.chainId,
        authorization.token.toLowerCase(),
        authorization.from.toLowerCase(),
        authorization.to.toLowerCase(),
        authorization.value,
        authorization.validAfter,
        authorization.validBefore,
        authorization.nonce.toLowerCase(),
      ],
    )

    const expectedAuth = await signSweepExpectedContext(authorization)

    return reply.code(201).send({
      authorization,
      expected_auth: expectedAuth,
      asset: 'USDC',
      amount: ethers.formatUnits(balance, USDC_DECIMALS),
      amount_atomic: balance.toString(),
      chain_id: agent.chain_id,
      sign_instructions:
        'Sign `authorization` with the local signer tool haven_sign_sweep_delegate ' +
        '(pass authorization and expected_auth), then POST the returned signature to ' +
        '/machine-payments/sweep/submit with the same authorization.',
    })
  })

  // ── POST /sweep/submit — relay a signed sweep authorization ─────────────────
  //
  // Trusts nothing from the client payload: the authorization is re-derived from
  // the prepared row, the delegate signature is verified off-chain, and the
  // balance is re-read before the relayer spends gas.
  app.post<{ Body: SweepSubmitBody }>('/sweep/submit', async (request, reply) => {
    const agent = request.agent as AgentContext
    const body = request.body ?? {}
    const signature = body.signature
    const nonce = body.authorization?.nonce

    if (!signature || typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) {
      return reply.code(400).send({ error: 'signature must be a 0x-prefixed hex string' })
    }
    if (!nonce || typeof nonce !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(nonce)) {
      return reply.code(400).send({ error: 'authorization.nonce must be a 0x-prefixed 32-byte hex string' })
    }

    const rowResult = await pool.query<DelegateSweepRow>(
      `SELECT id, chain_id, token_address, from_address, to_address, value_atomic,
              valid_after, valid_before, nonce, status, tx_hash
       FROM delegate_sweeps
       WHERE nonce = $1 AND agent_id = $2
       LIMIT 1`,
      [nonce.toLowerCase(), agent.id],
    )
    const row = rowResult.rows[0]
    if (!row) {
      return reply.code(404).send({ error: 'No prepared sweep found for this nonce. Call /sweep/prepare first.' })
    }

    // Idempotent replay: a retried submit of an already-relayed sweep returns the
    // original tx rather than relaying (and reverting) a second time.
    if (row.status === 'submitted' && row.tx_hash) {
      return reply.code(200).send(
        sweepResultBody({
          txHash: row.tx_hash,
          valueAtomic: row.value_atomic,
          from: row.from_address,
          to: row.to_address,
          chainId: row.chain_id,
          idempotent: true,
        }),
      )
    }
    if (row.status !== 'prepared') {
      return reply.code(409).send({ error: `Sweep is ${row.status}, expected prepared.`, status: row.status })
    }
    if (Number(row.valid_before) <= Math.floor(Date.now() / 1000)) {
      await pool.query(
        `UPDATE delegate_sweeps SET status = 'expired' WHERE id = $1 AND status = 'prepared'`,
        [row.id],
      )
      return reply.code(409).send({ error: 'Sweep authorization expired. Call /sweep/prepare again.' })
    }

    // Re-derive the authorization from server state — never from the client.
    const expected: SweepAuthorization = {
      from: row.from_address,
      to: row.to_address,
      value: row.value_atomic,
      validAfter: String(row.valid_after),
      validBefore: String(row.valid_before),
      nonce: row.nonce,
      token: row.token_address,
      chainId: row.chain_id,
    }

    if (!sameAddress(expected.from, agent.delegate_address)) {
      return reply.code(409).send({ error: 'Prepared sweep `from` no longer matches the agent delegate.' })
    }
    if (!sameAddress(expected.to, agent.safe_address)) {
      return reply.code(409).send({ error: 'Prepared sweep `to` no longer matches the agent Safe.' })
    }

    let recovered: string
    try {
      recovered = recoverSweepSigner(expected, signature)
    } catch (err) {
      return reply.code(400).send({
        error: 'Invalid signature format',
        details: err instanceof Error ? err.message : String(err),
      })
    }
    if (!sameAddress(recovered, agent.delegate_address)) {
      return reply.code(403).send({
        error: 'Signature does not recover the registered delegate address',
        expected: agent.delegate_address,
        recovered,
      })
    }

    // Re-read balance: an exact-value transferWithAuthorization reverts if the
    // delegate no longer holds at least `value` (e.g. a concurrent payment).
    let balance: bigint
    try {
      balance = await getTokenBalance(expected.chainId, expected.from, expected.token)
    } catch (err) {
      return reply.code(502).send({
        error: 'Failed to re-read delegate USDC balance',
        details: err instanceof Error ? err.message : String(err),
      })
    }
    if (balance < BigInt(expected.value)) {
      return reply.code(409).send({
        error: 'Delegate balance changed since prepare; re-run /sweep/prepare.',
        error_code: 'balance_changed',
        expected_atomic: expected.value,
        current_atomic: balance.toString(),
      })
    }

    // Atomically claim the prepared sweep before relaying. Two concurrent submits
    // can otherwise both read 'prepared' and both broadcast — the second tx
    // reverts on the spent EIP-3009 nonce, and if its failure write lands first
    // it records a successful recovery as 'failed' and breaks replay. The loser
    // of this compare-and-swap re-reads and replays instead of relaying.
    const claim = await pool.query<{ id: string }>(
      `UPDATE delegate_sweeps SET status = 'submitting'
       WHERE id = $1 AND status = 'prepared'
       RETURNING id`,
      [row.id],
    )
    if (claim.rows.length === 0) {
      const currentResult = await pool.query<DelegateSweepRow>(
        `SELECT id, chain_id, token_address, from_address, to_address, value_atomic,
                valid_after, valid_before, nonce, status, tx_hash
         FROM delegate_sweeps WHERE id = $1 LIMIT 1`,
        [row.id],
      )
      const current = currentResult.rows[0]
      if (current?.status === 'submitted' && current.tx_hash) {
        return reply.code(200).send(
          sweepResultBody({
            txHash: current.tx_hash,
            valueAtomic: current.value_atomic,
            from: current.from_address,
            to: current.to_address,
            chainId: current.chain_id,
            idempotent: true,
          }),
        )
      }
      return reply.code(409).send({
        error: 'Sweep is already being submitted.',
        status: current?.status ?? 'unknown',
      })
    }

    let txHash: string
    try {
      ;({ txHash } = await relaySweepAuthorization(expected, signature))
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      await pool.query(
        `UPDATE delegate_sweeps SET status = 'failed', error_message = $1 WHERE id = $2 AND status = 'submitting'`,
        [errorMsg, row.id],
      )
      return reply.code(502).send({ error: 'Sweep relay failed', details: errorMsg })
    }

    await pool.query(
      `UPDATE delegate_sweeps SET status = 'submitted', tx_hash = $1, submitted_at = NOW()
       WHERE id = $2 AND status = 'submitting'`,
      [txHash, row.id],
    )

    // Recovering the stranded funds resolves the open stranded-funds reconciliation.
    await pool.query(
      `UPDATE machine_payment_reconciliation_events
       SET status = 'resolved', updated_at = NOW()
       WHERE agent_id = $1
         AND status <> 'resolved'
         AND event_type = 'merchant_retry_rejected_after_payment'`,
      [agent.id],
    )

    return reply.code(200).send(
      sweepResultBody({
        txHash,
        valueAtomic: expected.value,
        from: expected.from,
        to: expected.to,
        chainId: expected.chainId,
      }),
    )
  })
}
