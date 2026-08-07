import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { agentExistsForUser } from '../infra/repositories/agents.js'
import {
  findMachinePaymentEvidenceDetail,
  findSafeOwnership,
  listBasicSafesForUser,
} from '../infra/repositories/transaction-history.js'
import { getChain, isSupportedChain } from '../lib/chains.js'
import {
  aggregateSafeTransactions,
  buildSafeTransactionsPage,
  filterEnrichedTransactions,
  mergeSortDedupeAndEnrich,
  paginateByOffset,
  resolveTransactionFilters,
  type ParsedTokenFilter,
} from '../modules/transactions/index.js'
import { ETH_ADDRESS_RE } from '@haven_ai/core'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (value === undefined) return fallback
  const parsed = parseInt(value, 10)
  if (Number.isNaN(parsed) || parsed < min || parsed > max) {
    return null
  }
  return parsed
}

function parseChainId(value: unknown): number | null {
  if (value === undefined) return null
  if (Array.isArray(value)) return Number.NaN

  const raw = String(value).trim()
  if (!/^[1-9]\d*$/.test(raw)) return Number.NaN

  const chainId = Number(raw)
  return Number.isSafeInteger(chainId) ? chainId : Number.NaN
}

function parseFreshFlag(value: string | undefined): boolean {
  return value === '1' || value === 'true'
}

function parseTokenKey(tokenKey: string | undefined): ParsedTokenFilter | null {
  if (!tokenKey) return null

  const [chainPart, assetPart, ...rest] = tokenKey.split(':')
  if (!chainPart || !assetPart || rest.length > 0) return null

  const chainId = parseInt(chainPart, 10)
  if (Number.isNaN(chainId)) return null

  try {
    getChain(chainId)
  } catch {
    return null
  }

  if (assetPart === 'native') {
    return { chainId, address: null }
  }

  if (!ETH_ADDRESS_RE.test(assetPart)) {
    return null
  }

  return { chainId, address: assetPart.toLowerCase() }
}

