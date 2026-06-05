import { FastifyInstance } from 'fastify'
import pool from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import {
  normalizeAgentAllowance,
  normalizeAgentAllowances,
  normalizeAgentAllowanceTokenAddress,
} from '../lib/agent-allowance-validation.js'

// ── Types ──────────────────────────────────────────────────────────

interface CreateSelfSignAgentBody {
  name: string
  description?: string
  delegate_address: string
  safe_id?: string
  allowances?: unknown
}

interface UpdateSelfSignAgentBody {
  name?: string
  description?: string
}

interface AgentRow {
  id: string
  user_id: string
  name: string
  description: string | null
  delegate_address: string
  safe_id: string | null
  safe_address: string | null
  safe_name: string | null
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

export default async function selfSignAgentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  // GET /self-sign-agents — list agents with on-chain allowance config
  app.get('/', async (request) => {
    const { sub } = request.user as { sub: string }

    const agentResult = await pool.query<AgentRow>(
      `SELECT a.id, a.name, a.description, a.delegate_address,
              a.safe_id, us.safe_address, us.name AS safe_name,
              a.status, a.created_at
       FROM self_sign_agents a
       LEFT JOIN user_safes us ON a.safe_id = us.id
       WHERE a.user_id = $1
       ORDER BY a.created_at DESC`,
      [sub],
    )

    if (agentResult.rows.length === 0) return { agents: [] }

    const agentIds = agentResult.rows.map((a) => a.id)

    const allowanceResult = await pool.query<AllowanceRow>(
      `SELECT id, agent_id, token_address, token_symbol, allowance_amount, reset_period_min
       FROM self_sign_agent_allowances WHERE agent_id = ANY($1) ORDER BY created_at ASC`,
      [agentIds],
    )

    const allowancesByAgent = new Map<string, AllowanceRow[]>()
    for (const row of allowanceResult.rows) {
      const existing = allowancesByAgent.get(row.agent_id) ?? []
      existing.push(row)
      allowancesByAgent.set(row.agent_id, existing)
    }

    return {
      agents: agentResult.rows.map((agent) => ({
        ...agent,
        allowances: allowancesByAgent.get(agent.id) ?? [],
        auth_type: 'self_sign',
      })),
    }
  })

