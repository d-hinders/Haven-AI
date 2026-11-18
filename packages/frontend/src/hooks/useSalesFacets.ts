'use client'

/**
 * The options of the Sales payments list's Product and Payer facets for one
 * period (#4960; the read is #4959's `GET /merchant-sales/facets`).
 *
 * The read is UNFILTERED and uncapped: every product and payer of the period,
 * past the summary's top 100. The options therefore never shrink to the value
 * just selected, which a menu built from the filtered summary would do. The
 * state keys on the range; a superseded answer never writes. A failed read
 * leaves the facets without options and says so (`failed`): the page shows
 * the list controls' filter-options alert, and the search still works.
 * `refreshKey` reads again when something the options describe changed (a
 * sale record cleared can take a product out of the period).
 */

import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import type { SalesDayRange, SalesFacets } from '@/lib/sales'

export interface UseSalesFacetsResult {
  data: SalesFacets | null
  failed: boolean
}

export function useSalesFacets(range: SalesDayRange, refreshKey = 0): UseSalesFacetsResult {
  const [data, setData] = useState<SalesFacets | null>(null)
  const [failed, setFailed] = useState(false)
  const requestIdRef = useRef(0)
  const { from, to } = range

  useEffect(() => {
    const requestId = ++requestIdRef.current
    setData(null)
    setFailed(false)
    api
      .get<SalesFacets>(`/merchant-sales/facets?from=${from}&to=${to}`)
      .then((response) => {
        if (requestIdRef.current === requestId) setData(response)
      })
      .catch(() => {
        if (requestIdRef.current === requestId) setFailed(true)
      })
    return () => {
      requestIdRef.current += 1
    }
  }, [from, to, refreshKey])

  return { data, failed }
}
