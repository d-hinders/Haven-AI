'use client'

/**
 * The Sales catalogue (#4900, epic #4885): the kit deployment's address, the
 * outcome of Haven's last read of it, and the product list.
 *
 * One read for the page, held by `SalesClient` and handed to the Products and
 * Setup tabs, so the tab's count and warning dot, the products table and the
 * kit-address field all describe the SAME answer.
 *
 * - `GET /merchant-catalogue`: the state (empty when no address is saved).
 * - `PUT /merchant-catalogue/deployment`: saves the address AND reads it, and
 *   answers the catalogue that read produced. A refused address answers 400
 *   `MERCHANT_CATALOGUE_URL_REFUSED` with the guard's detail; that sentence is
 *   returned to the field, not rewritten.
 * - `POST /merchant-catalogue/refresh`: "Read now".
 *
 * The two writes return a result instead of throwing, as `useMerchantServices`
 * does: a refusal is a normal outcome the field or the header words.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiRequestError } from '@/lib/api'
import type { SalesCatalogue } from '@/lib/sales'

const PATH = '/merchant-catalogue'

export type CatalogueWriteResult = { ok: true } | { ok: false; message: string }

export interface UseMerchantCatalogueResult {
  data: SalesCatalogue | null
  loading: boolean
  failed: boolean
  /** "Read now" is in flight. */
  reading: boolean
  /** Saving the address is in flight. */
  saving: boolean
  reload: () => void
  readNow: () => Promise<CatalogueWriteResult>
  saveDeployment: (deploymentUrl: string) => Promise<CatalogueWriteResult>
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof ApiRequestError && err.message ? err.message : fallback
}

export function useMerchantCatalogue(): UseMerchantCatalogueResult {
  const [data, setData] = useState<SalesCatalogue | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [reading, setReading] = useState(false)
  const [saving, setSaving] = useState(false)
  const requestIdRef = useRef(0)

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current
    setLoading(true)
    setFailed(false)
    try {
      const response = await api.get<SalesCatalogue>(PATH)
      if (requestIdRef.current !== requestId) return
      setData(response)
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

  const readNow = useCallback(async (): Promise<CatalogueWriteResult> => {
    setReading(true)
    try {
      setData(await api.post<SalesCatalogue>(`${PATH}/refresh`))
      return { ok: true }
    } catch (err) {
      return { ok: false, message: messageOf(err, 'Haven could not read your kit just now. Try again.') }
    } finally {
      setReading(false)
    }
  }, [])

  const saveDeployment = useCallback(async (deploymentUrl: string): Promise<CatalogueWriteResult> => {
    setSaving(true)
    try {
      setData(await api.put<SalesCatalogue>(`${PATH}/deployment`, { deployment_url: deploymentUrl }))
      return { ok: true }
    } catch (err) {
      return { ok: false, message: messageOf(err, 'The address could not be saved. Try again.') }
    } finally {
      setSaving(false)
    }
  }, [])

  return { data, loading, failed, reading, saving, reload: () => void load(), readNow, saveDeployment }
}
