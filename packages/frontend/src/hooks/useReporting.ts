'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'

export type ReportingSyncStatus = 'pending' | 'pushed' | 'failed' | 'skipped'

export interface ReportingSync {
  payment_id: string
  provider: string
  status: ReportingSyncStatus
  external_ref: string | null
  error: string | null
  attempts: number
  updated_at: string
}

export interface ReportingStatus {
  hosted: boolean
  flagEnabled: boolean
  /**
   * Whether a live accounting connector is wired up. False today — the Fortnox
   * adapter (#496/#498) is deferred to a follow-up, so sync is a preview that
   * doesn't yet deliver to an external tool.
   */
  liveSyncReady: boolean
  available: boolean
  connected: boolean
  syncs: ReportingSync[]
}

export function useReporting() {
  const [status, setStatus] = useState<ReportingStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (isCancelled: () => boolean = () => false) => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<ReportingStatus>('/accounting/reporting/status')
      if (!isCancelled()) setStatus(res)
    } catch {
      if (!isCancelled()) setError('We could not load reporting status. Try again in a moment.')
    } finally {
      if (!isCancelled()) setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void load(() => cancelled)
    return () => { cancelled = true }
  }, [load])

  const sync = useCallback(async () => {
    await api.post('/accounting/reporting/sync')
    await load()
  }, [load])

  return { status, loading, error, refetch: () => load(), sync }
}
