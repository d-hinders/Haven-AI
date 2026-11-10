import { FastifyInstance } from 'fastify'
import {
  expireOverdueIntentsForAgent,
  expirePendingIntentReturningStatus,
  findIntentForAgent,
  listIntentsForAgent,
} from '../infra/repositories/payment-intents.js'
// #4760 (epic #4759 slice 1): the `POST /` create flow lives in the payments
// module now. The route reads the request, calls `createPayment`, and sends
// the decided response it returns — nothing else. `resolveToken` moved with
// it (the module cannot import the route layer, #994) and comes back through
// the same barrel for `GET /:id`.
// #4761 (epic #4759 slice 2): the `POST /:id/sign` submit state machine lives
// in `modules/payments/sign-payment.ts` for the same reason — the route reads
// the request, calls `signPayment`, and sends the decided response it returns.
import {
  boundFailureMessage,
  createPayment,
  getAgentPaymentResumeState,
  getDirectSignContext,
  getPaymentReceipt,
  resolveToken,
  signPayment,
  verifyPaymentReceipt,
  type CreatePaymentBody,
  type SignPaymentBody,
} from '../modules/payments/index.js'
import { agentAuthMiddleware, type AgentContext } from '../middleware/agentAuth.js'
import { moneyPathRateLimit } from '../middleware/rate-limit.js'
import { getExplorerUrl } from '../domain/chains.js'
import { formatTokenAmount } from '@haven_ai/core'
// Evidence recording moved into the mpp module (#997); routes/payments.ts
// needs it after a delegation-rail send confirms, so it imports the module's
// public entry point (same pattern as routes/x402.ts -> modules/x402/).
// #4761: these two are handed to `signPayment` as arguments — the mpp barrel
// imports the payments barrel, so a payments module file importing it back
// would close a payments → mpp → payments cycle.
import { tryRecordMachinePaymentEvidenceBaseById, mppDemoRetired } from '../modules/mpp/index.js'
import { quoteFee } from '../modules/fee/index.js'
import { toCanonicalAddress } from '../modules/transactions/index.js'

/**
 * Surface the platform fee on a payment result so it's never silently collected
 * (#386 acceptance). Dark while the fee module is disabled — `amount` is "0" and
 * `applied` is false — but the field is always present so agents see it the
 * moment fees go live.
 */
function buildResponseFee(intent: PaymentIntentRow) {
  let gross = 0n
  try { gross = BigInt(intent.amount_raw) } catch { gross = 0n }
  const quote = quoteFee({
    paymentId: intent.id,
    rail: 'direct',
    grossAtomic: gross,
    token: intent.token_symbol,
    userId: intent.user_id,
  })
  const tokenConfig = resolveToken(intent.chain_id, intent.token_symbol)
  return {
    amount: quote.feeAtomic === 0n ? '0' : formatTokenAmount(quote.feeAtomic, tokenConfig?.decimals ?? 18),
    token: quote.feeToken,
    basis_points: quote.basisPoints,
    applied: !quote.isZero,
  }
}

// ── Types ─────────────────────────────────────────────────────────

interface PaymentIntentRow {
  id: string
  agent_id: string
  user_id: string
  account_address: string
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
  created_at: string
  signed_at: string | null
  submitted_at: string | null
  confirmed_at: string | null
  expires_at: string
  /** Execution rail pinned at authorize time; null = legacy AllowanceModule (#745). */
  execution_rail?: string | null
  /** Which delegation authorized a delegation-rail intent (#829). */
  delegation_hash?: string | null
  /** Serialized prepared redemption UserOperation for delegation intents. */
  prepared_user_op?: unknown
}

