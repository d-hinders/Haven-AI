'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ApiOperations, ApiPaths } from '@haven_ai/core'
import { api, ApiRequestError } from '@/lib/api'

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

// ── Accounting providers and connections (#2862, #2867, #2868) ──────
// Wire shapes are the generated ones; these hooks only add loading state.
export type AccountingProvider =
  ApiPaths['/accounting/providers']['get']['responses']['200']['content']['application/json']['providers'][number]
export type AccountingConnection =
  ApiPaths['/accounting/connections']['get']['responses']['200']['content']['application/json']['connections'][number]
export type AccountingConnectionStatus = AccountingConnection['status']
/** `PATCH /accounting/connections/{provider}/settings` body — exactly two optional keys (#2867). */
export type AccountingConnectionSettingsPatch =
  ApiOperations['updateAccountingConnectionSettings']['requestBody']['content']['application/json']
/** `POST /accounting/connections/{provider}/backfill` answer: the new floor and how many were fed. */
export type AccountingBackfillResult =
  ApiOperations['backfillAccountingConnection']['responses']['200']['content']['application/json']

/**
 * The structured refusals the connection routes answer with (#2867), as the
 * dashboard branches on them. `ApiRequestError.body` is `unknown` by design;
 * this is the one place the accounting surface narrows it.
 */
export type AccountingRefusalCode =
  | 'INVALID_SETTING'
  | 'SINCE_INVALID'
  | 'SINCE_NOT_EARLIER'
  | 'NOT_ACTIVE'
  | 'NOT_FOUND'
  | 'PROVIDER_NOT_LIVE'
  | 'WRONG_AUTH_KIND'

export interface AccountingRefusal {
  code: AccountingRefusalCode | null
  /** `INVALID_SETTING` names the offending setting; null when the body itself was refused. */
  key: string | null
  message: string
}

/** Read `{ error, error_code, key? }` off a failed request; anything else is `code: null`. */
export function accountingRefusal(err: unknown): AccountingRefusal {
  if (err instanceof ApiRequestError) {
    const body = (err.body ?? {}) as { error_code?: unknown; key?: unknown }
    const code = typeof body.error_code === 'string' ? (body.error_code as AccountingRefusalCode) : null
    const key = typeof body.key === 'string' ? body.key : null
    return { code, key, message: err.message }
  }
  return { code: null, key: null, message: err instanceof Error ? err.message : '' }
}

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

  /**
   * Fetch the consent URL for an OAuth provider and navigate to it. Also the
   * re-consent path (#2865): the same call on an existing connection, whatever
   * its status, comes back `connected` with settings and history kept.
   */
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

  /**
   * `PATCH …/settings` (#2867). The answer carries the merged connection, so
   * the row is replaced in place rather than re-listed — a refused patch
   * (400 `INVALID_SETTING`, `key` naming the setting) leaves the list as it
   * was and rejects with the `ApiRequestError` for the caller to narrow.
   */
  const updateSettings = useCallback(async (provider: string, patch: AccountingConnectionSettingsPatch) => {
    const res = await api.patch<{ connection: AccountingConnection }>(
      `/accounting/connections/${encodeURIComponent(provider)}/settings`,
      patch,
    )
    setConnections((prev) => prev.map((c) => (c.provider === res.connection.provider ? res.connection : c)))
    return res.connection
  }, [])

  /**
   * `POST …/backfill { since }` (#2867) — the ONE call that moves `feedFrom`
   * earlier. `since` is sent exactly as given: the route wants a strict ISO
   * date (`YYYY-MM-DD`) and answers `SINCE_INVALID` otherwise, so the caller
   * validates the shape before asking.
   */
  const backfill = useCallback(async (provider: string, since: string) => {
    const res = await api.post<AccountingBackfillResult>(
      `/accounting/connections/${encodeURIComponent(provider)}/backfill`,
      { since },
    )
    await load()
    return res
  }, [load])

  return {
    connections,
    loading,
    error,
    connect,
    connectWithApiKey,
    disconnect,
    activate,
    updateSettings,
    backfill,
    refetch: () => load(),
  }
}
