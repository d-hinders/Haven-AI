import { FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { agentAuthMiddleware, type AgentContext } from '../middleware/agentAuth.js'
import { moneyPathRateLimit } from '../middleware/rate-limit.js'
import { getAgentPaymentStatus } from '../modules/payments/index.js'
import { agentExecutionRailLabel } from '../rails/execution-rail.js'
import { computeHybridAccountAddress } from '../rails/hybrid-provisioning.js'
import {
  handleGetAllowances,
  handleBalanceCoverage,
  handleBudgetPrecheck,
  handleReconciliationEvent,
  handleSend,
  attachEvidenceHandler,
  handleMerchantReceiptCapture,
  listReceipts,
  RECEIPT_LIST_SCOPE,
  mppDemoRetired,
  prepareSweep,
  submitSweep,
  RECONCILIATION_EVENT_TYPES,
  type EvidenceBody,
  type ReconciliationEventBody,
  type SendAsset,
  type SendBody,
} from '../modules/mpp/index.js'

// Route handlers only: request validation, auth middleware wiring, rate-limit
// config, and response serialization. Everything else — authorize
// orchestration, the send flow, sweep prepare/submit orchestration,
// evidence/receipt assembly, and the rail-aware allowances read — lives in
// `src/modules/mpp/` (#997, epic #980 M4). See that module's `index.ts` for
// the public surface and the boundary rationale.

/** #3128: a receipts cursor is a receipt id (uuid). Kept as the handler's narrowing. */
const RECEIPT_CURSOR_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The receipts page's limit read, post-enforcement (#3031). The spec declares
 * `limit` as `integer, minimum: 1, maximum: 100, default: 25`, so ajv coerces
 * the query string and injects the default before the handler — the clamp
 * (Number.isInteger / Math.min / Math.max) and the `? 25` fallback are gone.
 * The guard covers a caller that mounted the module without the plugin (the
 * transactions.ts precedent).
 */
function readReceiptsLimit(value: number | string | undefined, fallback: number): number {
  return value === undefined ? fallback : Number(value)
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

    return ({
      id: agent.id,
      name: agent.name,
      status: agent.status,
      account_address: agent.account_address,
      delegate_address: agent.delegate_address,
      delegate_account_address: delegateAccountAddress,
      chain_id: agent.chain_id,
      // #1306: which on-chain policy primitive gates this agent's spend —
      // reporting only, same two-value bucketing handleGetAllowances already
      // branches on below.
      execution_rail: agentExecutionRailLabel(agent.execution_rail),
    })
  })

  app.get('/allowances', async (request, reply) => {
    const agent = request.agent as AgentContext
    const result = await handleGetAllowances(agent)
    return reply.code(result.statusCode).send(result.body)
  })

  // #3126 — the sufficiency signal, NOT a balance tool. Answers "is this
  // amount of this token actually HELD on my account?" as covered
  // true/false/null; the account's balance itself is never returned, and
  // every figure in the response is named for its concept (budget_* is
  // authority, covered is holdings). See modules/mpp/balance-coverage.ts for
  // the argument, and the OpenAPI entry for the agent-facing wording.
  //
  // #3031: the spec declares both query parameters (`token`, a
  // required-by-handler string; `amount_atomic`), so the two hand-rolled
  // guards in `modules/mpp/balance-coverage-guards.ts` (relocated out of this
  // file by #3126 for the ratchet) are replaced by the enforced schema and
  // deleted — `parseBalanceCoverageQuery` folded back into a one-line parse.
  app.get<{ Querystring: { token?: string; amount_atomic?: string } }>(
    '/balance-coverage',
    async (request, reply) => {
      const agent = request.agent as AgentContext
      const result = await handleBalanceCoverage(agent, {
        token: request.query.token ?? '',
        amountAtomic: request.query.amount_atomic ?? '',
      })
      return reply.code(result.statusCode).send(result.body)
    },
  )

  app.get<{ Querystring: { limit?: string; cursor?: string } }>('/receipts', async (request, reply) => {
    const agent = request.agent as AgentContext
    const limit = readReceiptsLimit(request.query.limit, 25)
    // #3128: the cursor is a receipt id from a previous page. The spec
    // declares `format: uuid` since #3031, so a NON-UUID cursor is refused by
    // the enforced schema before the handler; the narrowing here covers a
    // caller that mounted the module without the plugin. What STAYS semantic
    // is the lookup below: a well-formed uuid that names no receipt of THIS
    // agent is still a 400 from the handler (`listReceipts`), not a 404 —
    // the cursor-vs-total distinction the #3128 review pinned.
    const cursor = request.query.cursor ?? null
    if (cursor !== null && !RECEIPT_CURSOR_PATTERN.test(cursor)) {
      return reply.code(400).send({ error: 'cursor must be the id of a receipt returned by a previous page (next_cursor).' })
    }

    const page = await listReceipts(agent.id, limit, cursor)
    if (page === null) {
      return reply.code(400).send({ error: 'cursor does not name a receipt of this agent — pass the next_cursor of a previous page.' })
    }
    // #3132: per-row scope (the SDK discards the envelope, so the row is the
    // only place a declaration reaches an MCP caller).
    return reply.send({ ...page, receipts: page.receipts.map((receipt) => ({ ...receipt, scope: RECEIPT_LIST_SCOPE })) })
  })

  app.get<{ Params: { id: string } }>('/:id/status', async (request, reply) => {
    const agent = request.agent as AgentContext
    const status = await getAgentPaymentStatus(agent, request.params.id)

    if (!status) {
      return reply.code(404).send({ error: 'Payment not found' })
    }

    return reply.send(status)
  })

  // ── POST /send — Plain transfer (asset/recipient naming convention) ─────────
  // #3031: the body shape — the asset enum, the recipient pattern, the
  // amount's string form, idempotency_key's 1–128 bounds — is the spec's,
  // enforced before the handler. The handler keeps only the amount's
  // positive-number MEANING (Number-parse semantics the spec's bare `string`
  // cannot state) and the rail refusals below.
  app.post<{ Body: SendBody }>('/send', { config: moneyPathRateLimit }, async (request, reply) => {
    const agent = request.agent as AgentContext
    const { asset, recipient, amount } = request.body

    if (isNaN(Number(amount)) || Number(amount) <= 0) {
      return reply.code(400).send({ error: 'amount must be a positive number' })
    }

    const result = await handleSend(agent, asset as SendAsset, recipient, amount, request.body.idempotency_key)
    return reply.code(result.statusCode).send(result.body)
  })

  // #1328: the legacy internal MPP demo flow is retired outright — fail
  // closed, nothing read or written beyond the agent-auth lookup the
  // `onRequest` hook already did. Agents are directed to the deployed x402
  // merchant flow.
  //
  // #3031: the module is now ENFORCED, and the spec declares a request body
  // for this tombstone (`MachinePaymentAuthorizeRequest`, the shape a client
  // of the retired rail sent) — so the route-level `onRequest` hook (the
  // slice-2 `retiredSafeInflowRoute` pattern, local to this tombstone
  // because the refusal's single producer is `mppDemoRetired`, not
  // `safeRailRetired`) keeps the 410 ahead of validation: a malformed body
  // is told the flow is GONE, not asked to fix its request. Auth still wins
  // for an anonymous caller: the module-level `agentAuthMiddleware` hook
  // above is registered first, and Fastify runs onRequest hooks in
  // registration order. Pinned in this file's test.
  app.post(
    '/authorize',
    {
      onRequest: async (_request: FastifyRequest, reply: FastifyReply) => {
        const refusal = mppDemoRetired()
        return reply.code(refusal.statusCode).send(refusal.body)
      },
      config: moneyPathRateLimit,
    },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      // Unreachable: the onRequest hook answers every request. Kept because
      // Fastify requires a handler.
      const refusal = mppDemoRetired()
      return reply.code(refusal.statusCode).send(refusal.body)
    },
  )

  // ── POST /evidence ────────────────────────────────────────────────────────
  // #3031: the ladder is gone — every field's presence, type and form
  // (paymentId uuid, rail string, txHash `0x`+64-hex, the four optional
  // header strings, the three payload objects) is the spec's
  // `MachinePaymentEvidenceRequest`, enforced before the handler.
  app.post('/evidence', { config: moneyPathRateLimit }, async (request, reply) => {
    const agent = request.agent as AgentContext
    // `rail` reaches the module as its union type (`MachinePaymentRail`): the
    // spec declares the field a plain string, the module's own type narrows
    // it, and the cast documents that the closed schema + the union agree on
    // the retired values' presence (`mpp` etc. are refused downstream by the
    // module's semantic checks, not by shape).
    const body = request.body as EvidenceBody

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

  // ── POST /reconciliation-events ───────────────────────────────────────────
  // #3031: paymentId (uuid), rail, eventType, txHash (`0x`+64-hex), reason
  // and details (object) are the spec's `MachinePaymentReconciliationEventRequest`,
  // enforced before the handler. What stays is the enum's LIVE SOURCE — the
  // schema's enum is pinned to this Set by test, and the handler reads the
  // Set so a new event type lights up here first — plus the semantic
  // refusals downstream (confirmed-payment requirement, #2292 acceptance
  // terminality).
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

    if (!RECONCILIATION_EVENT_TYPES.has(eventType as string)) {
      return reply.code(400).send({ error: 'Unsupported reconciliation event type' })
    }

    const result = await handleReconciliationEvent(
      agent.id,
      paymentId as string,
      rail as string,
      eventType as string,
      txHash,
      reason,
      details,
    )
    return reply.code(result.statusCode).send(result.body)
  })

  // ── POST /budget-precheck — server-side budget gate for the hosted prepare ─
  // #3054: the guided purchase's over-budget refusal is DECIDED here so it
  // reaches the payment_refusals ledger (source hosted_prepare). Same
  // posture as every writer: the row is recorded through refuse() only —
  // never agent-asserted — and a fire-and-forget write can never change the
  // decided response.
  //
  // #3031: the spec's `BudgetPrecheckRequest` states every guard the
  // `modules/mpp/budget-precheck-guards.ts` relocation carried (token
  // address pattern, amountAtomic digit-string pattern, the three optional
  // field types) — the module is enforced, so the guard file is deleted and
  // the handler calls straight through. The 403/refusal-ledger behaviour is
  // unchanged.
  app.post<{ Body: { token: string; amountAtomic: string; chainId?: number; merchantTo?: string; resourceUrl?: string } }>(
    '/budget-precheck',
    { config: moneyPathRateLimit },
    async (request, reply) => {
      const agent = request.agent as AgentContext
      const result = await handleBudgetPrecheck(agent, request.body)
      return reply.code(result.statusCode).send(result.body)
    },
  )

  // ── POST /sweep/prepare — build a gasless USDC sweep authorization ──────────
  app.post('/sweep/prepare', { config: moneyPathRateLimit }, async (request, reply) => {
    const agent = request.agent as AgentContext
    const result = await prepareSweep(agent)
    return reply.code(result.statusCode).send(result.body)
  })

  // ── POST /sweep/submit — relay a signed sweep authorization ─────────────────
  // #3031: the body shape — authorization (the closed SweepAuthorization:
  // every field, the nonce's 32-byte hex) and signature (`0x` hex) — is the
  // spec's, enforced before the handler. `submitSweep` re-derives the
  // authorization from server state and verifies the delegate signature; the
  // body is transport, never authority.
  app.post<{ Body: { authorization?: { nonce?: string }; signature?: string } }>('/sweep/submit', { config: moneyPathRateLimit }, async (request, reply) => {
    const agent = request.agent as AgentContext
    const body = request.body ?? {}
    const nonce = body.authorization?.nonce as string

    const result = await submitSweep(agent, nonce, body.signature as string)
    return reply.code(result.statusCode).send(result.body)
  })
}
