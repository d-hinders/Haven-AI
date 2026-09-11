'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ApiPaths } from '@haven_ai/core'
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

// ── Accounting providers and connections (#2862) ────────────────────
// Wire shapes are the generated ones; these hooks only add loading state.
export type AccountingProvider =
  ApiPaths['/accounting/providers']['get']['responses']['200']['content']['application/json']['providers'][number]
export type AccountingConnection =
  ApiPaths['/accounting/connections']['get']['responses']['200']['content']['application/json']['connections'][number]

export function useAccountingProviders() {
  const [providers, setProviders] = useState<AccountingProvider[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (isCancelled: () => boolean = () => false) => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<{ providers: AccountingProvider[] }>('/accounting/providers')
      if (!isCancelled()) setProviders(res.providers)
    } catch {
      if (!isCancelled()) setError('We could not load accounting providers.')
    } finally {
      if (!isCancelled()) setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void load(() => cancelled)
    return () => { cancelled = true }
  }, [load])

  return { providers, loading, error, refetch: () => load() }
}

export function useAccountingConnections() {
  const [connections, setConnections] = useState<AccountingConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (isCancelled: () => boolean = () => false) => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get<{ connections: AccountingConnection[] }>('/accounting/connections')
      if (!isCancelled()) setConnections(res.connections)
    } catch {
      if (!isCancelled()) setError('We could not load your accounting connections.')
    } finally {
      if (!isCancelled()) setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void load(() => cancelled)
    return () => { cancelled = true }
  }, [load])

  /** Fetch the consent URL for an OAuth provider and navigate to it. */
  const connect = useCallback(async (provider: string) => {
    const res = await api.post<{ url: string }>(`/accounting/connections/${encodeURIComponent(provider)}/connect-url`)
    window.location.href = res.url
  }, [])

  const connectWithApiKey = useCallback(async (provider: string, apiKey: string) => {
    await api.post(`/accounting/connections/${encodeURIComponent(provider)}/api-key`, { apiKey })
    await load()
  }, [load])

  const disconnect = useCallback(async (provider: string) => {
    await api.delete(`/accounting/connections/${encodeURIComponent(provider)}`)
    await load()
  }, [load])

  const activate = useCallback(async (provider: string) => {
    await api.post(`/accounting/connections/${encodeURIComponent(provider)}/activate`)
    await load()
  }, [load])

  return { connections, loading, error, connect, connectWithApiKey, disconnect, activate, refetch: () => load() }
}

// ── Fortnox connection ──────────────────────────────────────────────
// Kept for the accounting page until slice 10 redesigns it: the same
// `connect` / `disconnect` surface, now on the generic routes.
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
      const [{ providers }, { connections }] = await Promise.all([
        api.get<{ providers: AccountingProvider[] }>('/accounting/providers'),
        api.get<{ connections: AccountingConnection[] }>('/accounting/connections'),
      ])
      const provider = providers.find((p) => p.id === 'fortnox')
      const connection = connections.find((c) => c.provider === 'fortnox')
      const connected = connection?.status === 'connected'
      if (!isCancelled()) {
        setStatus({
          configured: Boolean(provider?.configured),
          connected,
          scope: connected ? connection?.grantedScope ?? null : null,
          expiresAt: connected ? connection?.tokenExpiresAt ?? null : null,
        })
      }
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
    const res = await api.post<{ url: string }>('/accounting/connections/fortnox/connect-url')
    window.location.href = res.url
  }, [])

  const disconnect = useCallback(async () => {
    await api.delete('/accounting/connections/fortnox')
    await load()
  }, [load])

  // The legacy asserting voucher push — dark behind the server flag (410).
  const push = useCallback((from?: string, to?: string) => {
    const params = new URLSearchParams()
    if (from) params.set('from', from)
    if (to) params.set('to', to)
    const qs = params.toString()
    return api.post<FortnoxPushResult>(`/accounting/fortnox/push${qs ? `?${qs}` : ''}`)
  }, [])

  return { status, loading, connect, disconnect, push, refetch: () => load() }
}
