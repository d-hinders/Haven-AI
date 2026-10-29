'use client'

/**
 * The OAuth return forwarder (#2868, retargeted #4358): the backend callback
 * still redirects to `/accounting?provider=…&connect=…`
 * (`routes/accounting-connections.ts` builds `${frontendUrl}/accounting?…`),
 * but the connection surface lives on the Business tab of Settings. Forward
 * the outcome query with `tab=business` ADDED — built with
 * `URLSearchParams`, never appended to a constant that already holds
 * `?tab=…` (`/settings?tab=business?provider=…` would parse wrong) — so the
 * Business tab's `ConnectionsCard` reads it: `connected` opens the backfill
 * choice there, `denied`/`error` (and `reason=unsupported_currency`) become
 * its sentence. Rendered inside `Suspense` because `useSearchParams` needs
 * a boundary on a prerendered page.
 */

import { Suspense, useEffect, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { CONNECT_OUTCOME_PARAMS, readConnectOutcome } from '@/components/accounting/ConnectionsCard'
import { ACCOUNTING_SETTINGS_HREF } from '@/components/accounting/FeedSummary'

export function ConnectOutcomeForwarder() {
  const router = useRouter()
  const routerRef = useRef(router)
  routerRef.current = router
  const query = useSearchParams()?.toString() ?? ''
  useEffect(() => {
    const params = new URLSearchParams(query)
    if (!readConnectOutcome(params)) return
    const forwarded = new URLSearchParams()
    for (const key of CONNECT_OUTCOME_PARAMS) {
      const value = params.get(key)
      if (value) forwarded.set(key, value)
    }
    // `tab=business` joins the forwarded keys — Settings reads `tab` too,
    // and the tab-switch write there preserves these parameters until the
    // card has consumed them.
    forwarded.set('tab', 'business')
    routerRef.current.replace(`${ACCOUNTING_SETTINGS_HREF}?${forwarded.toString()}`)
  }, [query])
  return null
}

/** Suspense boundary for the prerendered page (`useSearchParams` rule). */
export function ConnectOutcomeForwarderInSuspense() {
  return (
    <Suspense fallback={null}>
      <ConnectOutcomeForwarder />
    </Suspense>
  )
}
