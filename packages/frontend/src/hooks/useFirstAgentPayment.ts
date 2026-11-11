'use client'

/**
 * The first-agent-payment read (#4707).
 *
 * `GET /dashboard/first-agent-payment` names the one payment the card shows.
 * The overview's `hasFirstAgentPayment` only says WHEN TO LOOK — it can be true
 * while the merchant is still unpaid — so this hook is the only thing that can
 * claim success, and it stops the moment a row comes back.
 *
 * The contract, in full:
 *
 * - **Enabled only while the card could show.** `enabled` is the caller's
 *   `hasFirstAgentPayment && !dismissed && setup facts ready`. Disabled means
 *   no request at all.
 * - **60 s cadence through `useVisiblePolling`** (`intervalMs` is its second
 *   argument), so an unsettled payment that later settles still gets its card
 *   without a reload.
 * - **Stops once a row arrives.** `settledRef` short-circuits every later tick,
 *   so the poll costs nothing after the answer is known.
 * - **Loading, an error, a 404 from an older backend and a `null` row all
 *   render nothing.** `payment` stays `null` in every one of those cases; the
 *   caller renders no card, no success copy, no Peak and writes no marker.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { useVisiblePolling } from '@/hooks/useVisiblePolling'
import type { ApiSchema } from '@haven_ai/core'

export type DashboardFirstAgentPaymentResponse = ApiSchema<'DashboardFirstAgentPaymentResponse'>
export type FirstAgentPayment = NonNullable<DashboardFirstAgentPaymentResponse['payment']>

/** The card's poll cadence — slower than the overview's 10 s, because a first
 * payment is a one-off and the read is only live until it answers. */
export const FIRST_AGENT_PAYMENT_POLL_INTERVAL_MS = 60_000

export function useFirstAgentPayment(enabled: boolean) {
  const [payment, setPayment] = useState<FirstAgentPayment | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestIdRef = useRef(0)
  /** Set once a row has come back — no further request is issued. */
  const settledRef = useRef(false)

  const fetchPayment = useCallback(
    async (silent = false) => {
      if (!enabled || settledRef.current) return
      const requestId = ++requestIdRef.current
      try {
        if (!silent) {
          setLoading(true)
          setError(null)
        }
        const response = await api.get<DashboardFirstAgentPaymentResponse>(
          '/dashboard/first-agent-payment',
        )
        if (requestIdRef.current !== requestId) return
        if (response?.payment) {
          settledRef.current = true
          setPayment(response.payment)
        }
        if (silent) setError(null)
      } catch (err) {
        // A 404 from an older backend, a network failure and a 500 are the same
        // answer here: nothing to show. The error is kept for the caller's
        // diagnostics, never rendered as a claim.
        if (requestIdRef.current === requestId && !silent) {
          setError(err instanceof Error ? err.message : 'Failed to load the first agent payment')
        }
      } finally {
        if (requestIdRef.current === requestId) setLoading(false)
      }
    },
    [enabled],
  )

  useEffect(() => {
    if (!enabled) {
      // A dismissal (or a user change) clears the row: the card is gone, and a
      // later re-enable starts from a clean read.
      settledRef.current = false
      setPayment(null)
      setError(null)
      setLoading(false)
      return
    }
    void fetchPayment()
    return () => {
      requestIdRef.current += 1
    }
  }, [enabled, fetchPayment])

  useVisiblePolling(() => {
    void fetchPayment(true)
  }, FIRST_AGENT_PAYMENT_POLL_INTERVAL_MS)

  return { payment, loading, error, refetch: fetchPayment }
}
