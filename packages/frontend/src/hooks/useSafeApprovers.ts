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
export interface KnownApprover {
  address: string
  type: ApproverType
  label: string | null
  /** Safe ids (as strings) this approver already has metadata on. */
  safe_ids: string[]
}

interface UseKnownApprovers {
  known: KnownApprover[]
  loading: boolean
  refetch: () => Promise<void>
}

/**
 * The user's approver registry across all their Safes — the source for
 * reusing an existing approver on another account (#417).
 */
export function useKnownApprovers(): UseKnownApprovers {
  const [known, setKnown] = useState<KnownApprover[]>([])
  const [loading, setLoading] = useState(true)

  const fetchKnown = useCallback(async () => {
    setLoading(true)
    try {
      const result = await api.get<{ approvers: KnownApprover[] }>('/user/safes/known-approvers')
      setKnown(result.approvers)
    } catch {
      setKnown([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchKnown()
  }, [fetchKnown])

  return { known, loading, refetch: fetchKnown }
}

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
