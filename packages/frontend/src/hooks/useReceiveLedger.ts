'use client'

/**
 * The receive ledger (#3333): the persisted inbound index for one account —
 * the receiving address, the matched USDC balance, and the inbound rows with
 * their match state (unmatched = unearned).
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '@/lib/api'
import type { ReceiveLedgerResponse } from '@/types/transactions'

interface UseReceiveLedgerReturn {
  ledger: ReceiveLedgerResponse | null
  loading: boolean
  error: string | null
  refetch: () => void
}

interface UseReceiveLedgerOptions {
  enabled?: boolean
}

export function useReceiveLedger(
  accountAddress: string | null,
  chainId: number,
  { enabled = true }: UseReceiveLedgerOptions = {},
): UseReceiveLedgerReturn {
  const [ledger, setLedger] = useState<ReceiveLedgerResponse | null>(null)
  const [loading, setLoading] = useState(Boolean(accountAddress) && enabled)
  const [error, setError] = useState<string | null>(null)
  const generationRef = useRef(0)

  const fetchLedger = useCallback(
    async (silent = false) => {
      const generation = ++generationRef.current

      if (!accountAddress) {
        setLedger(null)
        setError(null)
        setLoading(false)
        return
      }

      if (!enabled) {
        setLoading(false)
        return
      }

      try {
        if (!silent) {
          setLoading(true)
          setError(null)
        }
        const data = await api.get<ReceiveLedgerResponse>(
          `/receive/${accountAddress}?chain_id=${encodeURIComponent(String(chainId))}`,
        )
        if (generationRef.current === generation) {
          setLedger(data)
          setLoading(false)
        }
      } catch (err) {
        if (generationRef.current === generation) {
          // Same discipline as `useBalances` (#2732): a failed tick changes
          // no visible state — the error keeps whatever was last served.
          if (!silent) {
            setError(err instanceof Error ? err.message : 'Could not load the receive ledger')
            setLoading(false)
          }
        }
      }
    },
    [accountAddress, chainId, enabled],
  )

  useEffect(() => {
    void fetchLedger()
  }, [fetchLedger])

  const refetch = useCallback(() => {
    void fetchLedger()
  }, [fetchLedger])

  return { ledger, loading, error, refetch }
}
