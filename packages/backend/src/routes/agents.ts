import { FastifyInstance } from 'fastify'
import crypto from 'crypto'
import pool from '../db.js'
import { authMiddleware } from '../middleware/auth.js'

// ── Types ──────────────────────────────────────────────────────────

interface CreateAgentBody {
  name: string
  description?: string
  delegate_address: string
  restrict_recipients?: boolean
  allowed_recipients?: { address: string; label?: string }[]
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
  restrict_recipients?: boolean
  allowed_recipients?: { address: string; label?: string }[]
}

interface AgentRow {
  id: string
  user_id: string
  name: string
  description: string | null
  delegate_address: string | null
  restrict_recipients: boolean
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

interface RecipientRow {
  id: string
  agent_id: string
  address: string
  label: string | null
  created_at: string
}

function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr)
}

// ── Routes ─────────────────────────────────────────────────────────

export default async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  // GET /agents — list agents with their allowances and allowed recipients
  app.get('/', async (request) => {
    const { sub } = request.user as { sub: string }

    const agentResult = await pool.query<AgentRow>(
      `SELECT id, name, description, delegate_address, restrict_recipients, api_key, status, created_at
       FROM agents WHERE user_id = $1 ORDER BY created_at DESC`,
      [sub],
    )

    if (agentResult.rows.length === 0) {
      return { agents: [] }
    }

    const agentIds = agentResult.rows.map((a) => a.id)

    // Fetch allowances for all agents in one query
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

    // Fetch allowed recipients for all agents
    const recipientResult = await pool.query<RecipientRow>(
      `SELECT id, agent_id, address, label, created_at
       FROM agent_allowed_recipients WHERE agent_id = ANY($1) ORDER BY created_at ASC`,
      [agentIds],
    )

    const recipientsByAgent = new Map<string, RecipientRow[]>()
    for (const row of recipientResult.rows) {
      const existing = recipientsByAgent.get(row.agent_id) ?? []
      existing.push(row)
      recipientsByAgent.set(row.agent_id, existing)
    }

    const agents = agentResult.rows.map((agent) => ({
      ...agent,
      allowances: allowancesByAgent.get(agent.id) ?? [],
      allowed_recipients: recipientsByAgent.get(agent.id) ?? [],
    }))

    return { agents }
  })

  // POST /agents — create agent with delegate address, allowances, and optional recipient restrictions
  app.post<{ Body: CreateAgentBody }>('/', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { name, description, delegate_address, allowances, restrict_recipients, allowed_recipients } = request.body

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
        `INSERT INTO agents (user_id, name, description, delegate_address, api_key, restrict_recipients)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, name, description, delegate_address, restrict_recipients, api_key, status, created_at`,
        [sub, name.trim(), description?.trim() ?? null, delegate_address.toLowerCase(), apiKey, restrict_recipients ?? false],
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

      // Insert allowed recipients
      const savedRecipients: RecipientRow[] = []
      if (restrict_recipients && allowed_recipients && allowed_recipients.length > 0) {
        for (const r of allowed_recipients) {
          if (!isValidAddress(r.address)) continue
          const res = await client.query<RecipientRow>(
            `INSERT INTO agent_allowed_recipients (agent_id, address, label)
             VALUES ($1, $2, $3)
             ON CONFLICT (agent_id, address) DO NOTHING
             RETURNING id, agent_id, address, label, created_at`,
            [agent.id, r.address.toLowerCase(), r.label?.trim() ?? null],
          )
          if (res.rows[0]) savedRecipients.push(res.rows[0])
        }
      }

      await client.query('COMMIT')
      return reply.code(201).send({
        ...agent,
        allowances: savedAllowances,
        allowed_recipients: savedRecipients,
      })
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  })

  // PUT /agents/:id — update agent metadata + recipient restrictions
  app.put<{ Params: { id: string }; Body: UpdateAgentBody }>(
    '/:id',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { id } = request.params
      const { name, description, restrict_recipients, allowed_recipients } = request.body

      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        const result = await client.query<AgentRow>(
          `UPDATE agents
           SET name                = COALESCE($3, name),
               description         = COALESCE($4, description),
               restrict_recipients = COALESCE($5, restrict_recipients),
               updated_at          = NOW()
           WHERE id = $1 AND user_id = $2
           RETURNING id, name, description, delegate_address, restrict_recipients, api_key, status, created_at`,
          [id, sub, name?.trim() ?? null, description?.trim() ?? null, restrict_recipients ?? null],
        )

        if (result.rows.length === 0) {
          await client.query('ROLLBACK')
          return reply.code(404).send({ error: 'Agent not found' })
        }

        // If allowed_recipients is provided, replace the full set
        if (allowed_recipients !== undefined) {
          await client.query(
            'DELETE FROM agent_allowed_recipients WHERE agent_id = $1',
            [id],
          )
          if (allowed_recipients.length > 0) {
            for (const r of allowed_recipients) {
              if (!isValidAddress(r.address)) continue
              await client.query(
                `INSERT INTO agent_allowed_recipients (agent_id, address, label)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (agent_id, address) DO NOTHING`,
                [id, r.address.toLowerCase(), r.label?.trim() ?? null],
              )
            }
          }
        }

        await client.query('COMMIT')

        // Fetch updated data
        const allowanceResult = await pool.query<AllowanceRow>(
          `SELECT id, agent_id, token_address, token_symbol, allowance_amount, reset_period_min
           FROM agent_allowances WHERE agent_id = $1`,
          [id],
        )
        const recipientResult = await pool.query<RecipientRow>(
          `SELECT id, agent_id, address, label, created_at
           FROM agent_allowed_recipients WHERE agent_id = $1`,
          [id],
        )

        return {
          ...result.rows[0],
          allowances: allowanceResult.rows,
          allowed_recipients: recipientResult.rows,
        }
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }
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
      approval_threshold?: string | null
    }
  }>('/:id/allowances', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { id } = request.params
    const { token_address, token_symbol, allowance_amount, reset_period_min, approval_threshold } =
      request.body

    // Verify agent belongs to user
    const agentCheck = await pool.query(
      'SELECT id FROM agents WHERE id = $1 AND user_id = $2',
      [id, sub],
    )
    if (agentCheck.rows.length === 0) {
      return reply.code(404).send({ error: 'Agent not found' })
    }

    const result = await pool.query<AllowanceRow & { approval_threshold: string | null }>(
      `INSERT INTO agent_allowances (agent_id, token_address, token_symbol, allowance_amount, reset_period_min, approval_threshold)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (agent_id, token_address)
       DO UPDATE SET allowance_amount = $4, reset_period_min = $5, token_symbol = $3, approval_threshold = $6, updated_at = NOW()
       RETURNING id, agent_id, token_address, token_symbol, allowance_amount, reset_period_min, approval_threshold`,
      [id, token_address.toLowerCase(), token_symbol, allowance_amount, reset_period_min, approval_threshold ?? null],
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
