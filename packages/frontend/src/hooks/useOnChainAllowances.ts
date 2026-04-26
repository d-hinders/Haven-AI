'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { usePublicClient } from 'wagmi'
import { type Address } from 'viem'
import {
  getDelegates,
  getAllAllowances,
  isModuleEnabled,
  type AllowanceInfo,
} from '@/lib/allowance-module'

const POLL_INTERVAL_MS = 30_000 // 30 seconds

export interface OnChainDelegateData {
  /** On-chain allowances for this delegate */
  allowances: AllowanceInfo[]
  /** Whether this delegate exists in the Haven DB */
  isManaged: boolean
}

interface UseOnChainAllowancesResult {
  /** Map of lowercase delegate address → on-chain allowance data */
  data: Map<string, OnChainDelegateData>
  /** True while the first fetch is in progress */
  loading: boolean
  /** Whether the AllowanceModule is enabled on this Safe */
  moduleEnabled: boolean | null
  /** All on-chain delegates (superset of DB agents) */
  onChainDelegates: Address[]
  /** Force a refresh */
  refetch: () => void
}

/**
 * Hook that reads on-chain AllowanceModule data for a Safe, discovering all
 * delegates (not just DB-known agents). Polls every 30s while mounted.
 *
 * @param safeAddress - The Safe address to read from
 * @param managedDelegates - Delegate addresses from Haven DB (to mark isManaged)
 */
export function useOnChainAllowances(
  safeAddress: string | null,
  managedDelegates: string[],
  chainId: number = 100,
): UseOnChainAllowancesResult {
  const publicClient = usePublicClient({ chainId })

  const [data, setData] = useState<Map<string, OnChainDelegateData>>(new Map())
  const [loading, setLoading] = useState(true)
  const [moduleEnabled, setModuleEnabled] = useState<boolean | null>(null)
  const [onChainDelegates, setOnChainDelegates] = useState<Address[]>([])

  // Use ref for managedDelegates to avoid stale closures in polling
  const managedRef = useRef(managedDelegates)
  managedRef.current = managedDelegates

  const fetchData = useCallback(async () => {
    if (!publicClient || !safeAddress) {
      setLoading(false)
      return
    }

    try {
      // 1. Check module enabled
      const enabled = await isModuleEnabled(
        publicClient,
        safeAddress as Address,
      )
      setModuleEnabled(enabled)

      if (!enabled) {
        setData(new Map())
        setOnChainDelegates([])
        setLoading(false)
        return
      }

      // 2. Discover ALL on-chain delegates (not just DB agents)
      const delegates = await getDelegates(
        publicClient,
        safeAddress as Address,
      )
      setOnChainDelegates(delegates)

      // 3. Fetch allowances for each delegate
      const managed = new Set(
        managedRef.current.map((a) => a.toLowerCase()),
      )

      const results = new Map<string, OnChainDelegateData>()
      await Promise.all(
        delegates.map(async (delegate) => {
          try {
            const allowances = await getAllAllowances(
              publicClient,
              safeAddress as Address,
              delegate,
            )
            results.set(delegate.toLowerCase(), {
              allowances,
              isManaged: managed.has(delegate.toLowerCase()),
            })
          } catch {
            // Delegate might have no allowances set yet
            results.set(delegate.toLowerCase(), {
              allowances: [],
              isManaged: managed.has(delegate.toLowerCase()),
            })
          }
        }),
      )

      setData(results)
    } catch (err) {
      console.error('[Haven] Failed to fetch on-chain allowances:', err)
    } finally {
      setLoading(false)
    }
  }, [publicClient, safeAddress])

  // Initial fetch
  useEffect(() => {
    setLoading(true)
    fetchData()
  }, [fetchData])

  // Polling
  useEffect(() => {
    if (!publicClient || !safeAddress) return

    const interval = setInterval(fetchData, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [fetchData, publicClient, safeAddress])

  return {
    data,
    loading,
    moduleEnabled,
    onChainDelegates,
    refetch: fetchData,
  }
}