  // POST /self-sign-agents — create agent
  app.post<{ Body: CreateSelfSignAgentBody }>('/', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const {
      name,
      description,
      delegate_address,
      safe_id,
      allowances,
    } = request.body

    if (!name?.trim()) return reply.code(400).send({ error: 'name is required' })
    if (!delegate_address || !isValidAddress(delegate_address)) {
      return reply.code(400).send({ error: 'Valid delegate_address is required' })
    }
    const normalizedAllowances = normalizeAgentAllowances(allowances)
    if (!normalizedAllowances.ok) {
      return reply.code(400).send({ error: normalizedAllowances.error })
    }

    if (safe_id) {
      const safeCheck = await pool.query(
        'SELECT id FROM user_safes WHERE id = $1 AND user_id = $2',
        [safe_id, sub],
      )
      if (safeCheck.rows.length === 0) {
        return reply.code(400).send({ error: 'Safe not found or does not belong to you' })
      }
    }

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      const agentResult = await client.query<{ id: string }>(
        `INSERT INTO self_sign_agents (user_id, name, description, delegate_address, safe_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [sub, name.trim(), description ?? null, delegate_address.toLowerCase(), safe_id ?? null],
      )
      const agentId = agentResult.rows[0].id

      for (const allowance of normalizedAllowances.value) {
        await client.query(
          `INSERT INTO self_sign_agent_allowances
             (agent_id, token_address, token_symbol, allowance_amount, reset_period_min)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (agent_id, token_address) DO UPDATE
             SET allowance_amount = $4, reset_period_min = $5, token_symbol = $3,
                 updated_at = NOW()`,
          [
            agentId,
            allowance.token_address,
            allowance.token_symbol,
            allowance.allowance_amount,
            allowance.reset_period_min,
          ],
        )
      }

      await client.query('COMMIT')

      const agent = await pool.query(
        `SELECT a.id, a.name, a.description, a.delegate_address,
                a.safe_id, us.safe_address, us.name AS safe_name, a.status, a.created_at
         FROM self_sign_agents a
         LEFT JOIN user_safes us ON a.safe_id = us.id
         WHERE a.id = $1`,
        [agentId],
      )

      return { ...agent.rows[0], allowances: normalizedAllowances.value, auth_type: 'self_sign' }
    } catch (err: unknown) {
      await client.query('ROLLBACK')
      if ((err as { code?: string }).code === '23505') {
        return reply.code(409).send({ error: 'An agent with this delegate address already exists' })
      }
      throw err
    } finally {
      client.release()
    }
  })

  // PUT /self-sign-agents/:id — update name/description
  app.put<{ Params: { id: string }; Body: UpdateSelfSignAgentBody }>(
    '/:id',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { id } = request.params
      const { name, description } = request.body

      const agentCheck = await pool.query(
        'SELECT id FROM self_sign_agents WHERE id = $1 AND user_id = $2',
        [id, sub],
      )
      if (agentCheck.rows.length === 0) return reply.code(404).send({ error: 'Agent not found' })

      await pool.query(
        `UPDATE self_sign_agents
         SET name = COALESCE($1, name),
             description = COALESCE($2, description),
             updated_at = NOW()
         WHERE id = $3`,
        [name?.trim() ?? null, description ?? null, id],
      )

      const agent = await pool.query(
        `SELECT a.id, a.name, a.description, a.delegate_address,
                a.safe_id, us.safe_address, us.name AS safe_name, a.status, a.created_at
         FROM self_sign_agents a
         LEFT JOIN user_safes us ON a.safe_id = us.id
         WHERE a.id = $1`,
        [id],
      )
      return { ...agent.rows[0], auth_type: 'self_sign' }
    },
  )

  // DELETE /self-sign-agents/:id
  app.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { id } = request.params

    const result = await pool.query(
      'DELETE FROM self_sign_agents WHERE id = $1 AND user_id = $2 RETURNING id',
      [id, sub],
    )
    if (result.rows.length === 0) return reply.code(404).send({ error: 'Agent not found' })
    return { success: true }
  })

  // POST /self-sign-agents/:id/revoke
  app.post<{ Params: { id: string } }>('/:id/revoke', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { id } = request.params

    const result = await pool.query(
      `UPDATE self_sign_agents SET status = 'revoked', updated_at = NOW()
       WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, sub],
    )
    if (result.rows.length === 0) return reply.code(404).send({ error: 'Agent not found' })
    return { success: true }
  })

  // POST /self-sign-agents/:id/allowances
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
    const normalizedAllowance = normalizeAgentAllowance(request.body)
    if (!normalizedAllowance.ok) {
      return reply.code(400).send({ error: normalizedAllowance.error })
    }

    const agentCheck = await pool.query<{ id: string; status: string }>(
      'SELECT id, status FROM self_sign_agents WHERE id = $1 AND user_id = $2',
      [id, sub],
    )
    if (agentCheck.rows.length === 0) return reply.code(404).send({ error: 'Agent not found' })
    if (agentCheck.rows[0].status === 'revoked') {
      return reply.code(409).send({ error: 'Revoked agent rules cannot be changed' })
    }

    const { token_address, token_symbol, allowance_amount, reset_period_min } = normalizedAllowance.value
    const result = await pool.query<AllowanceRow>(
      `INSERT INTO self_sign_agent_allowances
         (agent_id, token_address, token_symbol, allowance_amount, reset_period_min)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (agent_id, token_address) DO UPDATE
         SET allowance_amount = $4, reset_period_min = $5, token_symbol = $3,
             updated_at = NOW()
       RETURNING id, agent_id, token_address, token_symbol, allowance_amount, reset_period_min`,
      [id, token_address, token_symbol, allowance_amount, reset_period_min],
    )
    return result.rows[0]
  })

  // DELETE /self-sign-agents/:id/allowances/:tokenAddress
  app.delete<{ Params: { id: string; tokenAddress: string } }>(
    '/:id/allowances/:tokenAddress',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { id, tokenAddress } = request.params
      const normalizedTokenAddress = normalizeAgentAllowanceTokenAddress(tokenAddress)
      if (!normalizedTokenAddress.ok) {
        return reply.code(400).send({ error: normalizedTokenAddress.error })
      }

      const agentCheck = await pool.query<{ id: string; status: string }>(
        'SELECT id, status FROM self_sign_agents WHERE id = $1 AND user_id = $2',
        [id, sub],
      )
      if (agentCheck.rows.length === 0) return reply.code(404).send({ error: 'Agent not found' })
      if (agentCheck.rows[0].status === 'revoked') {
        return reply.code(409).send({ error: 'Revoked agent rules cannot be changed' })
      }

      const result = await pool.query(
        'DELETE FROM self_sign_agent_allowances WHERE agent_id = $1 AND token_address = $2 RETURNING id',
        [id, normalizedTokenAddress.value],
      )
      if (result.rows.length === 0) return reply.code(404).send({ error: 'Allowance not found' })
      return { success: true }
    },
  )
}
