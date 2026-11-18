'use client'

/**
 * The Sales account's Stripe deposit addresses (#4954, epic #4886; dev and
 * Stripe sandbox only): the list, register and retire, through #4952's
 * owner-session routes (`/merchant-deposit-addresses`).
 *
 * Pass `enabled: false` to skip the read — the section renders only while
 * Sales is on, and with Sales off the route answers an empty list anyway.
 * A write that succeeds reads the list again rather than patching it, so the
 * order and the `active` flags are always the route's. A write whose outcome
 * is unknown (no answer, or a 5xx) also reads the list again: the address may
 * be registered or retired, and the list is the one place that says so.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import {
  classifyDepositAddressError,
  type DepositAddress,
  type DepositAddressList,
  type DepositAddressRefusal,
} from '@/lib/merchant-services'

export type DepositAddressWrite =
  | { ok: true; address: DepositAddress }
  | { ok: false; refusal: DepositAddressRefusal }

export interface UseMerchantDepositAddressesResult {
  addresses: DepositAddress[]
  loading: boolean
  failed: boolean
  refetch: () => void
  register: (address: string) => Promise<DepositAddressWrite>
  retire: (id: string) => Promise<DepositAddressWrite>
}

export function useMerchantDepositAddresses(enabled: boolean): UseMerchantDepositAddressesResult {
  const [addresses, setAddresses] = useState<DepositAddress[]>([])
  const [loading, setLoading] = useState(enabled)
  const [failed, setFailed] = useState(false)
  const requestIdRef = useRef(0)

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current
    if (!enabled) {
      setAddresses([])
      setLoading(false)
      setFailed(false)
      return
    }
    setLoading(true)
    setFailed(false)
    try {
      const response = await api.get<DepositAddressList>('/merchant-deposit-addresses')
      if (requestIdRef.current !== requestId) return
      setAddresses(response.addresses)
    } catch {
      if (requestIdRef.current !== requestId) return
      setFailed(true)
    } finally {
      if (requestIdRef.current === requestId) setLoading(false)
    }
  }, [enabled])

  useEffect(() => {
    void load()
    return () => {
      requestIdRef.current += 1
    }
  }, [load])

  const write = useCallback(
    async (call: () => Promise<DepositAddress>): Promise<DepositAddressWrite> => {
      try {
        const address = await call()
        void load()
        return { ok: true, address }
      } catch (err) {
        const refusal = classifyDepositAddressError(err)
        // The list may already say what happened: an unknown outcome, a
        // retired or missing registration, or another tab's registration.
        if (refusal.kind !== 'invalid' && refusal.kind !== 'own_address' && refusal.kind !== 'rate_limited') {
          void load()
        }
        return { ok: false, refusal }
      }
    },
    [load],
  )

  const register = useCallback(
    (address: string) =>
      write(() => api.post<DepositAddress>('/merchant-deposit-addresses', { address: address.trim() })),
    [write],
  )

  const retire = useCallback(
    (id: string) =>
      write(() => api.post<DepositAddress>(`/merchant-deposit-addresses/${encodeURIComponent(id)}/retire`)),
    [write],
  )

  return { addresses, loading, failed, refetch: () => void load(), register, retire }
}
