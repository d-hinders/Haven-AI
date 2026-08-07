import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { findSafeOwnership } from '../infra/repositories/transaction-history.js'
import { isSupportedChain } from '../domain/chains.js'
import { fetchPortfolioForSafe } from '../modules/accounts/index.js'
import { ETH_ADDRESS_RE } from '@haven_ai/core'

function parseChainId(value: unknown): number | null {
  if (value === undefined) return null
  if (Array.isArray(value)) return Number.NaN

  const raw = String(value).trim()
  if (!/^[1-9]\d*$/.test(raw)) return Number.NaN

  const chainId = Number(raw)
  return Number.isSafeInteger(chainId) ? chainId : Number.NaN
}

export default async function portfolioRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  app.get<{ Params: { safeAddress: string }; Querystring: { chain_id?: string } }>(
    '/:safeAddress',
    async (request, reply) => {
      const { safeAddress } = request.params
      const requestedChainId = parseChainId(request.query.chain_id)
      const { sub } = request.user as { sub: string }

      if (!ETH_ADDRESS_RE.test(safeAddress)) {
        return reply.code(400).send({ error: 'Invalid address' })
      }

      if (Number.isNaN(requestedChainId)) {
        return reply.code(400).send({ error: 'Invalid chain_id' })
      }

      if (requestedChainId !== null && !isSupportedChain(requestedChainId)) {
        return reply.code(400).send({ error: `Unsupported chain: ${requestedChainId}` })
      }

      // Verify ownership and get chain_id (repository query, #999 — the same
      // ownership check the transaction-history route runs).
      const ownedSafes = await findSafeOwnership(sub, safeAddress, requestedChainId)
      if (ownedSafes.length === 0) {
        return reply.code(403).send({ error: 'Not your Safe' })
      }
      if (requestedChainId === null && ownedSafes.length > 1) {
        return reply.code(400).send({ error: 'chain_id required' })
      }

      const chainId = requestedChainId ?? ownedSafes[0].chain_id
      return fetchPortfolioForSafe(chainId, safeAddress)
    },
  )
}
