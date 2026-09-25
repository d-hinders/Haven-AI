import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { agentAuthMiddleware, type AgentContext } from '../middleware/agentAuth.js'
import { moneyPathRateLimit } from '../middleware/rate-limit.js'
import { isAddress as isValidAddress } from '@haven_ai/core'
import {
  authorizeX402,
  settleX402,
  getX402SignContext,
  getX402MerchantCallContext,
  isPositiveDecimalAtomicAmount,
  normaliseAddress,
  chainIdFromX402Network,
  type X402AuthorizeBody,
} from '../modules/x402/index.js'

// Route handlers only: auth middleware wiring, rate-limit config, and response
// serialization — the request SHAPE has been the plugin's since #3031, and
// what stays here is what JSON Schema cannot state. Everything else — settlement-scheme
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
    } = request.body
    let { payTo } = request.body
    let { merchantPayTo } = request.body

    // 1. Validate inputs
    //
    // #3031: the SHAPE of every field below is the request schema's job now
    // (`X402AuthorizeRequest`, enforced since this file joined
    // `enforcedModules`): required-ness, string-ness, the address pattern,
    // the digits-only amount, the cap on `idempotencyKey`, the
    // `settlementScheme` enum, the 1–16 `facilitatorAddresses`, the
    // `mcpCallContext` object and the signature pattern all refuse before the
    // handler runs. What stays here is what JSON Schema cannot say: a
    // non-zero amount, a network this agent's chain can settle, and a
    // 64 KB bound on a free-form object.
    payTo = normaliseAddress(payTo)
    if (!isPositiveDecimalAtomicAmount(amount)) {
      // The schema pins digits-only; `> 0` is the part it cannot express.
      return reply.code(400).send({
        error: 'Invalid amount — must be a positive decimal integer in atomic units',
      })
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
    if (merchantPayTo !== undefined) {
      merchantPayTo = normaliseAddress(merchantPayTo)
    }

    // The scheme fields were structural-only here and are structural-only in
    // the schema: an enum and a bounded address array, saying nothing about
    // which rail could settle. #2245 deleted the rail-DEPENDENT guards that
    // used to follow (#946 erc7710 / #1058 facilitatorAddresses "requires a
    // delegation-rail account"): a non-delegation account is refused by the
    // #1986 rail tombstone in `modules/x402/authorize.ts`, and the only
    // scheme rules left are the delegation-rail-internal shape checks in
    // `scheme-selection.ts` — semantic, untouched by #3031.
    const { settlementScheme, facilitatorAddresses } = request.body

    // #1307: optional MCP merchant-call context. Its shape — required
    // `merchantUrl`/`toolName`, the closed `mcpTransport` with its
    // `path|bazaar` enum — is declared on `X402AuthorizeRequest` and refused
    // by the schema. #2282 (`mcp_transport` in snake_case) is a refusal that
    // `additionalProperties: false` makes, not a rung.
    const { mcpCallContext } = request.body

    // #1355: optional full 402 PaymentRequired — persisted so sign-context can
    // re-serve it and the signer needs only payment_id. Structural + size
    // bound only: it is verified against the Haven-signed expected context at
    // the signer, never trusted as authority here. Oversized input draws the
    // 400 (not a silent drop) so a client learns immediately, mirroring #1307.
    const { paymentRequired } = request.body
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
      mcpCallContext,
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
  // payment_id instead of a model re-emitting them. All checks and the rebuild
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
  // recovery, and header encoding live in the module (`settleX402`); this
  // route only serializes the result — the signature's wire shape is refused
  // by the operation's request schema (#3031).
  app.post<{ Params: { id: string }; Body: { signature: string } }>(
    '/:id/settle',
    { config: moneyPathRateLimit },
    async (request, reply) => {
      const agent = request.agent as AgentContext
      const { id } = request.params
      // #3031: `signature` is required with the same `^0x[0-9a-fA-F]+$`
      // pattern on the operation's request schema, so the rung that used to
      // stand here refuses one step earlier.
      const { signature } = request.body

      const result = await settleX402(agent, id, signature, request.log)
      return reply.code(result.code).send(result.body)
    },
  )
}
