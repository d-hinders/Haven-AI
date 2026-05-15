import { FastifyInstance } from 'fastify'
import pool from '../db.js'
import { agentAuthMiddleware, type AgentContext } from '../middleware/agentAuth.js'
import {
  authorizeMachinePayment,
  type MachinePaymentRail,
} from '../lib/machine-payments.js'

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

interface ReconciliationPaymentRow {
  id: string
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

const RECONCILIATION_EVENT_TYPES = new Set([
  'merchant_retry_rejected_after_payment',
])

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
  if (new Date(challenge.expiresAt).getTime() <= Date.now()) {
    return 'MPP demo challenge has expired'
  }
  return null
}

export default async function machinePaymentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', agentAuthMiddleware)

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
      metadata: challenge.metadata,
      signature,
      // TODO: add a per-rail rate limit before exposing machine payments beyond this internal demo.
    })

    return reply.code(result.statusCode).send(result.body)
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
      `SELECT id, user_id, tx_hash, status, payment_rail, source,
              payment_resource_url, x402_resource_url,
              merchant_address, x402_merchant_address,
              machine_challenge_id, machine_idempotency_key, x402_idempotency_key
       FROM payment_intents
       WHERE id = $1 AND agent_id = $2
       LIMIT 1`,
      [paymentId, agent.id],
    )
    const payment = paymentResult.rows[0]
    if (!payment) {
      return reply.code(404).send({ error: 'Payment intent not found' })
    }

    if (payment.status !== 'confirmed' || !payment.tx_hash) {
      return reply.code(409).send({
        error: 'Reconciliation events require a confirmed payment intent',
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

    const result = await pool.query<{ id: string; status: string; created_at: string }>(
      `INSERT INTO machine_payment_reconciliation_events (
        agent_id, user_id, payment_intent_id, rail, event_type, tx_hash,
        resource_url, merchant_address, machine_challenge_id, machine_idempotency_key,
        reason, details
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (payment_intent_id, event_type)
        WHERE payment_intent_id IS NOT NULL
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
      RETURNING id, status, created_at`,
      [
        agent.id,
        payment.user_id,
        payment.id,
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

    const event = result.rows[0]
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
