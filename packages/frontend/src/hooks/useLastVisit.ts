'use client'

/**
 * The "Since your last visit" read (#4709, epic #4701 decision 4).
 *
 * Two steps, in this order, once per tab entry:
 *
 * 1. `POST /user/visits { entry_id }` opens the entry and returns its window
 *    `{ previous, current }`. The entry id is stored in `sessionStorage`
 *    BEFORE the call (`lib/last-visit.ts`), so a lost response is retried with
 *    the same id and the server returns the same window instead of erasing it.
 * 2. `GET /dashboard/since?after=&through=&tz=` reads the figures for
 *    `(previous, current]` — only when there IS a previous entry. A first ever
 *    visit writes the marker and shows no line.
 *
 * A reload or a return from another page finds the bounds already stored and
 * makes NO call: the line stays for the whole entry, and polling never writes.
 * Every failure degrades to "no line" — never a guessed window.
 */

import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { browserTimeZone } from '@/lib/analytics-range'
import {
  newVisitEntryId,
  readLastVisitLatch,
  writeLastVisitLatch,
  type VisitBounds,
} from '@/lib/last-visit'
import type { DashboardSinceResponse, UserVisitResponse } from '@/types/dashboard'

export interface LastVisitState {
  /** The entry's window, or null while it is unknown (first visit, failure). */
  bounds: VisitBounds | null
  /** The window's figures, or null when there is nothing to show. */
  figures: DashboardSinceResponse | null
  /** True while the entry is being opened. */
  loading: boolean
}

export function useLastVisit(userId: string | null): LastVisitState {
  const [bounds, setBounds] = useState<VisitBounds | null>(null)
  const [figures, setFigures] = useState<DashboardSinceResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const requestIdRef = useRef(0)

  useEffect(() => {
    if (!userId) {
      setBounds(null)
      setFigures(null)
      setLoading(false)
      return
    }

    const latch = readLastVisitLatch(userId)
    if (latch?.bounds) {
      // This tab already opened its entry: keep the line, make no call.
      setBounds(latch.bounds)
      return
    }

    const entryId = latch?.entryId ?? newVisitEntryId()
    // BEFORE the call — the retry key has to survive a lost response.
    writeLastVisitLatch(userId, { entryId, bounds: null })

    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const visit = await api.post<UserVisitResponse>('/user/visits', { entry_id: entryId })
        if (cancelled) return
        const next: VisitBounds = { previous: visit.previous, current: visit.current }
        writeLastVisitLatch(userId, { entryId, bounds: next })
        setBounds(next)
      } catch {
        // The latch keeps the entry id, so the next mount retries the SAME
        // entry. No line this time — never a guessed window.
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [userId])

  useEffect(() => {
    if (!bounds || bounds.previous === null) {
      setFigures(null)
      return
    }
    const requestId = ++requestIdRef.current
    const params = new URLSearchParams({ after: bounds.previous, through: bounds.current })
    const zone = browserTimeZone()
    if (zone !== undefined) params.set('tz', zone)
    void (async () => {
      try {
        const response = await api.get<DashboardSinceResponse>(`/dashboard/since?${params.toString()}`)
        if (requestIdRef.current === requestId) setFigures(response)
      } catch {
        if (requestIdRef.current === requestId) setFigures(null)
      }
    })()
    return () => {
      requestIdRef.current += 1
    }
  }, [bounds])

  return { bounds, figures, loading }
}
