import { FastifyInstance } from 'fastify'
import crypto from 'crypto'
import pool from '../db.js'
import { authMiddleware } from '../middleware/auth.js'

interface CreateAgentBody {
  name: string
  type: string
  monthly_limit: number
  per_tx_limit: number
  allowed_assets: string[]
  recipient_address?: string
}

interface UpdateAgentBody {
  name?: string
  monthly_limit?: number
  per_tx_limit?: number
  recipient_address?: string | null
}

interface Agent {
  id: string
  user_id: string
  name: string
  type: string
  monthly_limit: string
  per_tx_limit: string
  allowed_assets: string[]
  recipient_address: string | null
  api_key: string
  status: string
  created_at: string
}

export default async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  // GET /agents
  app.get('/', async (request) => {
    const { sub } = request.user as { sub: string }
    const result = await pool.query<Agent>(
      `SELECT id, name, type, monthly_limit, per_tx_limit, allowed_assets,
              recipient_address, api_key, status, created_at
       FROM agents WHERE user_id = $1 ORDER BY created_at DESC`,
      [sub],
    )
    return { agents: result.rows }
  })

  // POST /agents
  app.post<{ Body: CreateAgentBody }>('/', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { name, type, monthly_limit, per_tx_limit, allowed_assets, recipient_address } = request.body

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return reply.code(400).send({ error: 'Name is required' })
    }
    if (typeof monthly_limit !== 'number' || monthly_limit <= 0) {
      return reply.code(400).send({ error: 'monthly_limit must be a positive number' })
    }
    if (typeof per_tx_limit !== 'number' || per_tx_limit <= 0) {
      return reply.code(400).send({ error: 'per_tx_limit must be a positive number' })
    }
    if (per_tx_limit > monthly_limit) {
      return reply.code(400).send({ error: 'per_tx_limit cannot exceed monthly_limit' })
    }

    const apiKey = `sk_agent_${crypto.randomBytes(24).toString('hex')}`

    const result = await pool.query<Agent>(
      `INSERT INTO agents (user_id, name, type, monthly_limit, per_tx_limit, allowed_assets, recipient_address, api_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, name, type, monthly_limit, per_tx_limit, allowed_assets,
                 recipient_address, api_key, status, created_at`,
      [
        sub,
        name.trim(),
        type ?? 'custom',
        monthly_limit,
        per_tx_limit,
        allowed_assets ?? ['USDC'],
        recipient_address ?? null,
        apiKey,
      ],
    )

    return reply.code(201).send(result.rows[0])
  })

  // PUT /agents/:id
  app.put<{ Params: { id: string }; Body: UpdateAgentBody }>('/:id', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { id } = request.params
    const { name, monthly_limit, per_tx_limit, recipient_address } = request.body

    if (monthly_limit !== undefined && monthly_limit <= 0) {
      return reply.code(400).send({ error: 'monthly_limit must be a positive number' })
    }
    if (per_tx_limit !== undefined && per_tx_limit <= 0) {
      return reply.code(400).send({ error: 'per_tx_limit must be a positive number' })
    }

    const result = await pool.query<Agent>(
      `UPDATE agents
       SET name              = COALESCE($3, name),
           monthly_limit     = COALESCE($4, monthly_limit),
           per_tx_limit      = COALESCE($5, per_tx_limit),
           recipient_address = CASE WHEN $6::text IS DISTINCT FROM 'UNCHANGED' THEN $6::varchar ELSE recipient_address END,
           updated_at        = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING id, name, type, monthly_limit, per_tx_limit, allowed_assets,
                 recipient_address, api_key, status, created_at`,
      [
        id,
        sub,
        name?.trim() ?? null,
        monthly_limit ?? null,
        per_tx_limit ?? null,
        recipient_address !== undefined ? (recipient_address ?? null) : 'UNCHANGED',
      ],
    )

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: 'Agent not found' })
    }

    return result.rows[0]
  })

  // DELETE /agents/:id
  app.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { id } = request.params

    const result = await pool.query(
      'DELETE FROM agents WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, sub],
    )

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: 'Agent not found' })
    }

    return { success: true }
  })

  // POST /agents/:id/revoke
  app.post<{ Params: { id: string } }>('/:id/revoke', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { id } = request.params

    const result = await pool.query(
      `UPDATE agents SET status = 'revoked', updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND status = 'active'
       RETURNING id`,
      [id, sub],
    )

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: 'Agent not found or already revoked' })
    }

    return { success: true }
  })
}
