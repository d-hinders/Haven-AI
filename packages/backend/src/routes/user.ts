import { FastifyInstance } from 'fastify'
import pool from '../db.js'
import { authMiddleware } from '../middleware/auth.js'

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

interface WalletBody {
  wallet_address: string
}

interface SafeBody {
  safe_address: string
}

export default async function userRoutes(app: FastifyInstance): Promise<void> {
  // All routes in this plugin require auth
  app.addHook('onRequest', authMiddleware)

  // PUT /user/wallet
  app.put<{ Body: WalletBody }>('/wallet', async (request, reply) => {
    const { wallet_address } = request.body
    const { sub } = request.user as { sub: string }

    if (!wallet_address || !ETH_ADDRESS_RE.test(wallet_address)) {
      return reply.code(400).send({ error: 'Invalid Ethereum address' })
    }

    const result = await pool.query(
      `UPDATE users SET wallet_address = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, email, wallet_address, safe_address`,
      [wallet_address, sub],
    )

    return result.rows[0]
  })

  // PUT /user/safe
  app.put<{ Body: SafeBody }>('/safe', async (request, reply) => {
    const { safe_address } = request.body
    const { sub } = request.user as { sub: string }

    if (!safe_address || !ETH_ADDRESS_RE.test(safe_address)) {
      return reply.code(400).send({ error: 'Invalid Ethereum address' })
    }

    const result = await pool.query(
      `UPDATE users SET safe_address = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, email, wallet_address, safe_address`,
      [safe_address, sub],
    )

    return result.rows[0]
  })
}
