/**
 * Owner-facing read of an agent's task budgets (#3329 §3) — mounted at the
 * `/agents` prefix beside `agent-delegations.ts`, same owner-session auth
 * and the same `loadOwnedDelegationAgent` scoping (agent id AND owner).
 */

import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { loadOwnedDelegationAgent } from '../infra/repositories/agents.js'
import { listForOwner, type TaskBudgetRow } from '../infra/repositories/task-budgets.js'

function toWire(row: TaskBudgetRow, nowSec: number) {
  return {
    id: row.id,
    agent_id: row.agent_id,
    chain_id: row.chain_id,
    token_address: row.token_address,
    recipient_address: row.recipient_address,
    parent_delegation_hash: row.parent_delegation_hash,
    delegation_hash: row.delegation_hash,
    label: row.label,
    max_atomic: row.max_atomic,
    status: row.status,
    expires_at: Number(row.expires_at),
    is_expired: Number(row.expires_at) <= nowSec,
    created_at: row.created_at,
    opened_at: row.opened_at,
    closed_at: row.closed_at,
    close_tx_hash: row.close_tx_hash,
  }
}

export default async function agentTaskBudgetsOwnerRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authMiddleware)

  app.get<{ Params: { id: string } }>('/:id/task-budgets', async (request, reply) => {
    const { sub } = request.user as { sub: string }
    const agent = await loadOwnedDelegationAgent(request.params.id, sub)
    if (!agent) return reply.code(404).send({ error: 'Agent not found' })
    const rows = await listForOwner(request.params.id, sub)
    const nowSec = Math.floor(Date.now() / 1000)
    return reply.send({ task_budgets: rows.map((r) => toWire(r, nowSec)) })
  })
}
