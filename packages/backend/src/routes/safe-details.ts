import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import pool from '../db.js'
import { getSafeDetails } from '../lib/safe-details.js'

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

export default async function safeDetailRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  app.get<{ Params: { safeAddress: string } }>(
    '/:safeAddress/details',
    async (request, reply) => {
      const { safeAddress } = request.params
      const { sub } = request.user as { sub: string }

      if (!ETH_ADDRESS_RE.test(safeAddress)) {
        return reply.code(400).send({ error: 'Invalid address' })
      }

      // Verify ownership and get chain_id
      const userResult = await pool.query<{ id: string; chain_id: number }>(
        'SELECT id, chain_id FROM user_safes WHERE user_id = $1 AND LOWER(safe_address) = LOWER($2)',
        [sub, safeAddress],
      )
      if (userResult.rows.length === 0) {
        return reply.code(403).send({ error: 'Not your Safe' })
      }

      const chainId = userResult.rows[0].chain_id
      return getSafeDetails(safeAddress, chainId)
    },
  )
}
