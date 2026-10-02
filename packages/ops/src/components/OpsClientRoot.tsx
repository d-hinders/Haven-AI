'use client'

/**
 * The client root (#3515). Provides the server-resolved environment registry
 * and the session (token store + fragment consumption) to the whole tree.
 *
 * `useOpsSession` runs BEFORE the children render their authenticated
 * content: this component renders nothing until the hook has consumed (and
 * scrubbed) the URL fragment, so a reload can never replay a token and no
 * signed-in view paints from a stale URL.
 *
 * Data calls go through `opsFetch` (lib/api.ts) with the ABSOLUTE url built
 * from the selected backend origin — the origin-scoping rule lives there and
 * nowhere else.
 */
import { createContext, useContext, type ReactNode } from 'react'
import { useOpsSession, type OpsSession } from '../lib/ops-session'
import type { OpsEnvironment } from '../lib/environments'

const RegistryContext = createContext<OpsEnvironment[] | null>(null)
const SessionContext = createContext<OpsSession | null>(null)

/**
 * A Storage stand-in for the server render pass. Client components render on
 * the server too — this app has no dynamic APIs, so `/` is prerendered — and
 * `window` does not exist there. The storage is consumed only in effects and
 * event handlers, which never run in that pass and cannot fire before the
 * client mount, so the hook receives a valid Storage on every render while
 * the real one is only ever read in the browser.
 */
const INERT_STORAGE: Storage = {
  get length() {
    return 0
  },
  key: () => null,
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
  clear: () => undefined,
}

export interface OpsClientRootProps {
  registry: OpsEnvironment[]
  children: ReactNode
}

export function OpsClientRoot({ registry, children }: OpsClientRootProps) {
  const storage = typeof window === 'undefined' ? INERT_STORAGE : window.sessionStorage
  const session = useOpsSession(storage)
  return (
    <RegistryContext.Provider value={registry}>
      <SessionContext.Provider value={session}>
        {!session.settled ? null : children}
      </SessionContext.Provider>
    </RegistryContext.Provider>
  )
}

/** The environments this deployment offers (already preview-filtered). */
export function useOpsRegistry(): OpsEnvironment[] {
  const registry = useContext(RegistryContext)
  if (!registry) throw new Error('useOpsRegistry used outside OpsClientRoot')
  return registry
}

/** The session: sign-in state, token reads, sign-out. */
export function useOpsSessionContext(): OpsSession {
  const session = useContext(SessionContext)
  if (!session) throw new Error('useOpsSessionContext used outside OpsClientRoot')
  return session
}
