'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import {
  SUPPORTED_CHAINS,
  SUPPORTED_CHAIN_IDS,
  type FrontendChainConfig,
} from '@/lib/chains'

/**
 * The chains the connected backend actually serves account **deploys** on (#679).
 *
 * Onboarding and the Add-account modal use this so a user can't pick a chain the
 * environment can't deploy on — e.g. Base mainnet on the testnet-only dev backend,
 * which would otherwise fail mid-deploy with a misleading "relayer unfunded". The
 * backend is the source of truth (`GET /chains`); the frontend intersects it with
 * the chains it knows about. Falls back to every supported chain if the backend
 * predates the endpoint, so onboarding never bricks.
 */
export function useDeployableChains(): { chains: FrontendChainConfig[]; loading: boolean } {
  const [served, setServed] = useState<number[] | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    api
      .get<{ deployable: number[] }>('/chains')
      .then((res) => {
        if (!cancelled) setServed(Array.isArray(res.deployable) ? res.deployable : null)
      })
      .catch(() => {
        if (!cancelled) setServed(null) // old backend / unreachable → fall back
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const allowed = served ?? SUPPORTED_CHAIN_IDS
  const chains = SUPPORTED_CHAINS.filter((c) => allowed.includes(c.chainId))
  // Never hand back an empty list — a misconfigured backend shouldn't brick the
  // picker; degrade to all supported instead.
  return { chains: chains.length > 0 ? chains : SUPPORTED_CHAINS, loading }
}
