import { FastifyInstance } from 'fastify'
import pool from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { getFiatValuesForTokenAmount } from '../lib/fiat-values.js'

// ── Types ─────────────────────────────────────────────────────────

interface ApprovalRow {
  id: string
  agent_id: string
  user_id: string
  safe_address: string
  chain_id: number
  token_symbol: string
  token_address: string
  to_address: string
  amount_raw: string
  amount_human: string
  reason: string | null
  source: string
  x402_resource_url: string | null
  payment_rail: string | null
  payment_resource_url: string | null
  merchant_address: string | null
  status: string
  tx_hash: string | null
  reviewed_at: string | null
  usd_value: string | null
  eur_value: string | null
  executed_at: string | null
  created_at: string
  expires_at: string
}

interface AgentName {
  id: string
  name: string
}

// ── Routes ────────────────────────────────────────────────────────

export default async function approvalRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  // GET / — list approval requests for the logged-in user
  app.get<{
    Querystring: { status?: string; limit?: string; offset?: string }
  }>('/', async (request) => {
    const { sub } = request.user as { sub: string }
    const status = (request.query as Record<string, string>).status ?? 'pending'
    const limit = Math.min(Number((request.query as Record<string, string>).limit) || 50, 100)
    const offset = Number((request.query as Record<string, string>).offset) || 0

    // Expire stale requests that have not been completed or submitted.
    await pool.query(
      `UPDATE approval_requests SET status = 'expired'
       WHERE user_id = $1 AND status IN ('pending', 'approved') AND expires_at < NOW()`,
      [sub],
    )

    const result = await pool.query<ApprovalRow>(
      `SELECT id,
              agent_id,
              user_id,
              safe_address,
              chain_id,
              token_symbol,
              token_address,
              to_address,
              amount_raw,
              amount_human,
              reason,
              COALESCE(payment_rail, source, 'direct') AS source,
              COALESCE(payment_resource_url, x402_resource_url) AS x402_resource_url,
              payment_rail,
              payment_resource_url,
              merchant_address,
              status,
              tx_hash,
              reviewed_at,
              usd_value,
              eur_value,
              executed_at,
              created_at,
              expires_at
       FROM approval_requests
       WHERE user_id = $1 AND ($2 = 'all' OR status = $2)
       ORDER BY
         CASE WHEN status IN ('pending', 'approved') THEN 0 ELSE 1 END,
         created_at DESC
       LIMIT $3 OFFSET $4`,
      [sub, status, limit, offset],
    )

    // Fetch agent names
    const agentIds = [...new Set(result.rows.map((r) => r.agent_id))]
    let agentNames = new Map<string, string>()
    if (agentIds.length > 0) {
      const agents = await pool.query<AgentName>(
        `SELECT id, name FROM agents WHERE id = ANY($1)`,
        [agentIds],
      )
      agentNames = new Map(agents.rows.map((a) => [a.id, a.name]))
    }

    // Count actionable approval requests.
    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM approval_requests
       WHERE user_id = $1 AND status IN ('pending', 'approved')`,
      [sub],
    )
    const actionableCount = Number(countResult.rows[0].count)

    return {
      approvals: result.rows.map((row) => ({
        id: row.id,
        agent_id: row.agent_id,
        agent_name: agentNames.get(row.agent_id) ?? 'Unknown Agent',
        safe_address: row.safe_address,
        chain_id: row.chain_id,
        token_symbol: row.token_symbol,
        token_address: row.token_address,
        to_address: row.to_address,
        amount_raw: row.amount_raw,
        amount_human: row.amount_human,
        reason: row.reason,
        source: row.source,
        x402_resource_url: row.x402_resource_url,
        status: row.status,
        tx_hash: row.tx_hash,
        reviewed_at: row.reviewed_at,
        created_at: row.created_at,
        expires_at: row.expires_at,
      })),
      actionable_count: actionableCount,
      pending_count: actionableCount,
    }
  })

  // POST /:id/approve — mark an approval request as approved
  app.post<{ Params: { id: string } }>(
    '/:id/approve',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { id } = request.params

      const result = await pool.query<ApprovalRow>(
        `UPDATE approval_requests
         SET status = 'approved', reviewed_at = NOW()
         WHERE id = $1 AND user_id = $2 AND status = 'pending' AND expires_at > NOW()
         RETURNING *`,
        [id, sub],
      )

      if (result.rows.length === 0) {
        return reply.code(404).send({
          error: 'Approval request not found or no longer actionable',
        })
      }

      return {
        id: result.rows[0].id,
        status: 'approved',
        message: 'Approved. Complete the payment to send it.',
        payment: {
          token_symbol: result.rows[0].token_symbol,
          token_address: result.rows[0].token_address,
          to_address: result.rows[0].to_address,
          amount_raw: result.rows[0].amount_raw,
          amount_human: result.rows[0].amount_human,
          safe_address: result.rows[0].safe_address,
          source: result.rows[0].source,
          x402_resource_url: result.rows[0].x402_resource_url,
        },
      }
    },
  )

  // POST /:id/proposed — record that a multi-approval payment was submitted
  app.post<{ Params: { id: string } }>(
    '/:id/proposed',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { id } = request.params

      const result = await pool.query<ApprovalRow>(
        `UPDATE approval_requests
         SET status = 'proposed', reviewed_at = COALESCE(reviewed_at, NOW())
         WHERE id = $1 AND user_id = $2 AND status = 'approved' AND expires_at > NOW()
         RETURNING id`,
        [id, sub],
      )

      if (result.rows.length === 0) {
        return reply.code(404).send({
          error: 'Approval request not found or no longer actionable',
        })
      }

      return { id, status: 'proposed' }
    },
  )

  // POST /:id/reject — reject an approval request
  app.post<{ Params: { id: string } }>(
    '/:id/reject',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { id } = request.params

      const result = await pool.query<ApprovalRow>(
        `UPDATE approval_requests
         SET status = 'rejected', reviewed_at = NOW()
         WHERE id = $1 AND user_id = $2 AND status IN ('pending', 'approved')
         RETURNING id`,
        [id, sub],
      )

      if (result.rows.length === 0) {
        return reply.code(404).send({
          error: 'Approval request not found or no longer actionable',
        })
      }

      return { id, status: 'rejected' }
    },
  )

  // POST /:id/executed — record tx hash after frontend executes the Safe tx
  app.post<{ Params: { id: string }; Body: { tx_hash: string } }>(
    '/:id/executed',
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { id } = request.params
      const { tx_hash } = request.body

      if (!tx_hash || typeof tx_hash !== 'string' || !tx_hash.startsWith('0x')) {
        return reply.code(400).send({ error: 'Valid tx_hash is required' })
      }

      const existing = await pool.query<ApprovalRow>(
        `SELECT *
         FROM approval_requests
         WHERE id = $1 AND user_id = $2 AND status = 'approved' AND expires_at > NOW()`,
        [id, sub],
      )

      if (existing.rows.length === 0) {
        return reply.code(404).send({
          error: 'Approval request not found or not approved',
        })
      }

      const approval = existing.rows[0]
      const fiatValues = await getFiatValuesForTokenAmount(
        approval.token_symbol,
        approval.amount_human,
      )

      const result = await pool.query<ApprovalRow>(
        `UPDATE approval_requests
         SET status = 'executed',
             tx_hash = $3,
             executed_at = NOW(),
             usd_value = $4,
             eur_value = $5
         WHERE id = $1 AND user_id = $2 AND status = 'approved' AND expires_at > NOW()
         RETURNING id`,
        [id, sub, tx_hash, fiatValues.usd, fiatValues.eur],
      )

      if (result.rows.length === 0) {
        return reply.code(409).send({
          error: 'Approval request is no longer approved',
        })
      }

      return { id, status: 'executed', tx_hash }
    },
  )
}
