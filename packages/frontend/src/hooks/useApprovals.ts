'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'

export interface ApprovalRequest {
  id: string
  agent_id: string
  agent_name: string
  safe_address: string
  token_symbol: string
  token_address: string
  to_address: string
  amount_raw: string
  amount_human: string
  reason: string | null
  status: string
  tx_hash: string | null
  reviewed_at: string | null
  created_at: string
  expires_at: string
}

interface ApprovalsResponse {
  approvals: ApprovalRequest[]
  pending_count: number
}

export function useApprovals(pollInterval = 15000) {
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const [pendingCount, setPendingCount] = useState(0)
  const [loading, setLoading] = useState(true)

  const fetchApprovals = useCallback(async () => {
    try {
      const data = await api.get<ApprovalsResponse>('/approvals?status=all')
      setApprovals(data.approvals)
      setPendingCount(data.pending_count)
    } catch {
      // Silently fail — user might not be logged in
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchApprovals()
    const interval = setInterval(fetchApprovals, pollInterval)
    return () => clearInterval(interval)
  }, [fetchApprovals, pollInterval])

  const approve = useCallback(async (id: string) => {
    const result = await api.post<{ id: string; status: string; payment: unknown }>(
      `/approvals/${id}/approve`,
    )
    await fetchApprovals()
    return result
  }, [fetchApprovals])

  const reject = useCallback(async (id: string) => {
    await api.post(`/approvals/${id}/reject`)
    await fetchApprovals()
  }, [fetchApprovals])

  const markExecuted = useCallback(async (id: string, txHash: string) => {
    await api.post(`/approvals/${id}/executed`, { tx_hash: txHash })
    await fetchApprovals()
  }, [fetchApprovals])

  return {
    approvals,
    pendingCount,
    loading,
    approve,
    reject,
    markExecuted,
    refetch: fetchApprovals,
  }
}
