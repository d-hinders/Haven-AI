import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { agentAuthMiddleware, type AgentContext } from '../middleware/agentAuth.js'
import { moneyPathRateLimit } from '../middleware/rate-limit.js'
import { isAddress as isValidAddress } from '@haven_ai/core'
import {
  authorizeX402,
  settleX402,
  getX402SignContext,
  isPositiveDecimalAtomicAmount,
  normaliseAddress,
  chainIdFromX402Network,
  type X402AuthorizeBody,
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

    // Structural checks only — the RAIL-dependent scheme rules (#946: erc7710
    // requires a delegation-rail account; #1058: facilitatorAddresses too)
    // live in the module's scheme-selection orchestration.
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
  app.get<{ Params: { id: string } }>('/:id/sign-context', async (request, reply) => {
    const agent = request.agent as AgentContext
    const result = await getX402SignContext(agent, request.params.id)
    return reply.code(result.code).send(result.body)
  })

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
