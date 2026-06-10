import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import pool from '../db.js'
import { isSupportedChain } from '../lib/chains.js'
import { fetchPortfolioForSafe } from '../lib/portfolio.js'

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

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

      // Verify ownership and get chain_id
      const ownershipSql = requestedChainId === null
        ? 'SELECT id, chain_id FROM user_safes WHERE user_id = $1 AND LOWER(safe_address) = LOWER($2)'
        : 'SELECT id, chain_id FROM user_safes WHERE user_id = $1 AND LOWER(safe_address) = LOWER($2) AND chain_id = $3'
      const ownershipParams = requestedChainId === null
        ? [sub, safeAddress]
        : [sub, safeAddress, requestedChainId]
      const userResult = await pool.query<{ id: string; chain_id: number }>(
        ownershipSql,
        ownershipParams,
      )
      if (userResult.rows.length === 0) {
        return reply.code(403).send({ error: 'Not your Safe' })
      }
      if (requestedChainId === null && userResult.rows.length > 1) {
        return reply.code(400).send({ error: 'chain_id required' })
      }

      const chainId = requestedChainId ?? userResult.rows[0].chain_id
      return fetchPortfolioForSafe(chainId, safeAddress)
    },
  )
}
