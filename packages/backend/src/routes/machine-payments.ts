import { FastifyInstance } from 'fastify'
import { agentAuthMiddleware, type AgentContext } from '../middleware/agentAuth.js'
import { moneyPathRateLimit } from '../middleware/rate-limit.js'
import { getAgentPaymentStatus } from '../modules/payments/index.js'
import { agentExecutionRailLabel } from '../rails/execution-rail.js'
import { computeHybridAccountAddress } from '../rails/hybrid-provisioning.js'
import { isAddress as isValidAddress } from '@haven_ai/core'
import {
  handleGetAllowances,
  handleReconciliationEvent,
  handleSend,
  attachEvidenceHandler,
  handleMerchantReceiptCapture,
  listReceipts,
  mppDemoRetired,
  prepareSweep,
  submitSweep,
  RECONCILIATION_EVENT_TYPES,
  SUPPORTED_ASSETS,
  type AuthorizeBody,
  type EvidenceBody,
  type ReconciliationEventBody,
  type SendAsset,
  type SendBody,
  type SweepSubmitBody,
} from '../modules/mpp/index.js'

// Route handlers only: request validation, auth middleware wiring, rate-limit
// config, and response serialization. Everything else — authorize
// orchestration, the send flow, sweep prepare/submit orchestration,
// evidence/receipt assembly, and the rail-aware allowances read — lives in
// `src/modules/mpp/` (#997, epic #980 M4). See that module's `index.ts` for
// the public surface and the boundary rationale.

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export default async function machinePaymentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', agentAuthMiddleware)

  app.get('/agent', async (request) => {
    const agent = request.agent as AgentContext

    // #1472: the DELEGATE ACCOUNT is what an erc7710 merchant sees as the
    // header's `delegator` and may print as "payer" — the #1454 live run
    // proved a receipt naming an address no API surface could map back to a
    // Haven agent. It is a pure derivation (counterfactual Hybrid address of
    // the signing EOA), so exposing it costs a computation, not a column. Null
    // on the legacy rail, where no such account exists. A failed derivation
    // degrades to null rather than failing the whole identity read — this
    // field is reconciliation metadata, not authority.
    let delegateAccountAddress: string | null = null
    if (agentExecutionRailLabel(agent.execution_rail) === 'delegation') {
      try {
        delegateAccountAddress = await computeHybridAccountAddress(agent.chain_id, {
          ownerAddress: agent.delegate_address as `0x${string}`,
        })
      } catch {
        delegateAccountAddress = null
      }
    }

    return {
      id: agent.id,
      name: agent.name,
      status: agent.status,
      safe_address: agent.safe_address,
      delegate_address: agent.delegate_address,
      delegate_account_address: delegateAccountAddress,
      chain_id: agent.chain_id,
      // #1306: which on-chain policy primitive gates this agent's spend —
      // reporting only, same two-value bucketing handleGetAllowances already
      // branches on below.
      execution_rail: agentExecutionRailLabel(agent.execution_rail),
    }
  })

  app.get('/allowances', async (request, reply) => {
    const agent = request.agent as AgentContext
    const result = await handleGetAllowances(agent)
    return reply.code(result.statusCode).send(result.body)
  })

  app.get<{ Querystring: { limit?: string } }>('/receipts', async (request, reply) => {
    const agent = request.agent as AgentContext
    const parsedLimit = request.query.limit ? Number(request.query.limit) : 25
    const limit = Number.isInteger(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 100)
      : 25

    const receipts = await listReceipts(agent.id, limit)
    return reply.send({ receipts })
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

  app.post<{ Body: SendBody }>('/send', { config: moneyPathRateLimit }, async (request, reply) => {
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

    const result = await handleSend(agent, asset as SendAsset, recipient, amount, idempotencyKey)
    return reply.code(result.statusCode).send(result.body)
  })

  // #1328: the legacy internal MPP demo flow is retired outright — fail
  // closed, nothing read or written beyond the agent-auth lookup the
  // `onRequest` hook already did. `AuthorizeBody` stays as the route's
  // request type for OpenAPI/documentation purposes; the body is never
  // inspected. Agents are directed to the deployed x402 merchant flow.
  app.post<{ Body: AuthorizeBody }>('/authorize', { config: moneyPathRateLimit }, async (_request, reply) => {
    const refusal = mppDemoRetired()
    return reply.code(refusal.statusCode).send(refusal.body)
  })

  app.post<{ Body: EvidenceBody }>('/evidence', { config: moneyPathRateLimit }, async (request, reply) => {
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

    const result = await attachEvidenceHandler(agent.id, body)
    return reply.code(result.statusCode).send(result.body)
  })

  // ── POST /:id/merchant-receipt — capture the merchant's own receipt (#956) ──
  app.post<{ Params: { id: string }; Body: { url?: string; json?: unknown } }>(
    '/:id/merchant-receipt',
    { config: moneyPathRateLimit },
    async (request, reply) => {
      const agent = request.agent as AgentContext
      const { url, json } = request.body ?? {}
      const result = await handleMerchantReceiptCapture(agent.id, request.params.id, url, json)
      return reply.code(result.statusCode).send(result.body)
    },
  )

  app.post<{ Body: ReconciliationEventBody }>('/reconciliation-events', { config: moneyPathRateLimit }, async (request, reply) => {
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

    const result = await handleReconciliationEvent(
      agent.id,
      paymentId,
      rail,
      eventType,
      txHash,
      reason,
      details,
    )
    return reply.code(result.statusCode).send(result.body)
  })

  // ── POST /sweep/prepare — build a gasless USDC sweep authorization ──────────
  app.post('/sweep/prepare', { config: moneyPathRateLimit }, async (request, reply) => {
    const agent = request.agent as AgentContext
    const result = await prepareSweep(agent)
    return reply.code(result.statusCode).send(result.body)
  })

  // ── POST /sweep/submit — relay a signed sweep authorization ─────────────────
  app.post<{ Body: SweepSubmitBody }>('/sweep/submit', { config: moneyPathRateLimit }, async (request, reply) => {
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

    const result = await submitSweep(agent, nonce, signature)
    return reply.code(result.statusCode).send(result.body)
  })
}
