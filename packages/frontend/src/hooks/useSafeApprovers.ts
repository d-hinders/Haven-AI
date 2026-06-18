'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'

export type ApproverType = 'eoa' | 'passkey'

export interface Approver {
  address: string
  type: ApproverType
  label: string | null
}

interface ApproversResponse {
  threshold: number
  approvers: Approver[]
}

interface UseSafeApprovers {
  approvers: Approver[]
  threshold: number
  loading: boolean
  error: string | null
  refetch: () => Promise<void>
}

/**
 * Live approver (Safe owner) set for one Safe. Membership comes from on-chain
 * `getOwners()` on the backend, merged with stored label/type metadata.
 */
export function useSafeApprovers(safeId: string | null): UseSafeApprovers {
  const [approvers, setApprovers] = useState<Approver[]>([])
  const [threshold, setThreshold] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchApprovers = useCallback(async () => {
    if (!safeId) return
    setLoading(true)
    setError(null)
    try {
      const result = await api.get<ApproversResponse>(`/user/safes/${safeId}/approvers`)
      setApprovers(result.approvers)
      setThreshold(result.threshold)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load approvers.')
    } finally {
      setLoading(false)
    }
  }, [safeId])

  useEffect(() => {
    void fetchApprovers()
  }, [fetchApprovers])

  return { approvers, threshold, loading, error, refetch: fetchApprovers }
}
