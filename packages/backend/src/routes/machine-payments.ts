import { FastifyInstance } from 'fastify'
import { agentAuthMiddleware, type AgentContext } from '../middleware/agentAuth.js'
import { moneyPathRateLimit } from '../middleware/rate-limit.js'
import { getAgentPaymentStatus } from '../modules/payments/index.js'
import { agentExecutionRailLabel } from '../rails/execution-rail.js'
import { computeHybridAccountAddress } from '../rails/hybrid-provisioning.js'
import {
  handleGetAllowances,
  handleBalanceCoverage,
  handleBudgetPrecheck,
  budgetPrecheckBodyError,
  parseBalanceCoverageQuery,
  handleReconciliationEvent,
  handleSend,
  attachEvidenceHandler,
  handleMerchantReceiptCapture,
  listReceipts,
  RECEIPT_LIST_SCOPE,
  mppDemoRetired,
  prepareSweep,
  submitSweep,
  type AuthorizeBody,
  type BudgetPrecheckBody,
  type EvidenceBody,
  type ReconciliationEventBody,
  type SendAsset,
  type SendBody,
  type SweepSubmitBody,
} from '../modules/mpp/index.js'

/**
 * The reconciliation-events request body: `paymentId`, `rail` and
 * `eventType` required, the optional halves of `ReconciliationEventBody`
 * unchanged. A NAMED alias rather than an inline `Pick`/`Omit` generic on
 * the route: the route-modules extractor matches `app.post(` up to the
 * first quote (#3135), and the inline form's string literals broke the
 * match — see the note at the registration.
 */
type ReconciliationEventRequestBody =
  Required<Pick<ReconciliationEventBody, 'paymentId' | 'rail' | 'eventType'>> &
    Omit<ReconciliationEventBody, 'paymentId' | 'rail' | 'eventType'>

// Route handlers only: auth middleware wiring, rate-limit config, and
// response serialization — the request SHAPE has been the plugin's since
// #3031, and what stays here is what JSON Schema cannot state. Everything
// else — authorize
// orchestration, the send flow, sweep prepare/submit orchestration,
// evidence/receipt assembly, and the rail-aware allowances read — lives in
// `src/modules/mpp/` (#997, epic #980 M4). See that module's `index.ts` for
// the public surface and the boundary rationale.

/** #3128: a receipts cursor is a receipt id (uuid). The SHAPE check moved
 *  to the request schema (#3031, `format: uuid`); ownership stays semantic
 *  in `listReceipts`. */
