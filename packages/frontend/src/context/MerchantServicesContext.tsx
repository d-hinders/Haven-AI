'use client'

/**
 * The merchant-services setting, read once for the whole authenticated shell
 * (#4904, epic #4885).
 *
 * The issue's acceptance criterion is explicit: "The setting read is the
 * single source for the shell: the Sales entry (#4900), Analytics (#4901) and
 * the key screens (#4905) all use it." So the read lives here, mounted by
 * `AuthenticatedShell` inside `ProtectedRoute`, and every consumer reads the
 * same answer through `useMerchantServicesContext()`.
 *
 * The Settings → Business card is one of those consumers, not the owner: it
 * calls `turnOn`/`turnOff` on this context, so the shell's copy moves with the
 * card's and the Sales entry appears the moment Sales is on.
 *
 * Mounted inside `ProtectedRoute` deliberately — the read is authenticated, and
 * a signed-out shell must not fire it.
 */

import { createContext, useContext, type ReactNode } from 'react'
import { useMerchantServices, type MerchantServices } from '@/hooks/useMerchantServices'

const MerchantServicesContext = createContext<MerchantServices | null>(null)

export function MerchantServicesProvider({ children }: { children: ReactNode }) {
  const value = useMerchantServices()
  return <MerchantServicesContext.Provider value={value}>{children}</MerchantServicesContext.Provider>
}

/**
 * #5000: the same answer, or null outside the provider. For a component that
 * also renders where the shell is absent (a component test, a showcase) and
 * only needs to know whether Sales is on; everything else uses the strict hook.
 */
export function useOptionalMerchantServicesContext(): MerchantServices | null {
  return useContext(MerchantServicesContext)
}

export function useMerchantServicesContext(): MerchantServices {
  const ctx = useContext(MerchantServicesContext)
  if (!ctx) {
    throw new Error(
      'MerchantServicesProvider is missing: the Sales card and the shell read the merchant-services setting through it',
    )
  }
  return ctx
}
