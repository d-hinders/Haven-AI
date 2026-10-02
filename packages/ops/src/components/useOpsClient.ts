'use client'

/**
 * The client-builder hook (#3516). Every page calls this once: it reads the
 * selected origin from the page context and returns an `OpsClient` whose
 * token attach and 401 drop come from `opsFetch` (#3515) — the origin
 * scoping and the credential drop stay in that one wrapper.
 */
import { useMemo } from 'react'
import { createOpsClient, type OpsClient } from '../lib/ops-client'
import { browserStorage } from './browserStorage'
import { useOpsPage } from './OpsPageContext'

export function useOpsClient(): OpsClient {
  const { origin, onUnauthorized } = useOpsPage()
  return useMemo(
    () => createOpsClient(browserStorage(), origin, onUnauthorized),
    [origin, onUnauthorized],
  )
}
