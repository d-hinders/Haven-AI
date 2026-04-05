import { FastifyInstance } from 'fastify'
import crypto from 'crypto'
import pool from '../db.js'
import { authMiddleware } from '../middleware/auth.js'

// ── Types ──────────────────────────────────────────────────────────

interface CreateAgentBody {
  name: string
  description?: string
  delegate_address: string
  allowances?: {
    token_address: string
    token_symbol: string
    allowance_amount: string
    reset_period_min: number
  }[]
}

interface UpdateAgentBody {
  name?: string
  description?: string
}

interface AgentRow {
  id: string
  user_id: string
  name: string
  description: string | null
  delegate_address: string | null
  api_key: string
  status: string
  created_at: string
}

interface AllowanceRow {
  id: string
  agent_id: string
  token_address: string
  token_symbol: string
  allowance_amount: string
  reset_period_min: number
}

function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr)
}

// ── Routes ─────────────────────────────────────────────────────────

export default async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  // GET /agents — list agents with their allowances
  app.get('/', async (request) => {
    const { sub } = request.user as { sub: string }

    const agentResult = await pool.query<AgentRow>(
      `SELECT id, name, description, delegate_address, api_key, status, created_at
       FROM agents WHERE user_id = $1 ORDER BY created_at DESC`,
      [sub],
    )

    if (agentResult.rows.length === 0) {
      return { agents: [] }
    }

    // Fetch allowances for all agents in one query
    const agentIds = agentResult.rows.map((a) => a.id)
    const allowanceResult = await pool.query<AllowanceRow>(
      `SELECT id, agent_id, token_address, token_symbol, allowance_amount, reset_period_min
       FROM agent_allowances WHERE agent_id = ANY($1) ORDER BY created_at ASC`,
      [agentIds],
    )

    const allowancesByAgent = new Map<string, AllowanceRow[]>()
    for (const row of allowanceResult.rows) {
      const existing = allowancesByAgent.get(row.agent_id) ?? []
      existing.push(row)
      allowancesByAgent.set(row.agent_id, existing)
    }

    const agents = agentResult.rows.map((agent) => ({
      ...agent,
      allowances: allowancesByAgent.get(agent.id) ?? [],
    }))

    return { agents }
  })

  // POST /agents — create agent with delegate address and allowances
  app.post<{ Body: CreateAgentBody }>('/', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { name, description, delegate_address, allowances } = request.body

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return reply.code(400).send({ error: 'Name is required' })
    }
    if (!delegate_address || !isValidAddress(delegate_address)) {
      return reply.code(400).send({ error: 'Valid delegate address is required' })
    }

    // Check for duplicate delegate address
    const existing = await pool.query(
      'SELECT id FROM agents WHERE user_id = $1 AND delegate_address = $2 AND status != $3',
      [sub, delegate_address.toLowerCase(), 'revoked'],
    )
    if (existing.rows.length > 0) {
      return reply
        .code(409)
        .send({ error: 'An active agent with this delegate address already exists' })
    }

    const apiKey = `sk_agent_${crypto.randomBytes(24).toString('hex')}`

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      const agentResult = await client.query<AgentRow>(
        `INSERT INTO agents (user_id, name, description, delegate_address, api_key)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, name, description, delegate_address, api_key, status, created_at`,
        [sub, name.trim(), description?.trim() ?? null, delegate_address.toLowerCase(), apiKey],
      )
      const agent = agentResult.rows[0]

      // Insert allowance records
      const savedAllowances: AllowanceRow[] = []
      if (allowances && allowances.length > 0) {
        for (const a of allowances) {
          const res = await client.query<AllowanceRow>(
            `INSERT INTO agent_allowances (agent_id, token_address, token_symbol, allowance_amount, reset_period_min)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, agent_id, token_address, token_symbol, allowance_amount, reset_period_min`,
            [
              agent.id,
              a.token_address.toLowerCase(),
              a.token_symbol,
              a.allowance_amount,
              a.reset_period_min,
            ],
          )
          savedAllowances.push(res.rows[0])
        }
      }

      await client.query('COMMIT')
      return reply.code(201).send({ ...agent, allowances: savedAllowances })
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })

  // PUT /agents/:id — update agent metadata
  app.put<{ Params: { id: string }; Body: UpdateAgentBody }>(
    '/:id',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { id } = request.params
      const { name, description } = request.body

      const result = await pool.query<AgentRow>(
        `UPDATE agents
         SET name        = COALESCE($3, name),
             description = COALESCE($4, description),
             updated_at  = NOW()
         WHERE id = $1 AND user_id = $2
         RETURNING id, name, description, delegate_address, api_key, status, created_at`,
        [id, sub, name?.trim() ?? null, description?.trim() ?? null],
      )

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Agent not found' })
      }

      // Also fetch allowances
      const allowanceResult = await pool.query<AllowanceRow>(
        `SELECT id, agent_id, token_address, token_symbol, allowance_amount, reset_period_min
         FROM agent_allowances WHERE agent_id = $1`,
        [id],
      )

      return { ...result.rows[0], allowances: allowanceResult.rows }
    },
  )

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

  // POST /agents/:id/revoke — revoke an agent
  app.post<{ Params: { id: string } }>(
    '/:id/revoke',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { id } = request.params

      const result = await pool.query(
        `UPDATE agents SET status = 'revoked', updated_at = NOW()
         WHERE id = $1 AND user_id = $2 AND status = 'active'
         RETURNING id`,
        [id, sub],
      )

      if (result.rows.length === 0) {
        return reply
          .code(404)
          .send({ error: 'Agent not found or already revoked' })
      }

      return { success: true }
    },
  )

  // POST /agents/:id/allowances — add/update an allowance record
  app.post<{
    Params: { id: string }
    Body: {
      token_address: string
      token_symbol: string
      allowance_amount: string
      reset_period_min: number
    }
  }>('/:id/allowances', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { id } = request.params
    const { token_address, token_symbol, allowance_amount, reset_period_min } =
      request.body

    // Verify agent belongs to user
    const agentCheck = await pool.query(
      'SELECT id FROM agents WHERE id = $1 AND user_id = $2',
      [id, sub],
    )
    if (agentCheck.rows.length === 0) {
      return reply.code(404).send({ error: 'Agent not found' })
    }

    const result = await pool.query<AllowanceRow>(
      `INSERT INTO agent_allowances (agent_id, token_address, token_symbol, allowance_amount, reset_period_min)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (agent_id, token_address)
       DO UPDATE SET allowance_amount = $4, reset_period_min = $5, token_symbol = $3, updated_at = NOW()
       RETURNING id, agent_id, token_address, token_symbol, allowance_amount, reset_period_min`,
      [id, token_address.toLowerCase(), token_symbol, allowance_amount, reset_period_min],
    )

    return result.rows[0]
  })

  // DELETE /agents/:id/allowances/:tokenAddress — remove an allowance record
  app.delete<{ Params: { id: string; tokenAddress: string } }>(
    '/:id/allowances/:tokenAddress',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { id, tokenAddress } = request.params

      // Verify agent belongs to user
      const agentCheck = await pool.query(
        'SELECT id FROM agents WHERE id = $1 AND user_id = $2',
        [id, sub],
      )
      if (agentCheck.rows.length === 0) {
        return reply.code(404).send({ error: 'Agent not found' })
      }

      const result = await pool.query(
        'DELETE FROM agent_allowances WHERE agent_id = $1 AND token_address = $2 RETURNING id',
        [id, tokenAddress.toLowerCase()],
      )

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Allowance not found' })
      }

      return { success: true }
    },
  )
}
