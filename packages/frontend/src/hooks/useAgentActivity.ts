'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { ApprovalStatus, PaymentStatus } from '@/lib/payment-status'

type ActivityStatus = ApprovalStatus | PaymentStatus

export interface ActivityItem {
  type: 'payment' | 'approval'
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
  created_at: string
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
      setActivity(activityRes.activity)
      setStats(statsRes)
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

export function useActivityFeed() {
  const [activity, setActivity] = useState<ActivityItem[]>([])
  const [pendingApprovals, setPendingApprovals] = useState(0)
  const [loading, setLoading] = useState(true)

  const fetchData = useCallback(async () => {
    try {
      const data = await api.get<{ activity: ActivityItem[]; pending_approvals: number }>(
        '/agent-activity/feed',
      )
      setActivity(data.activity)
      setPendingApprovals(data.pending_approvals)
    } catch {
      // Silently fail
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  return { activity, pendingApprovals, loading, refetch: fetchData }
}
