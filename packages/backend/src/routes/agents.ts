import { FastifyInstance } from 'fastify'
import crypto from 'crypto'
import pool from '../db.js'
import { authMiddleware } from '../middleware/auth.js'

// ── Types ──────────────────────────────────────────────────────────

interface CreateAgentBody {
  name: string
  description?: string
  delegate_address: string
  safe_id?: string
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

interface SafeInfoRow {
  safe_address: string | null
  safe_name: string | null
  safe_chain_id: number | null
}

interface AgentRow {
  id: string
  user_id: string
  name: string
  description: string | null
  delegate_address: string | null
  safe_id: string | null
  safe_address: string | null
  safe_name: string | null
  safe_chain_id: number | null
  api_key_prefix: string | null
  status: string
  created_at: string
  mcp_last_seen_at: string | null
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

  // GET /agents — list agents with their on-chain allowance config
  app.get('/', async (request) => {
    const { sub } = request.user as { sub: string }

    const agentResult = await pool.query<AgentRow>(
      `SELECT a.id, a.name, a.description, a.delegate_address,
              a.safe_id, us.safe_address, us.name as safe_name, us.chain_id AS safe_chain_id,
              a.api_key_prefix, a.status, a.created_at,
              (SELECT MAX(ati.created_at) FROM agent_tool_invocations ati WHERE ati.agent_id = a.id) AS mcp_last_seen_at
       FROM agents a
       LEFT JOIN user_safes us ON a.safe_id = us.id
       WHERE a.user_id = $1
       ORDER BY a.created_at DESC`,
      [sub],
    )

    if (agentResult.rows.length === 0) {
      return { agents: [] }
    }

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

  // GET /agents/:id — fetch one agent with its on-chain allowance config
  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { id } = request.params

    const agentResult = await pool.query<AgentRow>(
      `SELECT a.id, a.name, a.description, a.delegate_address,
              a.safe_id, us.safe_address, us.name as safe_name, us.chain_id AS safe_chain_id,
              a.api_key_prefix, a.status, a.created_at,
              (SELECT MAX(ati.created_at) FROM agent_tool_invocations ati WHERE ati.agent_id = a.id) AS mcp_last_seen_at
       FROM agents a
       LEFT JOIN user_safes us ON a.safe_id = us.id
       WHERE a.user_id = $1 AND a.id = $2
       LIMIT 1`,
      [sub, id],
    )

    const agent = agentResult.rows[0]
    if (!agent) {
      return reply.code(404).send({ error: 'Agent not found' })
    }

    const allowanceResult = await pool.query<AllowanceRow>(
      `SELECT id, agent_id, token_address, token_symbol, allowance_amount, reset_period_min
       FROM agent_allowances WHERE agent_id = $1 ORDER BY created_at ASC`,
      [id],
    )

    return {
      ...agent,
      allowances: allowanceResult.rows,
    }
  })

  // POST /agents — create agent with delegate address and on-chain allowance config
  app.post<{ Body: CreateAgentBody }>('/', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { name, description, delegate_address, safe_id, allowances } = request.body

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return reply.code(400).send({ error: 'Name is required' })
    }
    if (!delegate_address || !isValidAddress(delegate_address)) {
      return reply.code(400).send({ error: 'Valid delegate address is required' })
    }

