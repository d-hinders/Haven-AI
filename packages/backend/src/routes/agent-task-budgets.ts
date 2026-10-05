/**
 * Owner-facing read of an agent's task budgets (#3329 §3) — mounted at the
 * `/agents` prefix beside `agent-delegations.ts`, same owner-session auth
 * and the same `loadOwnedDelegationAgent` scoping (agent id AND owner).
 *
 * #3501: parity with the agent-facing list — an owner asking "why was this
 * agent's payment refused" reads the same on-chain spent/remaining the agent
 * does. Same honesty contract: `remaining_is_from_chain: false` with null
 * figures when the live read failed, never the full cap reported as
 * remaining; the keys are absent on rows that never read the chain (pending
 * — unsigned, closed — nothing live to read).
 */

import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { loadOwnedDelegationAgent } from '../infra/repositories/agents.js'
import { listForOwner, type TaskBudgetRow } from '../infra/repositories/task-budgets.js'
import { readTaskBudgetSpentForReport } from '../modules/task-budgets/index.js'
import { getChain } from '../domain/chains.js'
import { formatTokenValue } from '../domain/tokens.js'

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

/** #3501: see the same-named helper in `routes/task-budgets.ts` — identical contract. */
async function toWireWithSpend(row: TaskBudgetRow, nowSec: number) {
  const base = toWire(row, nowSec)
  if (row.status !== 'open') return base
  const { spentAtomic, remainingAtomic } = await readTaskBudgetSpentForReport({
    chainId: row.chain_id,
    delegationHash: row.delegation_hash,
    maxAtomic: row.max_atomic,
  })
  const token = getChain(row.chain_id).tokenByAddress[row.token_address.toLowerCase()]
  const display = (atomic: string | null): string | null => {
    if (atomic === null) return null
    return token ? `${formatTokenValue(atomic, token.decimals)} ${token.symbol}` : `${atomic} atomic (token not in the chain registry)`
  }
  return {
    ...base,
    spent_atomic: spentAtomic,
    remaining_atomic: remainingAtomic,
    spent_display: display(spentAtomic),
    remaining_display: display(remainingAtomic),
    remaining_is_from_chain: remainingAtomic !== null,
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
    return reply.send({ task_budgets: await Promise.all(rows.map((r) => toWireWithSpend(r, nowSec))) })
  })
}
