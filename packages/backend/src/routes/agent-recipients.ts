/**
 * Agent recipient management (#796, the #784 follow-up): user-facing CRUD for
 * `agent_recipients` — who an agent may pay on the session rail, with an
 * optional per-recipient budget (NULL = inherit the token allowance, the #784
 * semantics; budgets never aggregate across recipients on-chain).
 *
 * Bookkeeping only, fail-closed by construction: a row here moves no money.
 * The on-chain session set is the authority — a new recipient becomes payable
 * only after the owner signs the schedule replacement (#770 build → sign →
 * confirm), and the #769 rollover verifies enablement via prepare before any
 * pointer flip. The legacy AllowanceModule rail never reads this table.
 */

import { FastifyInstance } from 'fastify'
import pool from '../db.js'
import { authMiddleware } from '../middleware/auth.js'
import { isAddress as isValidAddress } from '../lib/address.js'

const MAX_UINT96 = (1n << 96n) - 1n
const MAX_LABEL_LENGTH = 255

/** Ownership guard: the agent must belong to the authenticated user. */
async function ownsAgent(agentId: string, userId: string): Promise<boolean> {
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM agents WHERE id = $1 AND user_id = $2`,
    [agentId, userId],
  )
  return result.rows.length > 0
}

export default async function agentRecipientRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  // ── GET /:id/recipients — list with budget inheritance indicated ──────────
  app.get<{ Params: { id: string } }>('/:id/recipients', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    if (!(await ownsAgent(request.params.id, sub))) {
      return reply.code(404).send({ error: 'Agent not found' })
    }
    const result = await pool.query<{
      recipient_address: string
      token_address: string
      label: string | null
      budget_amount: string | null
      allowance_amount: string | null
    }>(
      `SELECT r.recipient_address, r.token_address, r.label, r.budget_amount,
              a.allowance_amount
       FROM agent_recipients r
       LEFT JOIN agent_allowances a
         ON a.agent_id = r.agent_id AND a.token_address = r.token_address
       WHERE r.agent_id = $1
       ORDER BY r.created_at, r.id`,
      [request.params.id],
    )
    return {
      recipients: result.rows.map((row) => ({
        recipient_address: row.recipient_address,
        token_address: row.token_address,
        label: row.label,
        budget_amount: row.budget_amount,
        /** Resolved: the per-row budget, or the inherited token allowance. */
        effective_budget: row.budget_amount ?? row.allowance_amount ?? '0',
        inherits_allowance: row.budget_amount == null,
      })),
    }
  })

  // ── POST /:id/recipients — add or update (upsert on the UNIQUE key) ───────
  app.post<{
    Params: { id: string }
    Body: {
      recipient_address?: string
      token_address?: string
      label?: string | null
      budget_amount?: string | null
    }
  }>('/:id/recipients', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    if (!(await ownsAgent(request.params.id, sub))) {
      return reply.code(404).send({ error: 'Agent not found' })
    }

    const { recipient_address, token_address, label, budget_amount } = request.body ?? {}
    if (!recipient_address || !isValidAddress(recipient_address)) {
      return reply.code(400).send({ error: 'Valid recipient address is required' })
    }
    if (!token_address || !isValidAddress(token_address)) {
      return reply.code(400).send({ error: 'Valid token address is required' })
    }
    if (label != null && (typeof label !== 'string' || label.length > MAX_LABEL_LENGTH)) {
      return reply.code(400).send({ error: `Label must be at most ${MAX_LABEL_LENGTH} characters` })
    }
    // budget_amount: atomic-integer string, uint96-bounded (AllowanceModule
    // parity); null/absent = inherit the token allowance (#784).
    if (budget_amount != null) {
      if (typeof budget_amount !== 'string' || !/^\d+$/.test(budget_amount)) {
        return reply.code(400).send({ error: 'Budget must be a positive decimal atomic amount' })
      }
      const amount = BigInt(budget_amount)
      if (amount <= 0n || amount > MAX_UINT96) {
        return reply.code(400).send({ error: 'Budget must be a positive decimal atomic amount' })
      }
    }

    const result = await pool.query<{ id: string }>(
      `INSERT INTO agent_recipients (agent_id, token_address, recipient_address, label, budget_amount)
       VALUES ($1, LOWER($2), LOWER($3), $4, $5)
       ON CONFLICT (agent_id, token_address, recipient_address)
       DO UPDATE SET label = $4, budget_amount = $5, updated_at = NOW()
       RETURNING id`,
      [request.params.id, token_address, recipient_address, label ?? null, budget_amount ?? null],
    )
    return reply.code(201).send({
      id: result.rows[0].id,
      // The row alone moves no money — the owner's schedule signature applies it.
      applied_on_chain: false,
    })
  })

  // ── DELETE /:id/recipients/:recipientAddress ───────────────────────────────
  app.delete<{
    Params: { id: string; recipientAddress: string }
    Querystring: { token_address?: string }
  }>('/:id/recipients/:recipientAddress', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    if (!(await ownsAgent(request.params.id, sub))) {
      return reply.code(404).send({ error: 'Agent not found' })
    }
    const { recipientAddress } = request.params
    if (!isValidAddress(recipientAddress)) {
      return reply.code(400).send({ error: 'Valid recipient address is required' })
    }
    const tokenAddress = request.query?.token_address
    const result = tokenAddress
      ? await pool.query(
          `DELETE FROM agent_recipients
           WHERE agent_id = $1 AND LOWER(recipient_address) = LOWER($2)
             AND LOWER(token_address) = LOWER($3)
           RETURNING id`,
          [request.params.id, recipientAddress, tokenAddress],
        )
      : await pool.query(
          `DELETE FROM agent_recipients
           WHERE agent_id = $1 AND LOWER(recipient_address) = LOWER($2)
           RETURNING id`,
          [request.params.id, recipientAddress],
        )
    if (result.rows.length === 0) {
      return reply.code(404).send({ error: 'Recipient not found' })
    }
    // NOTE: the on-chain sessions for this recipient live until the owner
    // signs the schedule replacement — surface that in the UI (the removed
    // recipient stays payable for at most the current window otherwise).
    return { removed: result.rows.length, applied_on_chain: false }
  })
}
