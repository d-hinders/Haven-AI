'use client'

/**
 * One Sales payment's detail (#4900, epic #4885): `GET
 * /merchant-sales/payments/:txHash`, the row the list shows plus the
 * merchant's own reference and the inbound legs.
 *
 * `null` skips the read (the panel is closed). A new hash starts again and
 * shows loading; a superseded answer never writes. `refetch` reloads the same
 * payment WITHOUT blanking a panel that already shows it, which is what clearing a sale record
 * wants: the panel stays put and its record row changes underneath.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiRequestError } from '@/lib/api'
import type { SalesPaymentDetail } from '@/lib/sales'

export interface UseSalesPaymentDetailResult {
  detail: SalesPaymentDetail | null
  loading: boolean
  /** The payment is not on this account (404) — distinct from a read that failed. */
  notFound: boolean
  failed: boolean
  refetch: () => void
}

export function useSalesPaymentDetail(txHash: string | null): UseSalesPaymentDetailResult {
  const [detail, setDetail] = useState<SalesPaymentDetail | null>(null)
  const [loading, setLoading] = useState(txHash !== null)
  const [notFound, setNotFound] = useState(false)
  const [failed, setFailed] = useState(false)
  const requestIdRef = useRef(0)

  const load = useCallback(
    async (silent: boolean) => {
      const requestId = ++requestIdRef.current
      if (txHash === null) {
        setDetail(null)
        setLoading(false)
        setNotFound(false)
        setFailed(false)
        return
      }
      if (!silent) {
        setDetail(null)
        setLoading(true)
      }
      setNotFound(false)
      setFailed(false)
      try {
        const response = await api.get<SalesPaymentDetail>(`/merchant-sales/payments/${encodeURIComponent(txHash)}`)
        if (requestIdRef.current !== requestId) return
        setDetail(response)
      } catch (err) {
        if (requestIdRef.current !== requestId) return
        if (err instanceof ApiRequestError && err.status === 404) setNotFound(true)
        else setFailed(true)
      } finally {
        if (requestIdRef.current === requestId) setLoading(false)
      }
    },
    [txHash],
  )

  useEffect(() => {
    void load(false)
    return () => {
      requestIdRef.current += 1
    }
  }, [load])

  return { detail, loading, notFound, failed, refetch: () => void load(detail !== null) }
}
