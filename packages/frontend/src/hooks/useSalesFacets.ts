'use client'

/**
 * The options of the Sales payments list's Product and Payer facets for one
 * period (#4960; the read is #4959's `GET /merchant-sales/facets`).
 *
 * The read is UNFILTERED and uncapped: every product and payer of the period,
 * past the summary's top 100. The options therefore never shrink to the value
 * just selected, which a menu built from the filtered summary would do. The
 * state keys on the range; a superseded answer never writes. A failed read
 * leaves the facets without options, and the search still works.
 */

import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import type { SalesDayRange, SalesFacets } from '@/lib/sales'

export function useSalesFacets(range: SalesDayRange): SalesFacets | null {
  const [data, setData] = useState<SalesFacets | null>(null)
  const requestIdRef = useRef(0)
  const { from, to } = range

  useEffect(() => {
    const requestId = ++requestIdRef.current
    setData(null)
    api
      .get<SalesFacets>(`/merchant-sales/facets?from=${from}&to=${to}`)
      .then((response) => {
        if (requestIdRef.current === requestId) setData(response)
      })
      .catch(() => {
        // The options are an aid: without them the facets show none and the
        // search still reaches every product and payer.
      })
    return () => {
      requestIdRef.current += 1
    }
  }, [from, to])

  return data
}
