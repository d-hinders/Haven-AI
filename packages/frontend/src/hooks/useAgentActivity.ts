'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'

export interface ActivityItem {
  type: 'payment' | 'approval'
  id: string
  agent_id?: string
  agent_name?: string
  token: string
  amount: string
  to: string
  reason?: string | null
  status: string
  tx_hash: string | null
  explorer_url: string | null
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
