'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'

/** On-chain USDC + ETH balance of an agent's delegate EOA. */
export interface DelegateBalance {
  delegate_address: string
  safe_address: string | null
  chain_id: number
  eth: string
  eth_atomic: string
  usdc: string
  usdc_atomic: string
  usdc_address: string | null
}

export interface UseDelegateBalanceResult {
  balance: DelegateBalance | null
  /** True when the delegate EOA holds any funds (USDC or ETH) right now. */
  hasStranded: boolean
  /**
   * True only when the delegate holds USDC. The gasless `haven_sweep_delegate`
   * recovery path is USDC-only, so recovery CTAs that point at it must gate on
   * this — not `hasStranded` — or an ETH-only delegate gets a CTA that recovers
   * nothing.
   */
  hasRecoverableUsdc: boolean
  loading: boolean
  refetch: () => Promise<void>
}

/**
 * Read the live on-chain balance of an agent's delegate wallet.
 *
 * The delegate only ever holds funds transiently during the x402 hot-wallet leg;
 * a non-zero balance here means funds stranded (merchant rejected/expired) and
 * are recoverable. Gating recovery UI on this — rather than on a funded-but-
 * unsettled payment record — means the prompt shows iff there is something to
 * actually recover. Pass `null` to skip the fetch (e.g. revoked agents).
 */
export function useDelegateBalance(agentId: string | null): UseDelegateBalanceResult {
  const [balance, setBalance] = useState<DelegateBalance | null>(null)
  const [loading, setLoading] = useState(false)

  const fetchData = useCallback(async () => {
    if (!agentId) return
    setLoading(true)
    try {
      setBalance(await api.get<DelegateBalance>(`/agents/${agentId}/delegate-balance`))
    } catch {
      // Revoked agents (404) / agents without a delegate (422) / RPC hiccups:
      // treat as "nothing to recover" rather than surfacing an error here.
      setBalance(null)
    } finally {
      setLoading(false)
    }
  }, [agentId])

  useEffect(() => {
    if (!agentId) {
      setBalance(null)
      return
    }
    // Clear immediately so a stale balance from the previous agent can't briefly
    // render the wrong recover amount/link during client-side navigation.
    setBalance(null)
    setLoading(true)
    let ignore = false
    api
      .get<DelegateBalance>(`/agents/${agentId}/delegate-balance`)
      .then((data) => {
        if (!ignore) setBalance(data)
      })
      .catch(() => {
        if (!ignore) setBalance(null)
      })
      .finally(() => {
        if (!ignore) setLoading(false)
      })
    return () => {
      // Ignore a late response from a superseded agentId.
      ignore = true
    }
  }, [agentId])

  const hasStranded = Boolean(
    balance && (balance.usdc_atomic !== '0' || balance.eth_atomic !== '0'),
  )
  const hasRecoverableUsdc = Boolean(balance && balance.usdc_atomic !== '0')

  return { balance, hasStranded, hasRecoverableUsdc, loading, refetch: fetchData }
}