export default async function transactionRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  app.get<{
    Querystring: {
      safeId?: string
      agentId?: string
      tokenKey?: string
      offset?: string
      limit?: string
      fresh?: string
    }
  }>('/', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const offset = parsePositiveInt(request.query.offset, 0, 0, Number.MAX_SAFE_INTEGER)
    const limit = parsePositiveInt(request.query.limit, 25, 1, 100)
    const fresh = parseFreshFlag(request.query.fresh)

    if (offset === null || limit === null) {
      return reply.code(400).send({ error: 'Invalid pagination params' })
    }

    if (request.query.safeId && !UUID_RE.test(request.query.safeId)) {
      return reply.code(400).send({ error: 'Invalid safeId' })
    }

    if (
      request.query.agentId &&
      request.query.agentId !== 'user' &&
      !UUID_RE.test(request.query.agentId)
    ) {
      return reply.code(400).send({ error: 'Invalid agentId' })
    }

    const tokenFilter = parseTokenKey(request.query.tokenKey)
    if (request.query.tokenKey && !tokenFilter) {
      return reply.code(400).send({ error: 'Invalid tokenKey' })
    }

    let safes = await listBasicSafesForUser(sub)

    if (request.query.safeId) {
      safes = safes.filter((safe) => safe.id === request.query.safeId)
      if (safes.length === 0) {
        return reply.code(400).send({ error: 'Invalid safeId' })
      }
    }

    if (request.query.agentId && request.query.agentId !== 'user') {
      const agentOwned = await agentExistsForUser(request.query.agentId, sub)
      if (!agentOwned) {
        return reply.code(400).send({ error: 'Invalid agentId' })
      }
    }

    if (safes.length === 0) {
      return {
        transactions: [],
        total: 0,
        offset,
        limit,
        hasMore: false,
        partialFailure: false,
        failedSafeIds: [],
      }
    }

    const { merged, failedSafeIds } = await aggregateSafeTransactions(safes, request.log, fresh)
    const enriched = await mergeSortDedupeAndEnrich(sub, safes, merged)
    const filtered = filterEnrichedTransactions(enriched, {
      agentId: request.query.agentId,
      tokenFilter,
    })
    const { page: paginated, hasMore } = paginateByOffset(filtered, offset, limit)

    return {
      transactions: paginated,
      total: filtered.length,
      offset,
      limit,
      hasMore,
      partialFailure: failedSafeIds.length > 0,
      failedSafeIds: Array.from(new Set(failedSafeIds)),
    }
  })

  app.get<{ Params: { paymentId: string } }>(
    '/payment-intents/:paymentId/evidence',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { paymentId } = request.params

      if (!UUID_RE.test(paymentId)) {
        return reply.code(400).send({ error: 'Invalid paymentId' })
      }

      const evidence = await findMachinePaymentEvidenceDetail(paymentId, sub)
      if (!evidence) {
        return reply.code(404).send({ error: 'Payment evidence not found' })
      }

      // Every response field is a same-named passthrough of the evidence row
      // except `payment_id` — verified 1:1 against MachinePaymentEvidenceDetailRow.
      return {
        evidence: {
          ...evidence,
          payment_id: evidence.payment_intent_id ?? evidence.approval_request_id,
        },
      }
    },
  )

  app.get<{ Querystring: { fresh?: string } }>('/filters', async (request) => {
    const { sub } = request.user as { sub: string }
    const fresh = parseFreshFlag(request.query.fresh)

    const { safes, agents, tokens } = await resolveTransactionFilters(sub, request.log, fresh)

    return {
      safes: safes.map((safe) => ({
        id: safe.id,
        name: safe.name,
        address: safe.safe_address,
        chainId: safe.chain_id,
      })),
      agents,
      tokens,
    }
  })

  app.get<{
    Params: { safeAddress: string }
    Querystring: { page?: string; limit?: string; fresh?: string; chain_id?: string }
  }>('/:safeAddress', async (request, reply) => {
    const { safeAddress } = request.params
    const { sub } = request.user as { sub: string }
    const page = parsePositiveInt(request.query.page, 1, 1, Number.MAX_SAFE_INTEGER)
    const limit = parsePositiveInt(request.query.limit, 25, 1, 100)
    const fresh = parseFreshFlag(request.query.fresh)
    const requestedChainId = parseChainId(request.query.chain_id)

    if (page === null || limit === null) {
      return reply.code(400).send({ error: 'Invalid pagination params' })
    }

    if (!ETH_ADDRESS_RE.test(safeAddress)) {
      return reply.code(400).send({ error: 'Invalid address' })
    }

    if (Number.isNaN(requestedChainId)) {
      return reply.code(400).send({ error: 'Invalid chain_id' })
    }

    if (requestedChainId !== null && !isSupportedChain(requestedChainId)) {
      return reply.code(400).send({ error: `Unsupported chain: ${requestedChainId}` })
    }

    const ownershipRows = await findSafeOwnership(sub, safeAddress, requestedChainId)
    if (ownershipRows.length === 0) {
      return reply.code(403).send({ error: 'Not your Safe' })
    }
    if (requestedChainId === null && ownershipRows.length > 1) {
      return reply.code(400).send({ error: 'chain_id required' })
    }

    const safeId = ownershipRows[0].id
    const chainId = requestedChainId ?? ownershipRows[0].chain_id

    const { transactions: enriched, total } = await buildSafeTransactionsPage({
      userId: sub,
      safeId,
      safeAddress,
      chainId,
      log: request.log,
      fresh,
      page,
      limit,
    })

    return {
      transactions: enriched.map(
        ({ chainId: _chainId, safeId: _safeId, safeAddress: _safeAddress, safeName: _safeName, agentId: _agentId, ...tx }) => tx,
      ),
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    }
  })
}
