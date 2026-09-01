'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '@/lib/api'
import type { ApiSchema } from '@haven_ai/core'
import { usdcSweepStatus } from '@/lib/sweep-eligibility'

/**
 * On-chain USDC + ETH balance of an agent's delegate EOA.
 *
 * #1445: the response is a named OpenAPI component, so this hook uses the
 * generated `DelegateBalance` type rather than restating the wire shape.
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
  const requestGeneration = useRef(0)

  const fetchData = useCallback(async () => {
    if (!agentId) {
      requestGeneration.current += 1
      setBalance(null)
      setLoading(false)
      return
    }

    const generation = ++requestGeneration.current
    // A manual refetch is allowed to overlap the initial request. Clear the
    // old result and accept only the newest response so the CTA cannot drift
    // back to a previous agent or an earlier balance.
    setBalance(null)
    setLoading(true)
    try {
      const next = await api.get<DelegateBalance>(`/agents/${agentId}/delegate-balance`)
      if (generation === requestGeneration.current) setBalance(next)
    } catch {
      // Revoked agents (404) / agents without a delegate (422) / RPC hiccups:
      // treat as "nothing to recover" rather than surfacing an error here.
      if (generation === requestGeneration.current) setBalance(null)
    } finally {
      if (generation === requestGeneration.current) setLoading(false)
    }
  }, [agentId])

  useEffect(() => {
    void fetchData()
    return () => {
      // Ignore a late response from a superseded agentId.
      requestGeneration.current += 1
    }
  }, [fetchData])

  const hasStranded = Boolean(
    balance && (balance.usdc_atomic !== '0' || balance.eth_atomic !== '0'),
  )
  const sweepStatus = balance ? usdcSweepStatus(balance) : 'none'
  // A balance without the bound Safe address is readable for diagnosis, but
  // it is not eligible for a recovery CTA: the sweep destination cannot be
  // verified after an account unlink.
  const hasVerifiedDestination = Boolean(balance?.safe_address)
  const hasRecoverableUsdc = sweepStatus === 'recoverable' && hasVerifiedDestination
  const hasBelowMinimumUsdc = sweepStatus === 'below_minimum' && hasVerifiedDestination

  return { balance, hasStranded, hasRecoverableUsdc, hasBelowMinimumUsdc, loading, refetch: fetchData }
}
