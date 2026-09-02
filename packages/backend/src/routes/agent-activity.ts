import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { getExplorerUrl } from '../domain/chains.js'
import { machinePaymentLifecycle } from '../domain/machine-payment-lifecycle.js'
import { agentExistsForUser, listAgentNamesForUser } from '../infra/repositories/agents.js'
import {
  listToolInvocationsForAgent,
  listToolInvocationsForAgents,
} from '../infra/repositories/agent-tool-invocations.js'
import {
  listAgentPayments,
  listFeedPayments,
  sumAgentSpendAllTime,
  sumAgentSpendThisWeek,
  sumAgentSpendToday,
} from '../infra/repositories/agent-activity.js'

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
    if (!(await agentExistsForUser(id, sub))) {
      return reply.code(404).send({ error: 'Agent not found' })
    }

    // Fetch payments
    const payments = await listAgentPayments(id, limit, offset)

    // #2055: the approval-request feed entries are gone with the table —
    // queue history is waived (owner decision on #2021); the activity feed is
    // payments + tool invocations now.
    // Fetch MCP tool invocations (audit log)
    const invocations = await listToolInvocationsForAgent(id, limit, offset)

    // Merge and sort by created_at desc
    const activity = [
      ...payments.map((p) => {
        const lifecycle = machinePaymentLifecycle({
          rail: p.source,
          paymentStatus: p.status,
          paymentProofStatus: p.payment_proof_status,
          reconciliationEventType: p.payment_reconciliation_event_type,
        })

        return {
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
          payment_flow_status: lifecycle.paymentFlowStatus,
          payment_attention_reason: lifecycle.paymentAttentionReason,
          source: p.source ?? 'direct',
          x402_resource_url: p.x402_resource_url,
          x402_merchant_address: p.x402_merchant_address,
          chain_id: p.chain_id,
          token_address: p.token_address,
          safe_id: p.safe_id,
          safe_address: p.safe_address,
          safe_name: p.safe_name,
          explorer_url: p.tx_hash ? getExplorerUrl(p.chain_id, 'tx', p.tx_hash) : null,
          // #799: which on-chain mechanism moved the money, and (session rail)
          // WHICH period-session the intent was pinned to — makes the #769
          // lazy rollover observable to the owner without DB access.
          execution_rail: p.execution_rail,
          // #829: which delegation authorized a delegation-rail payment.
          delegation_hash: p.delegation_hash,
          confirmed_at: p.confirmed_at,
          created_at: p.created_at,
        }
      }),
      ...invocations.map((inv) => ({
        type: 'mcp_tool_call' as const,
        id: inv.id,
        tool_name: inv.tool_name,
        payment_id: inv.payment_id,
        result_status: inv.result_status,
        next_action: inv.next_action,
        error_code: inv.error_code,
        status_code: inv.status_code,
        created_at: inv.created_at,
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
      if (!(await agentExistsForUser(id, sub))) {
        return reply.code(404).send({ error: 'Agent not found' })
      }

      // Total spent per token (confirmed only)
      const totals = await sumAgentSpendAllTime(id)

      // Spent today per token
      const todayTotals = await sumAgentSpendToday(id)

      // Spent this week
      const weekTotals = await sumAgentSpendThisWeek(id)

      // #2055: pending approvals are structurally zero — the queue died with
      // the AllowanceModule rail; the wire field survives for compatibility.
      const pendingApprovals = 0

      return {
        all_time: totals.map((r) => ({
          token: r.token_symbol,
          total_spent: r.total_spent,
          tx_count: Number(r.tx_count),
        })),
        today: todayTotals.map((r) => ({
          token: r.token_symbol,
          total_spent: r.total_spent,
          tx_count: Number(r.tx_count),
        })),
        this_week: weekTotals.map((r) => ({
          token: r.token_symbol,
          total_spent: r.total_spent,
          tx_count: Number(r.tx_count),
        })),
        pending_approvals: pendingApprovals,
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
    const agentRows = await listAgentNamesForUser(sub)
    const agentNames = new Map(agentRows.map((a) => [a.id, a.name]))
    const agentIds = agentRows.map((a) => a.id)

    if (agentIds.length === 0) {
      return { activity: [], pending_approvals: 0 }
    }

    // Recent payments across all agents
    const payments = await listFeedPayments(agentIds, limit, offset)

    // Recent approval requests
    // #2055: approval feed entries died with the table (see the per-agent
    // handler above).

    // Recent MCP tool invocations (audit log)
    const invocations = await listToolInvocationsForAgents(agentIds, limit, offset)

    // Merge and sort
    const activity = [
      ...payments.map((p) => {
        const lifecycle = machinePaymentLifecycle({
          rail: p.source,
          paymentStatus: p.status,
          paymentProofStatus: p.payment_proof_status,
          reconciliationEventType: p.payment_reconciliation_event_type,
        })

        return {
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
          payment_flow_status: lifecycle.paymentFlowStatus,
          payment_attention_reason: lifecycle.paymentAttentionReason,
          source: p.source ?? 'direct',
          x402_resource_url: p.x402_resource_url,
          x402_merchant_address: p.x402_merchant_address,
          chain_id: p.chain_id,
          token_address: p.token_address,
          safe_id: p.safe_id,
          safe_address: p.safe_address,
          safe_name: p.safe_name,
          explorer_url: p.tx_hash ? getExplorerUrl(p.chain_id, 'tx', p.tx_hash) : null,
          // #799: which on-chain mechanism moved the money, and (session rail)
          // WHICH period-session the intent was pinned to — makes the #769
          // lazy rollover observable to the owner without DB access.
          execution_rail: p.execution_rail,
          // #829: which delegation authorized a delegation-rail payment.
          delegation_hash: p.delegation_hash,
          confirmed_at: p.confirmed_at,
          created_at: p.created_at,
        }
      }),
      ...invocations.map((inv) => ({
        type: 'mcp_tool_call' as const,
        id: inv.id,
        agent_id: inv.agent_id,
        agent_name: agentNames.get(inv.agent_id) ?? 'Unknown',
        tool_name: inv.tool_name,
        payment_id: inv.payment_id,
        result_status: inv.result_status,
        next_action: inv.next_action,
        error_code: inv.error_code,
        status_code: inv.status_code,
        created_at: inv.created_at,
      })),
    ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
     .slice(0, limit)

    // #2055: structurally zero — the approval queue died with the
    // AllowanceModule rail; the wire field survives for compatibility.
    const pendingApprovals = 0

    return {
      activity,
      pending_approvals: pendingApprovals,
    }
  })
}
