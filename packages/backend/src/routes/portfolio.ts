import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { findAccountOwnership } from '../infra/repositories/transaction-history.js'
import { isSupportedChain } from '../domain/chains.js'
import { fetchPortfolioForAccount } from '../modules/accounts/index.js'

/**
 * The spec (`chain_id: integer, minimum: 1`) is the shape check, enforced
 * before the handler since #3030; ajv has coerced the value to a number by
 * the time it arrives, so this only reads it. Whether the chain is one Haven
 * serves is not a shape question — `isSupportedChain` below stays.
 */
function parseChainId(value: unknown): number | null {
  if (value === undefined) return null
  return Number(value)
}

export default async function portfolioRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  app.get<{ Params: { accountAddress: string }; Querystring: { chain_id?: string } }>(
    '/:accountAddress',
    async (request, reply) => {
      const { accountAddress } = request.params
      const requestedChainId = parseChainId(request.query.chain_id)
      const { sub } = request.user as { sub: string }

      if (requestedChainId !== null && !isSupportedChain(requestedChainId)) {
        return reply.code(400).send({ error: `Unsupported chain: ${requestedChainId}` })
      }

      // Verify ownership and get chain_id (repository query, #999 — the same
      // ownership check the transaction-history route runs).
      const ownedAccounts = await findAccountOwnership(sub, accountAddress, requestedChainId)
      if (ownedAccounts.length === 0) {
        return reply.code(403).send({ error: 'Not your Safe' })
      }
      if (requestedChainId === null && ownedAccounts.length > 1) {
        return reply.code(400).send({ error: 'chain_id required' })
      }

      const chainId = requestedChainId ?? ownedAccounts[0].chain_id
      return fetchPortfolioForAccount(chainId, accountAddress)
    },
  )
}
