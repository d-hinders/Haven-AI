'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'

export interface ApprovalRequest {
  id: string
  agent_id: string
  agent_name: string
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
  status: string
  tx_hash: string | null
  reviewed_at: string | null
  created_at: string
  expires_at: string
}

interface ApprovalsResponse {
  approvals: ApprovalRequest[]
  actionable_count?: number
  pending_count?: number
}

export function useApprovals(pollInterval = 15000) {
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const [actionableCount, setActionableCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchApprovals = useCallback(async () => {
    try {
      setError(null)
      const data = await api.get<ApprovalsResponse>('/approvals?status=all')
      setApprovals(data.approvals)
      setActionableCount(data.actionable_count ?? data.pending_count ?? 0)
    } catch (err) {
      console.error('Could not load approvals:', err)
      setError('Could not load approvals. Try again in a moment.')
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

  const markProposed = useCallback(async (id: string) => {
    await api.post(`/approvals/${id}/proposed`)
    await fetchApprovals()
  }, [fetchApprovals])

  const markExecuted = useCallback(async (id: string, txHash: string) => {
    await api.post(`/approvals/${id}/executed`, { tx_hash: txHash })
    await fetchApprovals()
  }, [fetchApprovals])

  return {
    approvals,
    actionableCount,
    loading,
    error,
    approve,
    reject,
    markProposed,
    markExecuted,
    refetch: fetchApprovals,
  }
}
