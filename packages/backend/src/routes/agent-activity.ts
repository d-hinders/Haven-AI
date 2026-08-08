import { FastifyInstance } from 'fastify'
import { authMiddleware } from '../middleware/auth.js'
import { getExplorerUrl } from '../domain/chains.js'
import { machinePaymentLifecycle } from '../domain/machine-payment-lifecycle.js'
import { agentExistsForUser, listAgentNamesForUser } from '../infra/repositories/agents.js'
import { countActionableApprovalsForUser } from '../infra/repositories/approval-requests.js'
import {
  listToolInvocationsForAgent,
  listToolInvocationsForAgents,
} from '../infra/repositories/agent-tool-invocations.js'
import {
  countPendingApprovalsForAgent,
  listAgentApprovals,
  listAgentPayments,
  listFeedApprovals,
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

    // Fetch approval requests
    const approvals = await listAgentApprovals(id, limit, offset)

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
          session_permission_id: p.session_permission_id,
          // #829: which delegation authorized a delegation-rail payment.
          delegation_hash: p.delegation_hash,
          confirmed_at: p.confirmed_at,
          created_at: p.created_at,
        }
      }),
      ...approvals.map((a) => {
        const proofStatus = a.payment_proof_status ?? (a.status === 'executed' ? 'payment_confirmed' : null)
        const lifecycle = machinePaymentLifecycle({
          rail: a.source,
          paymentStatus: a.status,
          paymentProofStatus: proofStatus,
          reconciliationEventType: a.payment_reconciliation_event_type,
        })

        return {
          type: 'approval' as const,
          id: a.id,
          token: a.token_symbol,
          amount: a.amount_human,
          to: a.to_address,
          reason: a.reason,
          status: a.status,
          tx_hash: a.tx_hash,
          payment_proof_status: proofStatus,
          payment_flow_status: lifecycle.paymentFlowStatus,
          payment_attention_reason: lifecycle.paymentAttentionReason,
          source: a.source ?? 'direct',
          x402_resource_url: a.x402_resource_url,
          chain_id: a.chain_id,
          token_address: a.token_address,
          safe_id: a.safe_id,
          safe_address: a.safe_address,
          safe_name: a.safe_name,
          explorer_url: a.tx_hash ? getExplorerUrl(a.chain_id, 'tx', a.tx_hash) : null,
          created_at: a.created_at,
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

      // Pending approvals count
      const pendingApprovals = await countPendingApprovalsForAgent(id)

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
    const approvals = await listFeedApprovals(agentIds, limit, offset)

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
          session_permission_id: p.session_permission_id,
          // #829: which delegation authorized a delegation-rail payment.
          delegation_hash: p.delegation_hash,
          confirmed_at: p.confirmed_at,
          created_at: p.created_at,
        }
      }),
      ...approvals.map((a) => {
        const proofStatus = a.payment_proof_status ?? (a.status === 'executed' ? 'payment_confirmed' : null)
        const lifecycle = machinePaymentLifecycle({
          rail: a.source,
          paymentStatus: a.status,
          paymentProofStatus: proofStatus,
          reconciliationEventType: a.payment_reconciliation_event_type,
        })

        return {
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
          payment_proof_status: proofStatus,
          payment_flow_status: lifecycle.paymentFlowStatus,
          payment_attention_reason: lifecycle.paymentAttentionReason,
          source: a.source ?? 'direct',
          x402_resource_url: a.x402_resource_url,
          chain_id: a.chain_id,
          token_address: a.token_address,
          safe_id: a.safe_id,
          safe_address: a.safe_address,
          safe_name: a.safe_name,
          explorer_url: a.tx_hash ? getExplorerUrl(a.chain_id, 'tx', a.tx_hash) : null,
          created_at: a.created_at,
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

    // Pending approvals count
    const pendingApprovals = await countActionableApprovalsForUser(sub)

    return {
      activity,
      pending_approvals: pendingApprovals,
    }
  })
}
