import { FastifyInstance } from 'fastify'
import pool from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { isSupportedChain } from '../lib/chains.js'
import { relaySafeDeploy } from '../lib/safe-deployer.js'

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

// ── Types ─────────────────────────────────────────────────────────

interface UserSafeRow {
  id: string
  user_id: string
  safe_address: string
  chain_id: number
  name: string
  is_default: boolean
  created_at: string
  updated_at: string
}

interface AddSafeBody {
  safe_address: string
  chain_id?: number
  name?: string
}

interface DeploySafeBody {
  chain_id?: number
  owner_address: string
  name?: string
}

interface RenameSafeBody {
  name: string
}

// ── Routes ────────────────────────────────────────────────────────

export default async function userSafesRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  // GET /user/safes — list all Safes for the authenticated user
  app.get('/', async (request) => {
    const { sub } = request.user as { sub: string }

    const result = await pool.query<UserSafeRow>(
      `SELECT id, safe_address, chain_id, name, is_default, created_at
       FROM user_safes
       WHERE user_id = $1
       ORDER BY created_at ASC`,
      [sub],
    )

    return { safes: result.rows }
  })

  // POST /user/safes/deploy — relay-sponsored Safe deployment
  // The relayer pays gas; the caller's owner_address becomes the sole owner.
  app.post<{ Body: DeploySafeBody }>('/deploy', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { chain_id = 100, owner_address, name } = request.body

    if (!owner_address || !ETH_ADDRESS_RE.test(owner_address)) {
      return reply.code(400).send({ error: 'Invalid owner address' })
    }

    if (!isSupportedChain(chain_id)) {
      return reply.code(400).send({ error: `Unsupported chain: ${chain_id}` })
    }

    let safeAddress: string
    let txHash: string
    try {
      const result = await relaySafeDeploy(chain_id, owner_address)
      safeAddress = result.safeAddress
      txHash = result.txHash
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Relay deployment failed'
      return reply.code(500).send({ error: msg })
    }

    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM user_safes WHERE user_id = $1`,
      [sub],
    )
    const isFirst = Number(countResult.rows[0].count) === 0

    const result = await pool.query<UserSafeRow>(
      `INSERT INTO user_safes (user_id, safe_address, chain_id, name, is_default)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, safe_address, chain_id, name, is_default, created_at`,
      [sub, safeAddress, chain_id, name?.trim() || 'My Safe', isFirst],
    )

    if (isFirst) {
      await pool.query(
        `UPDATE users SET safe_address = $1, wallet_address = $2, updated_at = NOW() WHERE id = $3`,
        [safeAddress, owner_address, sub],
      )
    }

    return reply.code(201).send({ ...result.rows[0], txHash })
  })

  // POST /user/safes — add (import) an existing Safe
  app.post<{ Body: AddSafeBody }>('/', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { safe_address, chain_id = 100, name } = request.body

    if (!safe_address || !ETH_ADDRESS_RE.test(safe_address)) {
      return reply.code(400).send({ error: 'Invalid Ethereum address' })
    }

    if (!isSupportedChain(chain_id)) {
      return reply.code(400).send({ error: `Unsupported chain: ${chain_id}` })
    }

    // Check if already added (same address + chain)
    const existing = await pool.query(
      `SELECT id FROM user_safes WHERE user_id = $1 AND LOWER(safe_address) = LOWER($2) AND chain_id = $3`,
      [sub, safe_address, chain_id],
    )
    if (existing.rows.length > 0) {
      return reply.code(409).send({ error: 'This Safe is already linked to your account' })
    }

    // Check if user has any Safes yet (first one becomes default)
    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM user_safes WHERE user_id = $1`,
      [sub],
    )
    const isFirst = Number(countResult.rows[0].count) === 0

    const result = await pool.query<UserSafeRow>(
      `INSERT INTO user_safes (user_id, safe_address, chain_id, name, is_default)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, safe_address, chain_id, name, is_default, created_at`,
      [sub, safe_address, chain_id, name?.trim() || 'My Safe', isFirst],
    )

    // Also update legacy users.safe_address if this is the first Safe
    if (isFirst) {
      await pool.query(
        `UPDATE users SET safe_address = $1, updated_at = NOW() WHERE id = $2`,
        [safe_address, sub],
      )
    }

    return reply.code(201).send(result.rows[0])
  })

  // PUT /user/safes/:safeId — rename a Safe
  app.put<{ Params: { safeId: string }; Body: RenameSafeBody }>(
    '/:safeId',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { safeId } = request.params
      const { name } = request.body

      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return reply.code(400).send({ error: 'Name is required' })
      }

      const result = await pool.query<UserSafeRow>(
        `UPDATE user_safes SET name = $1, updated_at = NOW()
         WHERE id = $2 AND user_id = $3
         RETURNING id, safe_address, chain_id, name, is_default, created_at`,
        [name.trim(), safeId, sub],
      )

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Safe not found' })
      }

      return result.rows[0]
    },
  )

  // PUT /user/safes/:safeId/default — set a Safe as the default
  app.put<{ Params: { safeId: string } }>(
    '/:safeId/default',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { safeId } = request.params

      // Verify the Safe belongs to the user
      const check = await pool.query<UserSafeRow>(
        `SELECT id, safe_address FROM user_safes WHERE id = $1 AND user_id = $2`,
        [safeId, sub],
      )
      if (check.rows.length === 0) {
        return reply.code(404).send({ error: 'Safe not found' })
      }

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        // Clear all defaults for this user
        await client.query(
          `UPDATE user_safes SET is_default = false, updated_at = NOW()
           WHERE user_id = $1`,
          [sub],
        )

        // Set the new default
        await client.query(
          `UPDATE user_safes SET is_default = true, updated_at = NOW()
           WHERE id = $1`,
          [safeId],
        )

        // Update legacy users.safe_address
        await client.query(
          `UPDATE users SET safe_address = $1, updated_at = NOW() WHERE id = $2`,
          [check.rows[0].safe_address, sub],
        )

        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }

      return { success: true }
    },
  )

  // DELETE /user/safes/:safeId — remove (unlink) a Safe
  app.delete<{ Params: { safeId: string } }>(
    '/:safeId',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { safeId } = request.params

      // Check the Safe exists and belongs to user
      const check = await pool.query<UserSafeRow>(
        `SELECT id, is_default FROM user_safes WHERE id = $1 AND user_id = $2`,
        [safeId, sub],
      )
      if (check.rows.length === 0) {
        return reply.code(404).send({ error: 'Safe not found' })
      }

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        // Orphan agents linked to this Safe
        await client.query(
          `UPDATE agents SET safe_id = NULL, updated_at = NOW() WHERE safe_id = $1`,
          [safeId],
        )

        // Delete the Safe link
        await client.query(
          `DELETE FROM user_safes WHERE id = $1`,
          [safeId],
        )

        // If this was the default, promote the oldest remaining Safe
        if (check.rows[0].is_default) {
          const next = await client.query<UserSafeRow>(
            `SELECT id, safe_address FROM user_safes
             WHERE user_id = $1
             ORDER BY created_at ASC
             LIMIT 1`,
            [sub],
          )
          if (next.rows.length > 0) {
            await client.query(
              `UPDATE user_safes SET is_default = true, updated_at = NOW() WHERE id = $1`,
              [next.rows[0].id],
            )
            await client.query(
              `UPDATE users SET safe_address = $1, updated_at = NOW() WHERE id = $2`,
              [next.rows[0].safe_address, sub],
            )
          } else {
            // No Safes left — clear legacy column
            await client.query(
              `UPDATE users SET safe_address = NULL, updated_at = NOW() WHERE id = $1`,
              [sub],
            )
          }
        }

        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }

      return { success: true }
    },
  )
}
