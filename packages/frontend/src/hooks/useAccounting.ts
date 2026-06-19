'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'

// ── Reconciliation ──────────────────────────────────────────────────
export type ReconcileStatus = 'ok' | 'missing_fx' | 'missing_tx' | 'unbalanced'

export interface ReconcileItem {
  paymentId: string
  txHash: string
  settledAt: string
  status: ReconcileStatus
}

export interface ReconcileReport {
  total: number
  ok: number
  issues: number
  byStatus: Record<ReconcileStatus, number>
  items: ReconcileItem[]
}

export function useReconcile() {
  const [report, setReport] = useState<ReconcileReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (isCancelled: () => boolean = () => false) => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<ReconcileReport>('/accounting/reconcile')
      if (!isCancelled()) setReport(res)
    } catch {
      if (!isCancelled()) setError('We could not load reconciliation. Try again in a moment.')
    } finally {
      if (!isCancelled()) setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void load(() => cancelled)
    return () => { cancelled = true }
  }, [load])

  return { report, loading, error, refetch: () => load() }
}

// ── Per-merchant BAS account overrides ──────────────────────────────
export interface MerchantAccountOverride {
  resource_url: string
  bas_account: string
}

export function useMerchantAccounts() {
  const [overrides, setOverrides] = useState<MerchantAccountOverride[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (isCancelled: () => boolean = () => false) => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<{ overrides: MerchantAccountOverride[] }>('/accounting/categories')
      if (!isCancelled()) setOverrides(res.overrides)
    } catch {
      if (!isCancelled()) setError('We could not load merchant accounts.')
    } finally {
      if (!isCancelled()) setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void load(() => cancelled)
    return () => { cancelled = true }
  }, [load])

  const setAccount = useCallback(async (resourceUrl: string, account: string) => {
    await api.put('/accounting/categories', { resourceUrl, account })
    await load()
  }, [load])

  const removeAccount = useCallback(async (resourceUrl: string) => {
    await api.delete(`/accounting/categories?resourceUrl=${encodeURIComponent(resourceUrl)}`)
    setOverrides((prev) => prev.filter((o) => o.resource_url !== resourceUrl))
  }, [])

  return { overrides, loading, error, setAccount, removeAccount, refetch: () => load() }
}

// ── Fortnox connection ──────────────────────────────────────────────
export interface FortnoxStatus {
  configured: boolean
  connected: boolean
  scope?: string | null
  expiresAt?: string | null
}

export interface FortnoxPushResult {
  pushed: number
  skipped: number
  failed: number
}

export function useFortnox() {
  const [status, setStatus] = useState<FortnoxStatus | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async (isCancelled: () => boolean = () => false) => {
    setLoading(true)
    try {
      const res = await api.get<FortnoxStatus>('/accounting/fortnox/status')
      if (!isCancelled()) setStatus(res)
    } catch {
      if (!isCancelled()) setStatus({ configured: false, connected: false })
    } finally {
      if (!isCancelled()) setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void load(() => cancelled)
    return () => { cancelled = true }
  }, [load])

  const connect = useCallback(async () => {
    const res = await api.post<{ url: string }>('/accounting/fortnox/connect-url')
    window.location.href = res.url
  }, [])

  const disconnect = useCallback(async () => {
    await api.delete('/accounting/fortnox')
    await load()
  }, [load])

  const push = useCallback((from?: string, to?: string) => {
    const params = new URLSearchParams()
    if (from) params.set('from', from)
    if (to) params.set('to', to)
    const qs = params.toString()
    return api.post<FortnoxPushResult>(`/accounting/fortnox/push${qs ? `?${qs}` : ''}`)
  }, [])

  return { status, loading, connect, disconnect, push, refetch: () => load() }
}