    // Validate safe_id belongs to the user (if provided)
    let resolvedSafeId: string | null = null
    if (safe_id) {
      const safeCheck = await pool.query(
        'SELECT id FROM user_safes WHERE id = $1 AND user_id = $2',
        [safe_id, sub],
      )
      if (safeCheck.rows.length === 0) {
        return reply.code(400).send({ error: 'Invalid Safe — not found or not yours' })
      }
      resolvedSafeId = safe_id
    } else {
      const defaultSafe = await pool.query(
        'SELECT id FROM user_safes WHERE user_id = $1 AND is_default = true LIMIT 1',
        [sub],
      )
      if (defaultSafe.rows.length > 0) {
        resolvedSafeId = defaultSafe.rows[0].id
      }
    }

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
    const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex')
    const apiKeyPrefix = apiKey.slice(0, 12)

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      const agentResult = await client.query<AgentRow>(
        `INSERT INTO agents (user_id, name, description, delegate_address, api_key_hash, api_key_prefix, safe_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, name, description, delegate_address, safe_id, api_key_prefix, status, created_at`,
        [sub, name.trim(), description?.trim() ?? null, delegate_address.toLowerCase(), apiKeyHash, apiKeyPrefix, resolvedSafeId],
      )
      const agent = agentResult.rows[0]
      const safeInfoResult = resolvedSafeId
        ? await client.query<SafeInfoRow>(
            `SELECT safe_address, name AS safe_name, chain_id AS safe_chain_id
             FROM user_safes WHERE id = $1`,
            [resolvedSafeId],
          )
        : null
      const safeInfo = safeInfoResult?.rows[0] ?? {
        safe_address: null,
        safe_name: null,
        safe_chain_id: null,
      }

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
      return reply.code(201).send({
        ...agent,
        ...safeInfo,
        api_key: apiKey,
        allowances: savedAllowances,
      })
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })

  // PUT /agents/:id — update agent name/description
  app.put<{ Params: { id: string }; Body: UpdateAgentBody }>(
    '/:id',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { id } = request.params
      const { name, description } = request.body

      const result = await pool.query<AgentRow>(
        `WITH updated AS (
           UPDATE agents
           SET name        = COALESCE($3, name),
               description = COALESCE($4, description),
               updated_at  = NOW()
           WHERE id = $1 AND user_id = $2
           RETURNING id, name, description, delegate_address, safe_id, api_key_prefix, status, created_at
         )
         SELECT updated.id, updated.name, updated.description, updated.delegate_address,
                updated.safe_id, us.safe_address, us.name AS safe_name, us.chain_id AS safe_chain_id,
                updated.api_key_prefix, updated.status, updated.created_at
         FROM updated
         LEFT JOIN user_safes us ON updated.safe_id = us.id`,
        [id, sub, name?.trim() ?? null, description?.trim() ?? null],
      )

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Agent not found' })
      }

      const allowanceResult = await pool.query<AllowanceRow>(
        `SELECT id, agent_id, token_address, token_symbol, allowance_amount, reset_period_min
         FROM agent_allowances WHERE agent_id = $1`,
        [id],
      )

      return {
        ...result.rows[0],
        allowances: allowanceResult.rows,
      }
    },
  )

  // DELETE /agents/:id
  app.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { id } = request.params

    const result = await pool.query(
      `DELETE FROM agents
       WHERE id = $1 AND user_id = $2 AND status = 'revoked'
       RETURNING id`,
      [id, sub],
    )

    if (result.rows.length === 0) {
      const existing = await pool.query(
        'SELECT id FROM agents WHERE id = $1 AND user_id = $2',
        [id, sub],
      )
      if (existing.rows.length === 0) {
        return reply.code(404).send({ error: 'Agent not found' })
      }
      return reply.code(409).send({ error: 'Only revoked agents can be deleted' })
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
         WHERE id = $1 AND user_id = $2 AND status IN ('active', 'paused')
         RETURNING id`,
        [id, sub],
      )

      if (result.rows.length === 0) {
        return reply
          .code(404)
          .send({ error: 'Agent not found or cannot be revoked' })
      }

      return { success: true }
    },
  )

  // POST /agents/:id/pause — block new API-initiated payments in Haven
  app.post<{ Params: { id: string } }>(
    '/:id/pause',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { id } = request.params

      const result = await pool.query(
        `UPDATE agents SET status = 'paused', updated_at = NOW()
         WHERE id = $1 AND user_id = $2 AND status = 'active'
         RETURNING id`,
        [id, sub],
      )

      if (result.rows.length === 0) {
        return reply
          .code(404)
          .send({ error: 'Agent not found or cannot be paused' })
      }

      return { success: true }
    },
  )

  // POST /agents/:id/resume — restore API-initiated payments in Haven
  app.post<{ Params: { id: string } }>(
    '/:id/resume',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { id } = request.params

      const result = await pool.query(
        `UPDATE agents SET status = 'active', updated_at = NOW()
         WHERE id = $1 AND user_id = $2 AND status = 'paused'
         RETURNING id`,
        [id, sub],
      )

      if (result.rows.length === 0) {
        return reply
          .code(404)
          .send({ error: 'Agent not found or cannot be resumed' })
      }

      return { success: true }
    },
  )

  // POST /agents/:id/allowances — add/update an allowance record (mirrors on-chain)
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
    const { token_address, token_symbol, allowance_amount, reset_period_min } = request.body

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

  // DELETE /agents/:id/allowances/:tokenAddress
  app.delete<{ Params: { id: string; tokenAddress: string } }>(
    '/:id/allowances/:tokenAddress',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { id, tokenAddress } = request.params

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
