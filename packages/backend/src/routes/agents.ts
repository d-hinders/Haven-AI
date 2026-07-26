import { FastifyInstance } from 'fastify'
import crypto from 'crypto'
import pool from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import {
  normalizeAgentAllowance,
  normalizeAgentAllowances,
  normalizeAgentAllowanceTokenAddress,
} from '../lib/agent-allowance-validation.js'
import { getTokenBalance } from '../lib/allowance-module.js'
import { emitFunnelEvent } from '../lib/onboarding-funnel.js'
import { getChain, isSupportedChain } from '../lib/chains.js'
import { isAddress as isValidAddress } from '@haven_ai/core'
import {
  requestPassport,
  issuePassportBestEffort,
  enqueuePassportRevocation,
  revokePassportBestEffort,
  PASSPORT_CHAIN_IDS,
} from '../lib/passport/index.js'
import { formatTokenValue } from '../lib/tokens.js'

// ── Types ──────────────────────────────────────────────────────────

interface CreateAgentBody {
  name: string
  description?: string
  delegate_address: string
  safe_id?: string
  /**
   * Opt in to an L0 Agent Passport at creation time (#972). Absent/false is the
   * DEFAULT and the normal case: a basic agent has no passport and behaves
   * exactly as before. Issuance is fire-and-forget — it can never fail or delay
   * agent creation (owner decision 2026-07-24; v6 review point 2).
   */
  issue_passport?: boolean
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
  has_stranded_funds: boolean
}

interface AllowanceRow {
  id: string
  agent_id: string
  token_address: string
  token_symbol: string
  allowance_amount: string
  reset_period_min: number
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
              (SELECT MAX(ati.created_at) FROM agent_tool_invocations ati WHERE ati.agent_id = a.id) AS mcp_last_seen_at,
              EXISTS(
                SELECT 1 FROM machine_payment_reconciliation_events mpre
                JOIN payment_intents pi ON pi.id = mpre.payment_intent_id
                WHERE pi.agent_id = a.id
                  AND mpre.event_type = 'merchant_retry_rejected_after_payment'
                  AND mpre.status = 'open'
              ) AS has_stranded_funds
       FROM agents a
       LEFT JOIN user_safes us ON a.safe_id = us.id
       WHERE a.user_id = $1
        AND a.status != 'pending_approval'
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
              us.account_type,
              a.api_key_prefix, a.status, a.created_at,
              (SELECT MAX(ati.created_at) FROM agent_tool_invocations ati WHERE ati.agent_id = a.id) AS mcp_last_seen_at,
              EXISTS(
                SELECT 1 FROM machine_payment_reconciliation_events mpre
                JOIN payment_intents pi ON pi.id = mpre.payment_intent_id
                WHERE pi.agent_id = a.id
                  AND mpre.event_type = 'merchant_retry_rejected_after_payment'
                  AND mpre.status = 'open'
              ) AS has_stranded_funds
       FROM agents a
       LEFT JOIN user_safes us ON a.safe_id = us.id
       WHERE a.user_id = $1 AND a.id = $2
        AND a.status != 'pending_approval'
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

