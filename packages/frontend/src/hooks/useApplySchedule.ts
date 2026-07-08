'use client'

/**
 * Apply the agent's budget schedule on-chain with ONE owner signature (#770,
 * #796): build the replacement actions, sign, execute, record the window.
 * Shared by the renewal banner and the recipients card.
 *
 * Multi-owner Safes (#800): the tx is PROPOSED to the Safe transaction
 * service (the same pattern as the edit modal) and the confirm parameters are
 * parked in localStorage. On the next visit the hook retries the confirm —
 * and the #801 endpoint is the arbiter: it 409s until the chain says the
 * schedule is actually enabled (i.e. the co-owners executed), then records.
 * No frontend guesswork about execution state; a stale pending entry can
 * never record a window the chain does not have.
 */

import { useCallback, useEffect, useState } from 'react'
import { usePublicClient } from 'wagmi'
import type { Address } from 'viem'
import { api } from '@/lib/api'
import { buildScheduleTx, type ScheduleInnerTx } from '@/lib/allowance-module'
import {
  getSafeNonce,
  signSafeTx,
  executeSafeTx,
  proposeSafeTx,
  getSafeTxHash,
} from '@/lib/safe-tx'
import { useActiveSigner } from '@/lib/signer'
import type { SafeDetails } from '@/types/transactions'

interface ScheduleBuild {
  inner_txs: ScheduleInnerTx[]
  from_period: number
  period_count: number
  first_permission_id: string
}

interface PendingConfirm {
  from_period: number
  period_count: number
  first_permission_id: string
}

function pendingKey(agentId: string): string {
  return `haven:schedule-pending-confirm:${agentId}`
}

function readPending(agentId: string): PendingConfirm | null {
  try {
    const raw = window.localStorage.getItem(pendingKey(agentId))
    return raw ? (JSON.parse(raw) as PendingConfirm) : null
  } catch {
    return null
  }
}

function writePending(agentId: string, value: PendingConfirm | null): void {
  try {
    if (value === null) window.localStorage.removeItem(pendingKey(agentId))
    else window.localStorage.setItem(pendingKey(agentId), JSON.stringify(value))
  } catch {
    // localStorage unavailable — the retry just won't persist; harmless.
  }
}

export interface UseApplyScheduleArgs {
  agentId: string
  safeAddress: string | null
  chainId: number
  safeDetails: SafeDetails | null
}

export type ApplyScheduleResult =
  | { ok: true }
  | { ok: true; proposed: true }
  | { ok: false; reason: 'cancelled' | 'failed' }

export function useApplySchedule({ agentId, safeAddress, chainId, safeDetails }: UseApplyScheduleArgs) {
  const [applying, setApplying] = useState(false)
  /** True when a proposed multi-sig apply awaits co-owner execution (#800). */
  const [awaitingCoOwners, setAwaitingCoOwners] = useState(false)
  const publicClient = usePublicClient({ chainId })
  const signer = useActiveSigner({
    safeAddress: safeAddress ? (safeAddress as Address) : undefined,
    chainId,
  })

  const tryConfirm = useCallback(
    async (pending: PendingConfirm): Promise<boolean> => {
      try {
        await api.post(`/agents/${agentId}/schedule/confirm`, pending)
        return true
      } catch {
        // 409 = chain has not seen the execution yet (#801) — keep waiting.
        return false
      }
    },
    [agentId],
  )

  // #800 retry: a parked multi-sig confirm is retried on mount. The #801
  // endpoint verifies enablement on-chain, so retrying is always safe.
  useEffect(() => {
    const pending = readPending(agentId)
    if (!pending) return
    setAwaitingCoOwners(true)
    let cancelled = false
    void (async () => {
      const recorded = await tryConfirm(pending)
      if (cancelled) return
      if (recorded) {
        writePending(agentId, null)
        setAwaitingCoOwners(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [agentId, tryConfirm])

  const apply = useCallback(async (): Promise<ApplyScheduleResult> => {
    if (!publicClient || !signer || !safeAddress) return { ok: false, reason: 'failed' }
    setApplying(true)
    try {
      const build = await api.post<ScheduleBuild>(`/agents/${agentId}/schedule/build`, {})
      const nonce = await getSafeNonce(publicClient, safeAddress as Address)
      const safeTx = buildScheduleTx(build.inner_txs, nonce)
      const signature = await signSafeTx(signer, safeAddress as Address, safeTx, chainId)

      const pending: PendingConfirm = {
        from_period: build.from_period,
        period_count: build.period_count,
        first_permission_id: build.first_permission_id,
      }

      if ((safeDetails?.threshold ?? 1) > 1) {
        // Multi-sig (#800): propose, park the confirm, let #801 arbitrate later.
        const safeTxHash = getSafeTxHash(safeAddress as Address, safeTx, chainId)
        await proposeSafeTx(
          safeAddress as Address,
          safeTx,
          safeTxHash,
          signature,
          signer.address,
          chainId,
        )
        writePending(agentId, pending)
        setAwaitingCoOwners(true)
        return { ok: true, proposed: true }
      }

      await executeSafeTx(signer, publicClient, safeAddress as Address, safeTx, signature, chainId)
      const recorded = await tryConfirm(pending)
      if (!recorded) {
        // Executed but not yet visible to the backend's on-chain check —
        // park it; the mount retry picks it up (#801 arbitrates).
        writePending(agentId, pending)
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
  }, [agentId, chainId, publicClient, safeAddress, safeDetails, signer, tryConfirm])

  return {
    apply,
    applying,
    awaitingCoOwners,
    ready: Boolean(publicClient && signer && safeAddress),
  }
}
