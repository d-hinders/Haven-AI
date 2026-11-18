'use client'

/**
 * The Sales keys (#4900, #4905, epic #4885): `GET /merchant-keys` lists the
 * account's keys by prefix, `POST` creates one and `DELETE /:id` revokes one.
 *
 * The secret `create` returns goes straight to the caller and is held nowhere
 * here: not in state, not in a ref, not in the list. The list is re-read after
 * a create or revoke and only ever carries prefixes.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiSchema } from '@haven_ai/core'
import { api } from '@/lib/api'
import type { SalesKey } from '@/lib/sales'

export interface UseMerchantKeysResult {
  keys: SalesKey[]
  loading: boolean
  failed: boolean
  reload: () => void
  /** Creates a key. The result carries the secret — the one time anything does. */
  create: () => Promise<CreatedSalesKey>
  /** Revokes a key, then re-reads the list. */
  revoke: (id: string) => Promise<void>
}

export type CreatedSalesKey = ApiSchema<'CreatedMerchantKey'>

export function useMerchantKeys(): UseMerchantKeysResult {
  const [keys, setKeys] = useState<SalesKey[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const requestIdRef = useRef(0)

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current
    setLoading(true)
    setFailed(false)
    try {
      const response = await api.get<ApiSchema<'MerchantKeyListResponse'>>('/merchant-keys')
      if (requestIdRef.current !== requestId) return
      setKeys(response.keys)
    } catch {
      if (requestIdRef.current !== requestId) return
      setFailed(true)
    } finally {
      if (requestIdRef.current === requestId) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    return () => {
      requestIdRef.current += 1
    }
  }, [load])

  const create = useCallback(async () => {
    const created = await api.post<CreatedSalesKey>('/merchant-keys')
    void load()
    return created
  }, [load])

  const revoke = useCallback(
    async (id: string) => {
      await api.delete(`/merchant-keys/${encodeURIComponent(id)}`)
      void load()
    },
    [load],
  )

  return { keys, loading, failed, reload: () => void load(), create, revoke }
}

/**
 * #4905: how a Sales key is named on screen: the prefix's first 16 characters
 * (`sk_merchant_4f2a…`), as the approved mockup draws it. The full stored
 * prefix (24 characters) overflows the Detail list's label track; one helper so
 * the list, the revoke title and the created dialog name a key the same way.
 */
export function salesKeyLabel(prefix: string): string {
  return `${prefix.slice(0, 16)}…`
}
