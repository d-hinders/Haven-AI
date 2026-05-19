import { FastifyInstance } from 'fastify'
import pool from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { getExplorerUrl } from '../lib/chains.js'

// ── Types ─────────────────────────────────────────────────────────

interface PaymentRow {
  id: string
  safe_id: string | null
  safe_address: string | null
  safe_name: string | null
  chain_id: number
  token_symbol: string
  token_address: string
  amount_raw: string
  amount_human: string
  to_address: string
  status: string
  tx_hash: string | null
  source: string | null
  x402_resource_url: string | null
  x402_merchant_address: string | null
  payment_rail: string | null
  payment_resource_url: string | null
  merchant_address: string | null
  payment_proof_status: string | null
  created_at: string
  confirmed_at: string | null
}

interface ApprovalRow {
  id: string
  chain_id: number
  token_symbol: string
  amount_human: string
  to_address: string
  reason: string | null
  source: string | null
  x402_resource_url: string | null
  payment_rail: string | null
  payment_resource_url: string | null
  merchant_address: string | null
  status: string
  tx_hash: string | null
  created_at: string
}

interface StatsRow {
  token_symbol: string
  total_spent: string
  tx_count: string
}

interface AgentInfo {
  id: string
  name: string
}

// ── Routes ────────────────────────────────────────────────────────

