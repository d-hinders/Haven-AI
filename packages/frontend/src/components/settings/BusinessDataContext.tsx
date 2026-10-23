'use client'

/**
 * The Business tab's ONE data source (#4359, partner review).
 *
 * `useCompanyDetails` (which owns the VIES polling), `useAccountingProviders`
 * and `useAccountingFeed` are the three reads BOTH Business cards make AND
 * the tab-visibility rule (`SettingsClient`) needs. They are called ONCE,
 * here, and shared by context — a second call anywhere would fetch (and, for
 * VIES, poll) twice. `SettingsClient` mounts the provider around the whole
 * page: the visibility of the Business tab itself depends on these reads, so
 * they run even while General or Security is showing.
 *
 * `useAccountingConnections` deliberately STAYS inside `ConnectionsCard`:
 * the connection rows are not part of the visibility rule (a live,
 * configured provider shows a row whether or not a connection record
 * exists) and the card owns its own refetch lifecycle (#2903).
 */

import { createContext, useContext, type ReactNode } from 'react'
import { useAccountingProviders } from '@/hooks/useAccounting'
import { useAccountingFeed } from '@/hooks/useAccountingFeed'
import { useCompanyDetails } from '@/hooks/useCompanyDetails'

export interface BusinessData {
  company: ReturnType<typeof useCompanyDetails>
  providers: ReturnType<typeof useAccountingProviders>
  feed: ReturnType<typeof useAccountingFeed>
}

const BusinessDataContext = createContext<BusinessData | null>(null)

export function BusinessDataProvider({ children }: { children: ReactNode }) {
  const company = useCompanyDetails()
  const providers = useAccountingProviders()
  const feed = useAccountingFeed()
  return <BusinessDataContext.Provider value={{ company, providers, feed }}>{children}</BusinessDataContext.Provider>
}

export function useBusinessData(): BusinessData {
  const ctx = useContext(BusinessDataContext)
  if (!ctx) {
    throw new Error('BusinessDataProvider is missing: CompanyDetailsCard and ConnectionsCard read their shared data through it')
  }
  return ctx
}