const RECEIPT_CURSOR_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
  app.get<{ Querystring: { token?: string; amount_atomic?: string } }>(
    '/balance-coverage',
    async (request, reply) => {
      const agent = request.agent as AgentContext
      // #3126 query guards relocated to the mpp module
      // (parseBalanceCoverageQuery) so the #3029 request-schemas ratchet
      // keeps its shrink-only baseline for this file — checks and 400 bodies
      // unchanged. Parses the raw wire query (amount_atomic) into the
      // handler's camelCase input.
      const parsed = parseBalanceCoverageQuery(request.query)
      if ('error' in parsed) {
        return reply.code(400).send(parsed)
      }
      const result = await handleBalanceCoverage(agent, parsed)
      return reply.code(result.statusCode).send(result.body)
    },
  )

  app.get<{ Querystring: { limit?: string; cursor?: string } }>('/receipts', async (request, reply) => {
    const agent = request.agent as AgentContext
    const parsedLimit = request.query.limit ? Number(request.query.limit) : 25
    const limit = Number.isInteger(parsedLimit)
      ? Math.min(Math.max(parsedLimit, 1), 100)
      : 25
    // #3031: the cursor's uuid SHAPE is the request schema's (`format:
    // uuid` on the `cursor` parameter), so the RECEIPT_CURSOR_PATTERN rung
    // is gone. What stays semantic is the cursor's OWNERSHIP half: a
    // well-formed uuid that names no receipt of THIS agent is still a 400
    // from `listReceipts`, not an empty page (#3128).
    const cursor = request.query.cursor ?? null

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

  app.post<{ Body: SendBody }>('/send', { config: moneyPathRateLimit }, async (request, reply) => {
    const agent = request.agent as AgentContext
    const { asset, recipient, amount } = request.body

    // 1. Validate inputs
    //
    // #3031: the SHAPES — required `asset`/`recipient`/`amount`, the ETH|USDC
    // enum, the recipient address pattern, `amount` string-ness, and the
    // 1–128 `idempotency_key` — are the request schema's job now
    // (`/machine-payments/send`, enforced since this file joined
    // `enforcedModules`). What stays here is what the schema cannot say:
    // `Number(amount)` must PARSE (`'1e2'` is digits-plus-letter and would
    // NaN through `handleSend`'s conversion) and be POSITIVE — the same
    // two-half split as the x402 amount.
    if (isNaN(Number(amount)) || Number(amount) <= 0) {
      return reply.code(400).send({ error: 'amount must be a positive number' })
    }

    const result = await handleSend(agent, asset as SendAsset, recipient, amount, request.body.idempotency_key)
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

    // #3031: `MachinePaymentEvidenceRequest` (enforced) refuses every shape
    // error this ladder used to: required `paymentId` (uuid)/`rail`/`txHash`
    // (0x 64-hex), the optional strings, and the three optional OBJECTS —
    // `type: 'object'` without `additionalProperties: false` refuses arrays
    // and null exactly as `isPlainObject` did. What stays in the module is
    // the SEMANTIC layer: rail eligibility, payment ownership/state, and the
    // cross-field agreement checks (`modules/mpp/evidence.ts`), plus the
    // 100–599 merchantStatus bound the module's own guard already held.
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

  // The Body generic states the post-#3031 reality: the enforced schema
  // guarantees `paymentId`/`rail`/`eventType` before the handler runs, so
  // the type says so instead of a rung proving it at runtime. The type is a
  // NAMED alias, not an inline generic: the route-modules extractor
  // (`extractRoutes`, #3135) matches `app.post(` up to the first quote, and
  // the inline `Pick<..., 'paymentId' | ...>`'s string literals swallowed
  // the match — the route dropped out of `ROUTE_MODULE_BY_OPERATION`, and
  // with it out of enforcement (caught by the generated-table staleness
  // test, which is exactly what that gate exists for).
  app.post<{ Body: ReconciliationEventRequestBody }>('/reconciliation-events', { config: moneyPathRateLimit }, async (request, reply) => {
    const agent = request.agent as AgentContext
    const {
      paymentId,
      rail,
      eventType,
      txHash,
      reason,
      details,
    } = request.body

    // #3031: the shapes are `MachinePaymentReconciliationEventRequest`'s —
    // required `paymentId` (uuid)/`rail`/`eventType` (the enum that replaces
    // the RECONCILIATION_EVENT_TYPES rung), the 0x-64 txHash, optional
    // string `reason` and open object `details` (arrays and null refused by
    // `type: 'object'`). What stays is the module's SEMANTIC layer —
    // payment ownership, state agreement, the duplicate-report rule
    // (`modules/mpp/reconciliation.ts`) — which is also why this route must
    // never be driven synthetically for a shadow reading (#3223): a forced
    // event reports a merchant rejection that did not happen.

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

  // ── POST /budget-precheck — server-side budget gate for the hosted prepare ─
  // #3054: the guided purchase's over-budget refusal is DECIDED here so it
  // reaches the payment_refusals ledger (source hosted_prepare). Same
  // posture as every writer: the row is recorded through refuse() only —
  // never agent-asserted — and a fire-and-forget write can never change the
  // decided response.
  app.post<{ Body: BudgetPrecheckBody }>(
    '/budget-precheck',
    { config: moneyPathRateLimit },
    async (request, reply) => {
      const agent = request.agent as AgentContext
      // #3054 body guards relocated verbatim to the mpp module
      // (budgetPrecheckBodyError) so the #3029 request-schemas ratchet keeps
      // its shrink-only baseline for this file — checks and 400 bodies
      // unchanged.
      const body = (request.body ?? {}) as BudgetPrecheckBody
      const bodyError = budgetPrecheckBodyError(body)
      if (bodyError) {
        return reply.code(400).send(bodyError)
      }

      const result = await handleBudgetPrecheck(agent, body)
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
  // Body generic: the enforced schema guarantees `signature` and
  // `authorization.nonce` before the handler runs.
  app.post<{ Body: SweepSubmitBody & { signature: string; authorization: { nonce: string } } }>(
    '/sweep/submit',
    { config: moneyPathRateLimit },
    async (request, reply) => {
      const agent = request.agent as AgentContext
      const body = request.body ?? {}
      const signature = body.signature
      const nonce = body.authorization?.nonce

      // #3031: `SweepSubmitRequest` + `SweepAuthorization` (enforced) refuse
      // every shape error these two rungs answered: required `signature`
      // (`^0x[0-9a-fA-F]+$` — the same pattern the rung stated) and the
      // authorization's `nonce` (`^0x[0-9a-fA-F]{64}$`, same as the rung).
      // The signature RECOVERY and the CAS claim stay semantic, in
      // `modules/mpp/sweep.ts`.

      const result = await submitSweep(agent, nonce, signature)
      return reply.code(result.statusCode).send(result.body)
    },
  )
}