  // GET /agents/:id/delegate-balance — on-chain USDC + ETH balance of the delegate EOA
  app.get<{ Params: { id: string } }>('/:id/delegate-balance', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { id } = request.params

    const agentResult = await pool.query<{
      delegate_address: string | null
      safe_chain_id: number | null
      safe_address: string | null
    }>(
      `SELECT a.delegate_address, us.chain_id AS safe_chain_id, us.safe_address
       FROM agents a
       LEFT JOIN user_safes us ON a.safe_id = us.id
       WHERE a.user_id = $1 AND a.id = $2 AND a.status != 'revoked'
       LIMIT 1`,
      [sub, id],
    )

    const agent = agentResult.rows[0]
    if (!agent) {
      return reply.code(404).send({ error: 'Agent not found' })
    }
    if (!agent.delegate_address) {
      return reply.code(422).send({ error: 'Agent has no delegate address' })
    }

    const chainId = agent.safe_chain_id ?? 8453
    if (!isSupportedChain(chainId)) {
      return reply.code(422).send({ error: `Unsupported chain: ${chainId}` })
    }

    const chain = getChain(chainId)
    const delegate = agent.delegate_address

    const usdcConfig = Object.values(chain.tokens).find((t) => t.symbol === 'USDC')

    const [ethAtomic, usdcAtomic] = await Promise.all([
      getTokenBalance(chainId, delegate, '0x0000000000000000000000000000000000000000'),
      usdcConfig?.address ? getTokenBalance(chainId, delegate, usdcConfig.address) : Promise.resolve(0n),
    ])

    return {
      delegate_address: delegate,
      safe_address: agent.safe_address,
      chain_id: chainId,
      eth: formatTokenValue(ethAtomic.toString(), 18),
      eth_atomic: ethAtomic.toString(),
      usdc: formatTokenValue(usdcAtomic.toString(), 6),
      usdc_atomic: usdcAtomic.toString(),
      usdc_address: usdcConfig?.address ?? null,
    }
  })

  // POST /agents — create agent with delegate address and on-chain allowance config
  app.post<{ Body: CreateAgentBody }>('/', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { name, description, delegate_address, safe_id, allowances, issue_passport } = request.body

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return reply.code(400).send({ error: 'Name is required' })
    }
    if (!delegate_address || !isValidAddress(delegate_address)) {
      return reply.code(400).send({ error: 'Valid delegate address is required' })
    }
    const normalizedAllowances = normalizeAgentAllowances(allowances)
    if (!normalizedAllowances.ok) {
      return reply.code(400).send({ error: normalizedAllowances.error })
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
    // The api_key_prefix column is VARCHAR(12); slicing 20 overflows it and the
    // INSERT fails (Postgres 22001), 500-ing every agent creation. Matches the
    // rotate-key path, which already slices 12.
    const apiKeyPrefix = apiKey.slice(0, 12)

    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      const agentResult = await client.query<AgentRow>(
        `INSERT INTO agents (user_id, name, description, delegate_address, api_key_hash, api_key_prefix, safe_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, name, description, delegate_address, safe_id, api_key_prefix, status, created_at,
                   NULL::timestamptz AS mcp_last_seen_at`,
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
      if (normalizedAllowances.value.length > 0) {
        for (const a of normalizedAllowances.value) {
          const res = await client.query<AllowanceRow>(
            `INSERT INTO agent_allowances (agent_id, token_address, token_symbol, allowance_amount, reset_period_min)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id, agent_id, token_address, token_symbol, allowance_amount, reset_period_min`,
            [
              agent.id,
              a.token_address,
              a.token_symbol,
              a.allowance_amount,
              a.reset_period_min,
            ],
          )
          savedAllowances.push(res.rows[0])
        }
      }

      await client.query('COMMIT')
      emitFunnelEvent(sub, 'agent_created', { agent_id: agent.id })
      if (savedAllowances.length > 0) {
        emitFunnelEvent(sub, 'allowance_granted', { agent_id: agent.id })
      }
      // Opt-in passport (#972). Deliberately AFTER the transaction commits and
      // outside any try that could turn a passport problem into a failed agent:
      // requestPassport records the intent, then the EAS write is fire-and-forget.
      // A slow, failing, or unfunded attestation degrades to "pending"/"failed"
      // on the passport row and never touches this response.
      // Narrowed to a local so the chain id stays non-null for the call below;
      // eligibility mirrors POST /agents/:id/passport so the two entry points
      // agree rather than one silently creating a permanently-failed row.
      const passportChainId =
        issue_passport === true &&
        safeInfo.safe_chain_id != null &&
        PASSPORT_CHAIN_IDS.has(safeInfo.safe_chain_id)
          ? safeInfo.safe_chain_id
          : null
      if (passportChainId != null) {
        try {
          await requestPassport(agent.id, passportChainId)
          issuePassportBestEffort(agent.id, sub)
        } catch (err) {
          request.log.warn({ err, agentId: agent.id }, 'passport request failed; agent created')
        }
      }

      return reply.code(201).send({
        ...agent,
        ...safeInfo,
        api_key: apiKey,
        allowances: savedAllowances,
        passport_requested: passportChainId != null,
      })
    } catch (err) {
      await client.query('ROLLBACK')
      if (isUniqueDelegateConflict(err)) {
        return reply
          .code(409)
          .send({ error: 'An active agent with this delegate address already exists' })
      }
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
                updated.api_key_prefix, updated.status, updated.created_at,
                (SELECT MAX(ati.created_at) FROM agent_tool_invocations ati WHERE ati.agent_id = updated.id) AS mcp_last_seen_at
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

      // The UPDATE above IS the revocation — authoritative and already applied
      // (#973). Flipping the on-chain anchor is a separate, eventually-consistent
      // step: enqueued and fired best-effort so a slow or failing EAS revoke can
      // never delay or fail the user's revoke. It retries until the two agree.
      try {
        if (await enqueuePassportRevocation(id)) revokePassportBestEffort(id)
      } catch (err) {
        request.log.warn({ err, agentId: id }, 'passport revocation enqueue failed; agent revoked')
      }

      return { success: true }
    },
  )

  // POST /agents/:id/rotate-key — generate a new API key for an active agent
  app.post<{ Params: { id: string } }>(
    '/:id/rotate-key',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { id } = request.params

      const newKey = `sk_agent_${crypto.randomBytes(24).toString('hex')}`
      const newKeyHash = crypto.createHash('sha256').update(newKey).digest('hex')
      const prefix = newKey.slice(0, 12)

      const result = await pool.query(
        `UPDATE agents SET api_key_hash = $1, api_key_prefix = $2, updated_at = NOW()
         WHERE id = $3 AND user_id = $4 AND status = 'active'
         RETURNING id`,
        [newKeyHash, prefix, id, sub],
      )

      if (result.rows.length === 0) {
        const existing = await pool.query(
          'SELECT id, status FROM agents WHERE id = $1 AND user_id = $2',
          [id, sub],
        )
        if (existing.rows.length === 0) {
          return reply.code(404).send({ error: 'Agent not found' })
        }
        return reply.code(409).send({ error: 'Agent is not active' })
      }

      return { api_key: newKey, api_key_prefix: prefix }
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
    const normalizedAllowance = normalizeAgentAllowance(request.body)
    if (!normalizedAllowance.ok) {
      return reply.code(400).send({ error: normalizedAllowance.error })
    }

    const agentCheck = await pool.query<{ id: string; status: string }>(
      'SELECT id, status FROM agents WHERE id = $1 AND user_id = $2',
      [id, sub],
    )
    if (agentCheck.rows.length === 0) {
      return reply.code(404).send({ error: 'Agent not found' })
    }
    if (agentCheck.rows[0].status === 'pending_approval') {
      return reply
        .code(409)
        .send({ error: 'Agent rules are pending wallet approval and cannot be changed here' })
    }
    if (agentCheck.rows[0].status === 'revoked') {
      return reply
        .code(409)
        .send({ error: 'Revoked agent rules cannot be changed' })
    }

    const { token_address, token_symbol, allowance_amount, reset_period_min } = normalizedAllowance.value
    const result = await pool.query<AllowanceRow>(
      `INSERT INTO agent_allowances (agent_id, token_address, token_symbol, allowance_amount, reset_period_min)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (agent_id, token_address)
       DO UPDATE SET allowance_amount = $4, reset_period_min = $5, token_symbol = $3, updated_at = NOW()
       RETURNING id, agent_id, token_address, token_symbol, allowance_amount, reset_period_min`,
      [id, token_address, token_symbol, allowance_amount, reset_period_min],
    )

    return {
      ...result.rows[0],
      // #802: with an enabled budget schedule, this edit takes effect on-chain
      // Session schedules are retired (#834); the warning slot stays null for
      // response-shape compatibility until clients drop it.
      schedule_warning: null,
    }
  })

  // DELETE /agents/:id/allowances/:tokenAddress
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
        'SELECT id, status FROM agents WHERE id = $1 AND user_id = $2',
        [id, sub],
      )
      if (agentCheck.rows.length === 0) {
        return reply.code(404).send({ error: 'Agent not found' })
      }
      if (agentCheck.rows[0].status === 'pending_approval') {
        return reply
          .code(409)
          .send({ error: 'Agent rules are pending wallet approval and cannot be changed here' })
      }
      if (agentCheck.rows[0].status === 'revoked') {
        return reply
          .code(409)
          .send({ error: 'Revoked agent rules cannot be changed' })
      }

      const result = await pool.query(
        'DELETE FROM agent_allowances WHERE agent_id = $1 AND token_address = $2 RETURNING id',
        [id, normalizedTokenAddress.value],
      )

      if (result.rows.length === 0) {
        return reply.code(404).send({ error: 'Allowance not found' })
      }

      return { success: true }
    },
  )
}

function isUniqueDelegateConflict(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === 'object' &&
      'code' in err &&
      err.code === '23505' &&
      'constraint' in err &&
      String(err.constraint).includes('idx_agents_user_delegate_non_revoked_unique'),
  )
}
