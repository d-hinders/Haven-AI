'use client'

/**
 * Apply the agent's budget schedule on-chain with ONE owner signature (#770,
 * #796): build the replacement actions, sign, execute, record the window.
 * Shared by the renewal banner and the recipients card — any policy change
 * (renewal, recipient add/remove) applies through the same single-signature
 * flow. Multi-owner Safes are guarded to the propose path before signing.
 */

import { useCallback, useState } from 'react'
import { usePublicClient } from 'wagmi'
import type { Address } from 'viem'
import { api } from '@/lib/api'
import { buildScheduleTx, type ScheduleInnerTx } from '@/lib/allowance-module'
import { getSafeNonce, signSafeTx, executeSafeTx } from '@/lib/safe-tx'
import { useActiveSigner } from '@/lib/signer'
import type { SafeDetails } from '@/types/transactions'

interface ScheduleBuild {
  inner_txs: ScheduleInnerTx[]
  from_period: number
  period_count: number
  first_permission_id: string
}

export interface UseApplyScheduleArgs {
  agentId: string
  safeAddress: string | null
  chainId: number
  safeDetails: SafeDetails | null
}

export type ApplyScheduleResult =
  | { ok: true }
  | { ok: false; reason: 'multisig' | 'cancelled' | 'failed' }

export function useApplySchedule({ agentId, safeAddress, chainId, safeDetails }: UseApplyScheduleArgs) {
  const [applying, setApplying] = useState(false)
  const publicClient = usePublicClient({ chainId })
  const signer = useActiveSigner({
    safeAddress: safeAddress ? (safeAddress as Address) : undefined,
    chainId,
  })

  const apply = useCallback(async (): Promise<ApplyScheduleResult> => {
    if (!publicClient || !signer || !safeAddress) return { ok: false, reason: 'failed' }
    if ((safeDetails?.threshold ?? 1) > 1) return { ok: false, reason: 'multisig' }
    setApplying(true)
    try {
      const build = await api.post<ScheduleBuild>(`/agents/${agentId}/schedule/build`, {})
      const nonce = await getSafeNonce(publicClient, safeAddress as Address)
      const safeTx = buildScheduleTx(build.inner_txs, nonce)
      const signature = await signSafeTx(signer, safeAddress as Address, safeTx, chainId)
      await executeSafeTx(signer, publicClient, safeAddress as Address, safeTx, signature, chainId)
      try {
        await api.post(`/agents/${agentId}/schedule/confirm`, {
          from_period: build.from_period,
          period_count: build.period_count,
          first_permission_id: build.first_permission_id,
        })
      } catch (confirmErr) {
        // The window just isn't recorded — the payment path is fail-closed
        // either way (#769 verifies enablement on-chain before any flip).
        console.error('[Haven] Schedule confirm failed (window not recorded):', confirmErr)
      }
      return { ok: true }
    } catch (err) {
      console.error('[Haven] Schedule apply error:', err)
      const message = err instanceof Error ? err.message.toLowerCase() : ''
      return {
        ok: false,
        reason: message.includes('rejected') || message.includes('denied') ? 'cancelled' : 'failed',
      }
    } finally {
      setApplying(false)
    }
  }, [agentId, chainId, publicClient, safeAddress, safeDetails, signer])

  return { apply, applying, ready: Boolean(publicClient && signer && safeAddress) }
}
