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
    if (maxTimeoutSeconds !== undefined && (typeof maxTimeoutSeconds !== 'number' || !Number.isFinite(maxTimeoutSeconds))) {
      // #1053 review (minor): a non-numeric value used to NaN through the
      // clamp and surface as a 502; it is a caller error and gets a 400.
      return reply.code(400).send({ error: 'maxTimeoutSeconds must be a finite number' })
    }
    let { payTo } = request.body
    let { merchantPayTo } = request.body

    // 1. Validate inputs
    if (!url || typeof url !== 'string') {
      return reply.code(400).send({ error: 'Resource URL is required' })
    }
    if (!payTo || !isValidAddress(payTo)) {
      return reply.code(400).send({ error: 'Valid payTo address is required' })
    }
    // Re-checksum to canonical EIP-55 form. Third-party x402 servers sometimes
    // ship mis-cased addresses; ethers ABI-encoding rejects those downstream.
    payTo = normaliseAddress(payTo)
    if (!amount || typeof amount !== 'string') {
      return reply.code(400).send({ error: 'Amount (atomic units) is required' })
    }
    if (!isPositiveDecimalAtomicAmount(amount)) {
      return reply.code(400).send({
        error: 'Invalid amount — must be a positive decimal integer in atomic units',
      })
    }
    if (!asset || typeof asset !== 'string') {
      return reply.code(400).send({ error: 'Asset (token address) is required' })
    }
    if (!network || typeof network !== 'string') {
      return reply.code(400).send({ error: 'Network is required' })
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
      if (!merchantPayTo || !isValidAddress(merchantPayTo)) {
        return reply.code(400).send({ error: 'Valid merchantPayTo address is required' })
      }
      merchantPayTo = normaliseAddress(merchantPayTo)
    }
    if (idempotencyKey !== undefined && (
      typeof idempotencyKey !== 'string' ||
      idempotencyKey.length === 0 ||
      idempotencyKey.length > 128
    )) {
      return reply.code(400).send({ error: 'idempotencyKey must be a non-empty string up to 128 characters' })
    }

    // Structural checks only, and rail-INDEPENDENT by construction — they
    // reject a value that is not a settlement scheme at all, and say nothing
    // about which rail could settle it. #2245 deleted the rail-DEPENDENT
    // guards that used to follow (#946 erc7710 / #1058 facilitatorAddresses
    // "requires a delegation-rail account"): a non-delegation account is now
    // refused by the #1986 rail tombstone in `modules/x402/authorize.ts`, and
    // the only scheme rules left are the delegation-rail-internal shape
    // checks in `scheme-selection.ts`.
    const { settlementScheme } = request.body
    if (settlementScheme !== undefined && !['erc7710', 'eip3009'].includes(settlementScheme)) {
      return reply.code(400).send({ error: "settlementScheme must be 'erc7710' or 'eip3009'" })
    }
    const { facilitatorAddresses } = request.body
    if (facilitatorAddresses !== undefined) {
      if (
        !Array.isArray(facilitatorAddresses) ||
        facilitatorAddresses.length === 0 ||
        facilitatorAddresses.length > 16 ||
        facilitatorAddresses.some((a) => typeof a !== 'string' || !isValidAddress(a))
      ) {
        return reply.code(400).send({
          error: 'facilitatorAddresses must be 1-16 valid addresses (the erc7710 challenge entry\'s extra.facilitatorAddresses)',
        })
      }
    }

    // #1307: optional MCP merchant-call context — structural validation only
    // (the settle-leg rehydration is a convenience for retrying the
    // MERCHANT's own call, not payment authority; malformed input is a 400
    // rather than silently dropped, so a client learns immediately).
    const { mcpCallContext } = request.body
    if (mcpCallContext !== undefined) {
      if (
        typeof mcpCallContext !== 'object' ||
        mcpCallContext === null ||
        typeof mcpCallContext.merchantUrl !== 'string' ||
        mcpCallContext.merchantUrl.length === 0 ||
        typeof mcpCallContext.toolName !== 'string' ||
        mcpCallContext.toolName.length === 0
      ) {
        return reply.code(400).send({
          error: 'mcpCallContext requires a non-empty merchantUrl and toolName',
        })
      }
      if (mcpCallContext.mcpTransport !== undefined) {
        const transport = mcpCallContext.mcpTransport
        if (
          typeof transport !== 'object' ||
          transport === null ||
          typeof transport.handshakeRequired !== 'boolean' ||
          (transport.source !== 'path' && transport.source !== 'bazaar')
        ) {
          return reply.code(400).send({
            error: "mcpCallContext.mcpTransport requires handshakeRequired (boolean) and source ('path'|'bazaar')",
          })
        }
      }
    }

    // #1355: optional full 402 PaymentRequired — persisted so sign-context can
    // re-serve it and the signer needs only payment_id. Structural + size
    // bound only: it is verified against the Haven-signed expected context at
    // the signer, never trusted as authority here. Oversized input is a 400
    // (not a silent drop) so a client learns immediately, mirroring #1307.
    const { paymentRequired } = request.body
    if (paymentRequired !== undefined) {
      if (typeof paymentRequired !== 'object' || paymentRequired === null || Array.isArray(paymentRequired)) {
        return reply.code(400).send({ error: 'paymentRequired must be the parsed 402 PaymentRequired object' })
      }
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
  // route only validates the signature's wire shape and serializes the result.
  app.post<{ Params: { id: string }; Body: { signature?: string } }>(
    '/:id/settle',
    { config: moneyPathRateLimit },
    async (request, reply) => {
      const agent = request.agent as AgentContext
      const { id } = request.params
      const { signature } = request.body ?? {}
      if (!signature || !/^0x[0-9a-fA-F]+$/.test(signature)) {
        return reply.code(400).send({ error: 'A delegate EIP-712 signature is required' })
      }

      const result = await settleX402(agent, id, signature, request.log)
      return reply.code(result.code).send(result.body)
    },
  )
}
