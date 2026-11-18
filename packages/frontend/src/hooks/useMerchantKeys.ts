'use client'

/**
 * The Sales keys, read-only (#4900, epic #4885): `GET /merchant-keys`, the
 * account's keys by prefix. Part 2 of #4900 shows only how many are active;
 * #4905 builds the create and revoke screens and replaces `SalesKeysSection`,
 * its one consumer.
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
}

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

  return { keys, loading, failed, reload: () => void load() }
}
