import { FastifyInstance } from 'fastify'
// dep-lint-exempt: 9 approval-queue statements including the guarded approve/reject state flips; verbatim extraction is a >100-line move deferred under #999's fix-or-waive budget
import pool from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { getFiatValuesForTokenAmount } from '../infra/fiat-values.js'
import { mppDemoRetired } from '../modules/mpp/index.js'
import { getApprovalRail } from '../infra/repositories/approval-requests.js'
import { allowanceModuleRailRetired } from '../rails/execution-rail.js'

/**
 * The approval queue's ACTIONABLE transitions are closed (#1986, epic #1440
 * slice 3).
 *
 * Every `approval_requests` row is an AllowanceModule-rail artifact: the
 * delegation rail has no approval queue at all (its budget is enforced
 * on-chain by the caveat enforcers, so there is nothing to queue), and all
 * three inserts — `insertPaymentApproval`, `insertSendApproval`,
 * `insertMachineApproval` — sit on legacy code paths, every one of which now
 * refuses upstream. So the refusal here is unconditional rather than
 * rail-conditional; there is no live-rail approval for a predicate to spare.
 *
 * A route `preHandler` rather than an early `return`, for the #1984 reason:
 * an unconditional early return would strand each handler body as unreachable
 * code, forcing a deletion that belongs to #1988. The hook replies before the
 * handler runs, so the bodies stay verbatim, Fastify short-circuits before
 * any `pool.query`, and no path inside a handler can reach around it.
 * `authMiddleware` is an `onRequest` hook, so 401 still precedes 410.
 *
 * Scoped to `/approve` and `/proposed` — the two transitions that make a
 * queued payment executable. Deliberately NOT closed:
 *
 * - `GET /` and `POST /:id/reject` — the epic's "accounts/history stay
 *   READABLE" plus the ability to clear the queue. Readable and rejectable,
 *   never approvable: the #1328 mpp_demo shape exactly.
 * - `POST /:id/executed` — post-hoc bookkeeping of a Safe transaction the
 *   OWNER signed and broadcast themselves. Haven cannot prevent that
 *   transaction (it is owner authority, and `POST /safe/exec` stays open
 *   because approver management rides on it, #1229), so refusing the record
 *   would not stop a single wei from moving — it would only lose the audit
 *   trail for something that already happened. Closing `/approve` is what
 *   stops a NEW row reaching `approved`.
 */
function retiredApprovalTransition() {
  return {
    preHandler: async (
      _request: import('fastify').FastifyRequest,
      reply: import('fastify').FastifyReply,
    ) => {
      const retired = allowanceModuleRailRetired('approval')
      return reply.code(retired.statusCode).send(retired.body)
    },
  }
}

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

// ── Helpers ───────────────────────────────────────────────────────

function isValidTxHash(txHash: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(txHash)
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
        merchant_address: row.merchant_address,
        payment_rail: row.payment_rail,
        payment_resource_url: row.payment_resource_url,
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
    retiredApprovalTransition(),
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { id } = request.params

      // #1328 (review finding on #1339): a PRE-EXISTING pending mpp_demo
      // approval must not become actionable after the retirement — approving
      // it hands the frontend an executable Safe funding tx. The guard lives
      // IN the UPDATE's WHERE (race-free, nothing ever written for mpp_demo);
      // the rail predicate is the same payment_rail-first derivation GET
      // /approvals reports. Readable and rejectable, never approvable.
      const result = await pool.query<ApprovalRow>(
        `UPDATE approval_requests
         SET status = 'approved', reviewed_at = NOW()
         WHERE id = $1 AND user_id = $2 AND status = 'pending' AND expires_at > NOW()
           AND COALESCE(payment_rail, source, 'direct') <> 'mpp_demo'
         RETURNING *`,
        [id, sub],
      )

      if (result.rows.length === 0) {
        // Distinguish the retirement refusal (410) from plain not-found (404)
        // — diagnostic repository read on the failure path only.
        const rail = await getApprovalRail(id, sub)
        if (rail === 'mpp_demo') {
          const retired = mppDemoRetired()
          return reply.code(retired.statusCode).send(retired.body)
        }
        return reply.code(404).send({
          error: 'Approval request not found or no longer actionable',
        })
      }

      const row = result.rows[0]
      // Match the GET /approvals derivation: prefer payment_rail over the
      // legacy `source` column so both endpoints report the same value when
      // a rail is set. Falls back to 'direct' to mirror the SQL COALESCE.
      const derivedSource = row.payment_rail ?? row.source ?? 'direct'
      // Same idea for resource URL: prefer the new column, fall back to the
      // legacy x402 column. Return the resolved value in BOTH fields so
      // callers don't have to coalesce client-side.
      const resolvedResourceUrl = row.payment_resource_url ?? row.x402_resource_url
      return {
        id: row.id,
        status: 'approved',
        message: 'Approved. Complete the payment to send it.',
        payment: {
          token_symbol: row.token_symbol,
          token_address: row.token_address,
          to_address: row.to_address,
          amount_raw: row.amount_raw,
          amount_human: row.amount_human,
          safe_address: row.safe_address,
          source: derivedSource,
          x402_resource_url: resolvedResourceUrl,
          merchant_address: row.merchant_address,
          payment_rail: row.payment_rail,
          payment_resource_url: resolvedResourceUrl,
        },
      }
    },
  )

  // POST /:id/proposed — record that a multi-approval payment was submitted
  app.post<{ Params: { id: string } }>(
    '/:id/proposed',
    retiredApprovalTransition(),
    async (request, reply) => {
      const { sub } = request.user as { sub: string }
      const { id } = request.params

      // #1328: same WHERE-clause guard as /approve — an mpp_demo approval
      // already flipped to 'approved' before the retirement must not advance.
      const result = await pool.query<ApprovalRow>(
        `UPDATE approval_requests
         SET status = 'proposed', reviewed_at = COALESCE(reviewed_at, NOW())
         WHERE id = $1 AND user_id = $2 AND status = 'approved' AND expires_at > NOW()
           AND COALESCE(payment_rail, source, 'direct') <> 'mpp_demo'
         RETURNING id`,
        [id, sub],
      )

      if (result.rows.length === 0) {
        const rail = await getApprovalRail(id, sub)
        if (rail === 'mpp_demo') {
          const retired = mppDemoRetired()
          return reply.code(retired.statusCode).send(retired.body)
        }
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

      if (!tx_hash || typeof tx_hash !== 'string' || !isValidTxHash(tx_hash)) {
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
