'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { ApiSchema } from '@haven_ai/core'
import { usdcSweepStatus } from '@/lib/sweep-eligibility'

/**
 * On-chain USDC + ETH balance of an agent's delegate EOA.
 *
 * #1445: the spec described this response inline, which generates an anonymous
 * type — so the frontend hand-wrote a matching copy. The schema is named
 * (`DelegateBalance`) now, and this is the generated type.
 */
export type DelegateBalance = ApiSchema<'DelegateBalance'>

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
  /** True when USDC exists but is below the backend's recovery minimum. */
  hasBelowMinimumUsdc: boolean
  loading: boolean
  refetch: () => Promise<void>
}

/**
 * Read the live on-chain balance of an agent's delegate wallet.
 *
 * The delegate only ever holds funds transiently during the x402 hot-wallet leg;
 * a non-zero balance here means funds stranded (merchant rejected/expired).
 * Recovery UI additionally checks the backend-configured minimum, because a
 * dust balance cannot be swept by the gasless recovery path. Pass `null` while
 * the agent record is unresolved.
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
  const sweepStatus = balance ? usdcSweepStatus(balance) : 'none'
  const hasRecoverableUsdc = sweepStatus === 'recoverable'
  const hasBelowMinimumUsdc = sweepStatus === 'below_minimum'

  return { balance, hasStranded, hasRecoverableUsdc, hasBelowMinimumUsdc, loading, refetch: fetchData }
}
