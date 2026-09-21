import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { agentAuthMiddleware, type AgentContext } from '../middleware/agentAuth.js'
import { moneyPathRateLimit } from '../middleware/rate-limit.js'
import {
  authorizeX402,
  settleX402,
  getX402SignContext,
  getX402MerchantCallContext,
  isPositiveDecimalAtomicAmount,
  normaliseAddress,
  chainIdFromX402Network,
  type X402AuthorizeBody,
  type X402McpCallContextInput,
} from '../modules/x402/index.js'

// Route handlers only: request validation, auth middleware wiring, rate-limit
// config, and response serialization. Everything else — settlement-scheme
// routing, delegation/replay orchestration, and settle assembly — lives in
// `src/modules/x402/` (#996, epic #980 M4). See that module's `index.ts` for
// the public surface and the boundary rationale.

export default async function x402Routes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', agentAuthMiddleware)

  /**
   * POST /x402/authorize — Authorize an x402 payment
   *
   * Two modes:
   * 1. Without `signature`: creates a payment intent, returns sign_hash (agent signs, then calls POST /payments/:id/sign)
   * 2. With `signature`: creates intent AND executes in one shot (for SDK convenience)
   *
   * #3031: the enforced spec carries every shape this handler used to
   * re-state (required fields, address patterns, the amount's positive
   * decimal form, the scheme enum, the facilitator array bounds, the
   * mcpCallContext/mcpTransport shapes, the idempotencyKey and
   * maxTimeoutSeconds types) and refuses off-spec requests before the
   * handler — that ladder is deleted, not moved. What stays here is what no
   * schema can state: the EIP-55 re-checksumming, chain resolution and the
   * agent-chain match, the 64KB serialized bound on paymentRequired, and
   * every semantic rule downstream (the rail seam's 410, the budget
   * pre-check, the #1360 scheme/payTo agreement in
   * `modules/x402/scheme-selection.ts`) — each at its #2245/#2274-vetted
   * position.
   */
  const authorizeX402Handler = async (
    request: FastifyRequest<{ Body: X402AuthorizeBody }>,
    reply: FastifyReply,
  ) => {
    const agent = request.agent as AgentContext
    const {
      url,
      amount,
      asset,
      network,
      description,
      category,
      idempotencyKey,
      maxTimeoutSeconds,
      signature,
      settlementScheme,
      facilitatorAddresses,
      mcpCallContext,
      paymentRequired,
    } = request.body
    let { payTo } = request.body
    let { merchantPayTo } = request.body

    // The amount's positive-decimal-integer FORM (#2274 doctrine): the spec's
    // `type: string` cannot state it, so the handler keeps this rail-INDEPENDENT
    // structural check above the rail seam — a retired-rail account naming an
    // impossible amount still gets this 400, not the 410, exactly as #2274
    // pinned the structural-precedence class (same position `POST /payments`
    // keeps its own gate in via the token parse).
    if (!isPositiveDecimalAtomicAmount(amount)) {
      return reply.code(400).send({
        error: 'Invalid amount — must be a positive decimal integer in atomic units',
      })
    }

    // Re-checksum to canonical EIP-55 form. Third-party x402 servers sometimes
    // ship mis-cased addresses; ethers ABI-encoding rejects those downstream.
    // (The spec's address pattern accepts any casing; this is canonicalisation,
    // not validation.)
    payTo = normaliseAddress(payTo)
    if (merchantPayTo !== undefined) {
      merchantPayTo = normaliseAddress(merchantPayTo)
    }

    const requestedChainId = chainIdFromX402Network(network)
    if (!requestedChainId) {
      return reply.code(400).send({ error: `Unsupported x402 network: ${network}` })
    }
    if (requestedChainId !== agent.chain_id) {
      return reply.code(400).send({
        error: `x402 network ${network} does not match agent chain ${agent.chain_id}`,
      })
    }

    // #1355: optional full 402 PaymentRequired — persisted so sign-context can
    // re-serve it and the signer needs only payment_id. The spec bounds its
    // SHAPE (an object); the SIZE bound stays here — it is a serialization
    // budget on the stored row (UTF-8 bytes), not a shape. Oversized input is
    // a 400 (not a silent drop) so a client learns immediately, mirroring
    // #1307.
    if (paymentRequired !== undefined) {
      if (Buffer.byteLength(JSON.stringify(paymentRequired), 'utf8') > 65536) {
        return reply.code(400).send({
          error: 'paymentRequired exceeds 64KB — omit it; the signer falls back to the caller-supplied copy',
        })
      }
    }

    const result = await authorizeX402({
      agent,
      url,
      payTo,
      merchantPayTo,
      amount,
      asset,
      network,
      description,
      category,
      idempotencyKey,
      maxTimeoutSeconds,
      signature,
      settlementScheme,
      facilitatorAddresses,
      mcpCallContext: mcpCallContext as X402McpCallContextInput | undefined,
      paymentRequired,
      log: request.log,
    })
    return reply.code(result.code).send(result.body)
  }

  app.post<{ Body: X402AuthorizeBody }>('/', { config: moneyPathRateLimit }, authorizeX402Handler)
  app.post<{ Body: X402AuthorizeBody }>('/authorize', { config: moneyPathRateLimit }, authorizeX402Handler)

  // ── GET /x402/:id/sign-context — byte-free signing handoff (#1263) ───────
  // Read-only: re-serves the stored delegation-rail signing payload + a fresh
  // Haven-signed expected context so the LOCAL SIGNER can fetch exact bytes by
  // payment_id instead of an agent re-emitting them. All checks and the rebuild
  // live in the module (`getX402SignContext`).
  app.get<{ Params: { id: string } }>('/:id/sign-context', { config: moneyPathRateLimit }, async (request, reply) => {
    const agent = request.agent as AgentContext
    const result = await getX402SignContext(agent, request.params.id)
    return reply.code(result.code).send(result.body)
  })

  // ── GET /x402/:id/merchant-call-context — settle-leg handoff (#1307) ─────
  // Read-only: re-serves the stored MCP merchant-call context (merchant_url,
  // tool_name, arguments, mcp_transport) recorded at quote time, so
  // haven_settle_mcp_tool / haven_complete_mcp_tool can rehydrate it by
  // payment_id instead of the agent re-threading it. All checks live in the
  // module (`getX402MerchantCallContext`).
  app.get<{ Params: { id: string } }>(
    '/:id/merchant-call-context',
    { config: moneyPathRateLimit },
    async (request, reply) => {
      const agent = request.agent as AgentContext
      const result = await getX402MerchantCallContext(agent, request.params.id)
      return reply.code(result.code).send(result.body)
    },
  )

  // ── POST /x402/:id/settle — delegation rail (#830) ───────────────────────
  // The agent has signed the settlement child (EIP-712). Assembly, signer
  // recovery, and header encoding live in the module (`settleX402`). #2282:
  // the snake-case twin (`mcp_transport`) is refused here by the enforced
  // schema's `additionalProperties: false` — the incident that named this
  // slice. #3031: the signature's wire shape (`0x` hex) is the spec's too,
  // enforced before the handler.
  app.post<{ Params: { id: string }; Body: { signature: string } }>(
    '/:id/settle',
    { config: moneyPathRateLimit },
    async (request, reply) => {
      const agent = request.agent as AgentContext
      const { id } = request.params
      // Required + `0x`-hex pattern is the spec's since #3031, enforced before
      // the handler; the Body generic matches the wire the enforcement
      // guarantees (the #3082 lesson).
      const { signature } = request.body

      const result = await settleX402(agent, id, signature, request.log)
      return reply.code(result.code).send(result.body)
    },
  )
}