// ── Routes ────────────────────────────────────────────────────────
export default async function paymentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', agentAuthMiddleware)

  // ── POST / — Create payment intent ──────────────────────

  app.post<{ Body: CreatePaymentBody }>('/', { config: moneyPathRateLimit }, async (request, reply) => {
    // #4760 (epic #4759 slice 1): the create flow lives in
    // `modules/payments/create-payment.ts`. The route reads the request, calls
    // the module, and sends the decided response it returns — the module never
    // sees a Fastify object, so a test can call it without `app.inject`.
    const decided = await createPayment({
      agent: request.agent as AgentContext,
      body: request.body,
      log: request.log,
    })
    return reply.code(decided.code).send(decided.body)
  })

  // ── POST /:id/sign — Sign and execute ───────────────────

  app.post<{ Params: { id: string }; Body: SignPaymentBody }>(
    '/:id/sign',
    { config: moneyPathRateLimit },
    async (request, reply) => {
      // #4761 (epic #4759 slice 2): the submit state machine lives in
      // `modules/payments/sign-payment.ts`. The route reads the request, calls
      // the module, and sends the decided response it returns — the module
      // never sees a Fastify object, so a test can call it without
      // `app.inject`. The two mpp collaborators are handed in here because the
      // mpp barrel imports the payments barrel (see the module header).
      const decided = await signPayment({
        agent: request.agent as AgentContext,
        paymentId: request.params.id,
        signature: request.body.signature,
        log: request.log,
        mppDemoRetired,
        recordMachinePaymentEvidence: tryRecordMachinePaymentEvidenceBaseById,
      })
      return reply.code(decided.code).send(decided.body)
    },
  )

  // ── GET /:id/sign-context — byte-free signing handoff for a DIRECT
  // delegation-rail intent (#3271, the direct sibling of #1263's x402 route)
  // ──────────────────────────────────────────────────────────────────────
  // Read-only: re-serves the stored delegation-rail signing payload so the
  // LOCAL SIGNER can fetch exact bytes by payment_id instead of the agent
  // re-emitting a multi-KB EIP-712 payload by hand. `GET /x402/:id/
  // sign-context` keeps answering its 409 for a direct payment_id with the
  // same error_code and the same typed_data_b64 instruction (it only gains a
  // pointer to this route), and this route 409s an x402/MPP intent the same
  // way — old signers still get the refusal they key on. All checks and the rebuild live in the module
  // (`getDirectSignContext`).
  app.get<{ Params: { id: string } }>(
    '/:id/sign-context',
    { config: moneyPathRateLimit },
    async (request, reply) => {
      const agent = request.agent as AgentContext
      const result = await getDirectSignContext(agent, request.params.id)
      return reply.code(result.code).send(result.body)
    },
  )

  // ── GET /:id/resume_state — Rehydrate protocol resume state ─────────

  /**
   * GET /payments/:id/resume_state
   *
   * Reconstructs the serializable x402/MPP resume-state bundle for a payment
   * intent or approval request owned by this agent. This returns stored payment
   * context only; it never signs, executes, relays, or expands authority.
   */
  app.get<{ Params: { id: string } }>('/:id/resume_state', async (request, reply) => {
    const agent = request.agent as AgentContext
    const { id } = request.params
    const result = await getAgentPaymentResumeState(agent, id)

    if (!result.status) {
      return reply.code(404).send({ error: 'Payment or approval request not found' })
    }

    if (result.status.status === 'expired') {
      return reply.code(410).send({
        error: result.error ?? 'Payment approval expired and cannot be resumed',
        error_code: result.errorCode,
        payment_id: result.status.payment_id,
        rail: result.status.rail,
        status: result.status.status,
      })
    }

    if (!result.resumeState) {
      // 422 instead of 409 specifically for "this rail is documented as a
      // valid AgentPaymentRail value but the resume-state surface doesn't
      // currently rehydrate it." Generic 409 stays for other "cannot resume
      // right now" cases (incomplete context, wrong status).
      const code = result.errorCode === 'rail_not_resumable' ? 422 : 409
      return reply.code(code).send({
        error: result.error ?? 'Payment cannot be resumed',
        error_code: result.errorCode,
        payment_id: result.status.payment_id,
        rail: result.status.rail,
        status: result.status.status,
      })
    }

    return reply.send(result.resumeState)
  })

  // ── GET /:id — Payment status ───────────────────────────

  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const agent = request.agent as AgentContext
    const { id } = request.params

    const intent = await findIntentForAgent(id, agent.id)

    if (!intent) {
      return reply.code(404).send({ error: 'Payment intent not found' })
    }

    let status = intent.status

    if (status === 'pending_signature' && new Date(intent.expires_at) < new Date()) {
      const expiredStatus = await expirePendingIntentReturningStatus(id, agent.id)
      status = expiredStatus ?? status
    }

    return {
      payment_id: intent.id,
      status,
      chain_id: intent.chain_id,
      token: intent.token_symbol,
      amount: intent.amount_human,
      // #3307: Haven-owned addresses are EIP-55 checksummed at the read
      // boundary, the same rule as the receipt, payment status and the
      // transactions feed (#3129). Storage stays lowercase.
      to: toCanonicalAddress(intent.to_address),
      tx_hash: intent.tx_hash,
      explorer_url: intent.tx_hash ? getExplorerUrl(intent.chain_id, 'tx', intent.tx_hash) : null,
      fee: buildResponseFee(intent),
      // #3494: bounded at this read — the stored value is already scrubbed of
      // vendor secrets (`redactVendorSecrets`, written at `failSubmittedIntent`
      // time) but not length-capped, and a viem/bundler failure can carry its
      // full callData or ABI in `.message`.
      error_message: boundFailureMessage(intent.error_message),
      created_at: intent.created_at,
      signed_at: intent.signed_at,
      submitted_at: intent.submitted_at,
      confirmed_at: intent.confirmed_at,
      expires_at: intent.expires_at,
    }
  })

  // ── GET /:id/receipt — verifiable proof bundle for a settled payment ──

  app.get<{ Params: { id: string } }>('/:id/receipt', async (request, reply) => {
    const agent = request.agent as AgentContext
    const receipt = await getPaymentReceipt(request.params.id, agent.id)
    if (!receipt) {
      return reply.code(404).send({ error: 'No settled payment found for this id' })
    }
    // Self-verify so the response states the proof status; the bundle is also
    // verifiable independently of Haven (recover the signer from authorization).
    const verification = verifyPaymentReceipt(receipt)
    return { receipt, verification }
  })

  // ── GET / — List payment intents for this agent ─────────

  app.get('/', async (request) => {
    const agent = request.agent as AgentContext

    await expireOverdueIntentsForAgent(agent.id)

    const intents = await listIntentsForAgent(agent.id)

    return {
      payments: intents.map((intent) => ({
        payment_id: intent.id,
        status: intent.status,
        token: intent.token_symbol,
        amount: intent.amount_human,
        to: toCanonicalAddress(intent.to_address), // #3307
        tx_hash: intent.tx_hash,
        created_at: intent.created_at,
        confirmed_at: intent.confirmed_at,
      })),
    }
  })
}