export default async function agentActivityRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  // GET /agents/:id/activity — paginated payment + approval history
  app.get<{
    Params: { id: string }
    Querystring: { limit?: string; offset?: string }
  }>('/:id/activity', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const { id } = request.params
    const limit = Math.min(Number((request.query as Record<string, string>).limit) || 30, 100)
    const offset = Number((request.query as Record<string, string>).offset) || 0

    // Verify agent belongs to user
    const agentCheck = await pool.query(
      'SELECT id FROM agents WHERE id = $1 AND user_id = $2',
      [id, sub],
    )
    if (agentCheck.rows.length === 0) {
      return reply.code(404).send({ error: 'Agent not found' })
    }

    // Fetch payments
    const payments = await pool.query<PaymentRow>(
      `SELECT pi.id,
              a.safe_id,
              COALESCE(us.safe_address, pi.safe_address) AS safe_address,
              us.name AS safe_name,
              COALESCE(us.chain_id, pi.chain_id, 100) AS chain_id,
              pi.token_symbol,
              pi.token_address,
              pi.amount_raw,
              pi.amount_human,
              pi.to_address,
              pi.status,
              pi.tx_hash,
              COALESCE(pi.payment_rail, pi.source, 'direct') AS source,
              COALESCE(pi.payment_resource_url, pi.x402_resource_url) AS x402_resource_url,
              COALESCE(pi.merchant_address, pi.x402_merchant_address) AS x402_merchant_address,
              mpe.proof_status AS payment_proof_status,
              pi.payment_rail,
              pi.payment_resource_url,
              pi.merchant_address,
              pi.created_at,
              pi.confirmed_at
       FROM payment_intents pi
       JOIN agents a ON a.id = pi.agent_id
       LEFT JOIN user_safes us ON us.id = a.safe_id
       LEFT JOIN machine_payment_evidence mpe ON mpe.payment_intent_id = pi.id
       WHERE pi.agent_id = $1
       ORDER BY pi.created_at DESC
       LIMIT $2 OFFSET $3`,
      [id, limit, offset],
    )

    // Fetch approval requests
    const approvals = await pool.query<ApprovalRow>(
      `SELECT id, COALESCE(chain_id, 100) as chain_id, token_symbol, amount_human, to_address, reason,
              COALESCE(payment_rail, source, 'direct') AS source,
              COALESCE(payment_resource_url, x402_resource_url) AS x402_resource_url,
              payment_rail,
              payment_resource_url,
              merchant_address,
              status, tx_hash, created_at
       FROM approval_requests
       WHERE agent_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [id, limit, offset],
    )

    // Merge and sort by created_at desc
    const activity = [
      ...payments.rows.map((p) => ({
        type: 'payment' as const,
        id: p.id,
        token: p.token_symbol,
        amount_raw: p.amount_raw,
        amount: p.amount_human,
        to: p.to_address,
        status: p.status,
        tx_hash: p.tx_hash,
        payment_id: p.id,
        payment_proof_status: p.payment_proof_status,
        source: p.source ?? 'direct',
        x402_resource_url: p.x402_resource_url,
        x402_merchant_address: p.x402_merchant_address,
        chain_id: p.chain_id,
        token_address: p.token_address,
        safe_id: p.safe_id,
        safe_address: p.safe_address,
        safe_name: p.safe_name,
        explorer_url: p.tx_hash ? getExplorerUrl(p.chain_id, 'tx', p.tx_hash) : null,
        confirmed_at: p.confirmed_at,
        created_at: p.created_at,
      })),
      ...approvals.rows.map((a) => ({
        type: 'approval' as const,
        id: a.id,
        token: a.token_symbol,
        amount: a.amount_human,
        to: a.to_address,
        reason: a.reason,
        status: a.status,
        tx_hash: a.tx_hash,
        source: a.source ?? 'direct',
        x402_resource_url: a.x402_resource_url,
        explorer_url: a.tx_hash ? getExplorerUrl(a.chain_id, 'tx', a.tx_hash) : null,
        created_at: a.created_at,
      })),
    ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

    return { activity }
  })

  // GET /agents/:id/stats — spending stats for an agent
  app.get<{ Params: { id: string } }>(
    '/:id/stats',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { id } = request.params

      // Verify agent belongs to user
      const agentCheck = await pool.query(
        'SELECT id FROM agents WHERE id = $1 AND user_id = $2',
        [id, sub],
      )
      if (agentCheck.rows.length === 0) {
        return reply.code(404).send({ error: 'Agent not found' })
      }

      // Total spent per token (confirmed only)
      const totals = await pool.query<StatsRow>(
        `SELECT token_symbol,
                SUM(CAST(amount_human AS NUMERIC)) as total_spent,
                COUNT(*) as tx_count
         FROM payment_intents
         WHERE agent_id = $1 AND status = 'confirmed'
         GROUP BY token_symbol`,
        [id],
      )

      // Spent today per token
      const todayTotals = await pool.query<StatsRow>(
        `SELECT token_symbol,
                SUM(CAST(amount_human AS NUMERIC)) as total_spent,
                COUNT(*) as tx_count
         FROM payment_intents
         WHERE agent_id = $1 AND status = 'confirmed'
           AND created_at >= CURRENT_DATE
         GROUP BY token_symbol`,
        [id],
      )

      // Spent this week
      const weekTotals = await pool.query<StatsRow>(
        `SELECT token_symbol,
                SUM(CAST(amount_human AS NUMERIC)) as total_spent,
                COUNT(*) as tx_count
         FROM payment_intents
         WHERE agent_id = $1 AND status = 'confirmed'
           AND created_at >= CURRENT_DATE - interval '7 days'
         GROUP BY token_symbol`,
        [id],
      )

      // Pending approvals count
      const pendingApprovals = await pool.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM approval_requests
         WHERE agent_id = $1 AND status IN ('pending', 'approved')`,
        [id],
      )

      return {
        all_time: totals.rows.map((r) => ({
          token: r.token_symbol,
          total_spent: r.total_spent,
          tx_count: Number(r.tx_count),
        })),
        today: todayTotals.rows.map((r) => ({
          token: r.token_symbol,
          total_spent: r.total_spent,
          tx_count: Number(r.tx_count),
        })),
        this_week: weekTotals.rows.map((r) => ({
          token: r.token_symbol,
          total_spent: r.total_spent,
          tx_count: Number(r.tx_count),
        })),
        pending_approvals: Number(pendingApprovals.rows[0].count),
      }
    },
  )

  // GET /activity/feed — all agents combined activity feed
  app.get<{
    Querystring: { limit?: string; offset?: string }
  }>('/feed', async (request) => {
    const { sub } = request.user as { sub: string }
    const limit = Math.min(Number((request.query as Record<string, string>).limit) || 30, 100)
    const offset = Number((request.query as Record<string, string>).offset) || 0

    // All user's agents
    const agentResult = await pool.query<AgentInfo>(
      'SELECT id, name FROM agents WHERE user_id = $1',
      [sub],
    )
    const agentNames = new Map(agentResult.rows.map((a) => [a.id, a.name]))
    const agentIds = agentResult.rows.map((a) => a.id)

    if (agentIds.length === 0) {
      return { activity: [], pending_approvals: 0 }
    }

    // Recent payments across all agents
    const payments = await pool.query<PaymentRow & { agent_id: string }>(
      `SELECT pi.id,
              pi.agent_id,
              a.safe_id,
              COALESCE(us.safe_address, pi.safe_address) AS safe_address,
              us.name AS safe_name,
              COALESCE(us.chain_id, pi.chain_id, 100) AS chain_id,
              pi.token_symbol,
              pi.token_address,
              pi.amount_raw,
              pi.amount_human,
              pi.to_address,
              pi.status,
              pi.tx_hash,
              COALESCE(pi.payment_rail, pi.source, 'direct') AS source,
              COALESCE(pi.payment_resource_url, pi.x402_resource_url) AS x402_resource_url,
              COALESCE(pi.merchant_address, pi.x402_merchant_address) AS x402_merchant_address,
              mpe.proof_status AS payment_proof_status,
              pi.payment_rail,
              pi.payment_resource_url,
              pi.merchant_address,
              pi.created_at,
              pi.confirmed_at
       FROM payment_intents pi
       JOIN agents a ON a.id = pi.agent_id
       LEFT JOIN user_safes us ON us.id = a.safe_id
       LEFT JOIN machine_payment_evidence mpe ON mpe.payment_intent_id = pi.id
       WHERE pi.agent_id = ANY($1)
       ORDER BY pi.created_at DESC
       LIMIT $2 OFFSET $3`,
      [agentIds, limit, offset],
    )

    // Recent approval requests
    const approvals = await pool.query<ApprovalRow & { agent_id: string }>(
      `SELECT id, agent_id, COALESCE(chain_id, 100) as chain_id, token_symbol, amount_human, to_address, reason,
              COALESCE(payment_rail, source, 'direct') AS source,
              COALESCE(payment_resource_url, x402_resource_url) AS x402_resource_url,
              payment_rail,
              payment_resource_url,
              merchant_address,
              status, tx_hash, created_at
       FROM approval_requests
       WHERE agent_id = ANY($1)
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [agentIds, limit, offset],
    )

    // Merge and sort
    const activity = [
      ...payments.rows.map((p) => ({
        type: 'payment' as const,
        id: p.id,
        agent_id: p.agent_id,
        agent_name: agentNames.get(p.agent_id) ?? 'Unknown',
        token: p.token_symbol,
        amount_raw: p.amount_raw,
        amount: p.amount_human,
        to: p.to_address,
        status: p.status,
        tx_hash: p.tx_hash,
        payment_id: p.id,
        payment_proof_status: p.payment_proof_status,
        source: p.source ?? 'direct',
        x402_resource_url: p.x402_resource_url,
        x402_merchant_address: p.x402_merchant_address,
        chain_id: p.chain_id,
        token_address: p.token_address,
        safe_id: p.safe_id,
        safe_address: p.safe_address,
        safe_name: p.safe_name,
        explorer_url: p.tx_hash ? getExplorerUrl(p.chain_id, 'tx', p.tx_hash) : null,
        confirmed_at: p.confirmed_at,
        created_at: p.created_at,
      })),
      ...approvals.rows.map((a) => ({
        type: 'approval' as const,
        id: a.id,
        agent_id: a.agent_id,
        agent_name: agentNames.get(a.agent_id) ?? 'Unknown',
        token: a.token_symbol,
        amount: a.amount_human,
        to: a.to_address,
        reason: a.reason,
        status: a.status,
        tx_hash: a.tx_hash,
        source: a.source ?? 'direct',
        x402_resource_url: a.x402_resource_url,
        explorer_url: a.tx_hash ? getExplorerUrl(a.chain_id, 'tx', a.tx_hash) : null,
        created_at: a.created_at,
      })),
    ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
     .slice(0, limit)

    // Pending approvals count
    const pendingResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM approval_requests
       WHERE user_id = $1 AND status IN ('pending', 'approved')`,
      [sub],
    )

    return {
      activity,
      pending_approvals: Number(pendingResult.rows[0].count),
    }
  })
}
