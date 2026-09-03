'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { PaymentStatus } from '@/lib/payment-status'

/**
 * #2120: was `ApprovalStatus | PaymentStatus`. The approval half is gone with
 * the queue — see the decision note in `lib/payment-status.ts`.
 */
type ActivityStatus = PaymentStatus

/**
 * Payment rows — money-movement events that fit the transactions table.
 *
 * #2120: `type` was `'payment' | 'approval'`. Since #2055 the activity routes
 * build their list from `payment_intents` + MCP tool invocations only; the
 * `approval_requests` entries went with the table (migration 070), so no
 * backend can emit an `'approval'` row. Narrowed so a fixture cannot mint one
 * either — `screenshot-fixture.test.ts` reads this discriminator.
 */
export interface PaymentActivityItem {
  type: 'payment'
  id: string
  agent_id?: string
  agent_name?: string
  token: string
  token_address?: string | null
  amount_raw?: string | null
  amount: string
  to: string
  reason?: string | null
  status: ActivityStatus
  tx_hash: string | null
  source?: string
  x402_resource_url?: string | null
  x402_merchant_address?: string | null
  chain_id?: number | null
  safe_id?: string | null
  safe_address?: string | null
  safe_name?: string | null
  explorer_url: string | null
  confirmed_at?: string | null
  payment_proof_status?: string | null
  payment_flow_status?: 'paid' | 'confirming_merchant' | 'needs_attention' | null
  payment_attention_reason?: 'merchant_retry_rejected_after_payment' | null
  created_at: string
}

/**
 * MCP tool invocation rows — audit-log entries produced by the
 * `X-Haven-MCP-Tool` header on the backend. Surfaced separately from the
 * transactions table because most of them never move money (status reads,
 * quote inspections). See backend migration 015_agent_tool_invocations.
 */
export interface McpToolCallActivityItem {
  type: 'mcp_tool_call'
  id: string
  agent_id?: string
  agent_name?: string
  tool_name: string
  payment_id: string | null
  result_status: 'ok' | 'error' | 'denied' | string
  next_action: string | null
  error_code: string | null
  status_code: number | null
  created_at: string
}

export type ActivityItem = PaymentActivityItem | McpToolCallActivityItem

export function isPaymentActivityItem(item: ActivityItem): item is PaymentActivityItem {
  return item.type === 'payment'
}

export function isMcpToolCallActivityItem(item: ActivityItem): item is McpToolCallActivityItem {
  return item.type === 'mcp_tool_call'
}

export interface AgentStats {
  all_time: { token: string; total_spent: string; tx_count: number }[]
  today: { token: string; total_spent: string; tx_count: number }[]
  this_week: { token: string; total_spent: string; tx_count: number }[]
  pending_approvals: number
}

export function useAgentActivity(agentId: string | null) {
  const [activity, setActivity] = useState<ActivityItem[]>([])
  const [stats, setStats] = useState<AgentStats | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchData = useCallback(async () => {
    if (!agentId) return
    try {
      const [activityRes, statsRes] = await Promise.all([
        api.get<{ activity: ActivityItem[] }>(`/agent-activity/${agentId}/activity`),
        api.get<AgentStats>(`/agent-activity/${agentId}/stats`),
      ])
      // A 200 whose body omits `activity` must not void the array the page
      // filters over — that crashed /agents/[agentId] outright (#1075).
      setActivity(activityRes?.activity ?? [])
      setStats(statsRes ?? null)
    } catch {
      // Silently fail
    } finally {
      setLoading(false)
    }
  }, [agentId])

  useEffect(() => {
    if (agentId) {
      setLoading(true)
      fetchData()
    }
  }, [agentId, fetchData])

  return { activity, stats, loading, refetch: fetchData }
}
