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

  // #1362: read-back verification against Fortnox's own records — does the
  // pushed invoice exist, and has a human booked it (voucher assigned)?
  const verify = useCallback(async (paymentId: string) => {
    return api.get<ReportingVerification>(`/accounting/reporting/verify/${encodeURIComponent(paymentId)}`)
  }, [])

  // #1365: verification-gated reopen — the server re-checks Fortnox and only
  // flips a pushed row back to retryable when the invoice is confirmed gone.
  const reopen = useCallback(async (paymentId: string) => {
    await api.post(`/accounting/reporting/reopen/${encodeURIComponent(paymentId)}`)
    await load()
  }, [load])

  return { status, loading, error, refetch: () => load(), sync, verify, reopen }
}

export interface ReportingVerification {
  registered: boolean
  missing: 'deleted' | 'foreign_invoice' | null
  booked: boolean | null
  cancelled: boolean | null
  invoice_number: number
  voucher: string | null
  invoice_date: string | null
  total: number | null
  checked_at: string
}
