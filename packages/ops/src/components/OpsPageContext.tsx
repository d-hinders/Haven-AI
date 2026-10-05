'use client'

/**
 * The selected-origin context (#3516).
 *
 * The shell resolves the selected environment; the pages need its origin and
 * the session's `onUnauthorized` to build their `OpsClient`. A context beats
 * a children-callback here: pages are route files, and a callback prop would
 * thread the shell's signature through every one of them. The provider rides
 * OpsShell, so no page renders outside it and every hook has a value.
 */
import { createContext, useContext } from 'react'

export interface OpsPageContextValue {
  /** The selected backend origin (absolute). */
  origin: string
  /** A 401 from a call to `origin`: drop the token and return to sign-in. */
  onUnauthorized: (origin: string) => void
}

const OpsPageContext = createContext<OpsPageContextValue | null>(null)

export const OpsPageProvider = OpsPageContext.Provider

export function useOpsPage(): OpsPageContextValue {
  const value = useContext(OpsPageContext)
  if (!value) throw new Error('useOpsPage used outside OpsShell (every page renders inside it)')
  return value
}
