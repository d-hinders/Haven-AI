'use client'

/**
 * Budget-schedule renewal banner (#770). Shown on the agent detail page when
 * the agent's pre-approved budget window is nearly used up (≤2 periods left):
 * one click, one owner signature, another window — the backend builds the
 * actions, the owner signs via the existing Safe-tx flow, and the window is
 * recorded after the tx lands. Outcome language only ("budget"), never
 * session/permission jargon (#736 formulation bank).
 */

import { useCallback, useEffect, useState } from 'react'
import { usePublicClient } from 'wagmi'
import type { Address } from 'viem'
import { api } from '@/lib/api'
import { buildScheduleTx, type ScheduleInnerTx } from '@/lib/allowance-module'
import { getSafeNonce, signSafeTx, executeSafeTx } from '@/lib/safe-tx'
import { useActiveSigner } from '@/lib/signer'
import { ApprovalRequiredBanner } from './haven/ApprovalRequiredBanner'
import { Button } from './ui/Button'
import { useToast } from './ui/Toast'
import type { SafeDetails } from '@/types/transactions'

interface ScheduleState {
  session_rail: boolean
  enabled: boolean
  periods_remaining?: number
  renewal_due?: boolean
}

interface ScheduleBuild {
  inner_txs: ScheduleInnerTx[]
  from_period: number
  period_count: number
  first_permission_id: string
}

interface Props {
  agentId: string
  safeAddress: string | null
  chainId: number
  safeDetails: SafeDetails | null
}

export default function ScheduleRenewalBanner({ agentId, safeAddress, chainId, safeDetails }: Props) {
  const [schedule, setSchedule] = useState<ScheduleState | null>(null)
  const [renewing, setRenewing] = useState(false)
  const [renewed, setRenewed] = useState(false)
  const publicClient = usePublicClient({ chainId })
  const signer = useActiveSigner({
    safeAddress: safeAddress ? (safeAddress as Address) : undefined,
    chainId,
  })
  const { toast } = useToast()

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const state = await api.get<ScheduleState>(`/agents/${agentId}/schedule`)
        if (!cancelled) setSchedule(state)
      } catch {
        // Fail quiet: no banner beats a broken page — the schedule state is
        // advisory (the payment path enforces the real budget on-chain).
        if (!cancelled) setSchedule(null)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [agentId])

  const handleRenew = useCallback(async () => {
    if (!publicClient || !signer || !safeAddress) return
    if ((safeDetails?.threshold ?? 1) > 1) {
      // Multi-owner Safes go through the propose flow in the edit modal;
      // keep the banner to the single-owner happy path and say so.
      toast.error('Renewal needs your other owners — use Update budget instead.')
      return
    }
    setRenewing(true)
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
        console.error('[Haven] Schedule confirm failed (window not recorded):', confirmErr)
      }
      setRenewed(true)
      toast.success('Agent budget renewed.')
    } catch (err) {
      console.error('[Haven] Schedule renewal error:', err)
      const message = err instanceof Error ? err.message : 'Renewal failed'
      toast.error(message.toLowerCase().includes('rejected') ? 'Signature was cancelled.' : 'Could not renew the budget. Try again.')
    } finally {
      setRenewing(false)
    }
  }, [agentId, chainId, publicClient, safeAddress, safeDetails, signer, toast])

  if (renewed || !schedule?.session_rail || !schedule.enabled || !schedule.renewal_due) return null

  const periods = schedule.periods_remaining ?? 0
  return (
    <div className="mt-4">
      <ApprovalRequiredBanner title="Agent budget running out" tone="warning" density="compact">
        <span>
          {periods <= 1
            ? 'This is the last pre-approved budget period — payments stop when it ends.'
            : `Only ${periods} pre-approved budget periods left.`}{' '}
          Renew now so your agent keeps paying without interruption.
        </span>
        <div className="mt-2">
          <Button size="sm" onClick={handleRenew} disabled={renewing || !signer}>
            {renewing ? 'Renewing…' : 'Renew budget'}
          </Button>
        </div>
      </ApprovalRequiredBanner>
    </div>
  )
}
