'use client'

/**
 * Budget-schedule renewal banner (#770). Shown on the agent detail page when
 * the agent's pre-approved budget window is nearly used up (≤2 periods left):
 * one click, one owner signature, another window — via the shared
 * useApplySchedule flow. Outcome language only ("budget"), never
 * session/permission jargon (#736 formulation bank).
 */

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useApplySchedule } from '@/hooks/useApplySchedule'
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

interface Props {
  agentId: string
  safeAddress: string | null
  chainId: number
  safeDetails: SafeDetails | null
}

export default function ScheduleRenewalBanner({ agentId, safeAddress, chainId, safeDetails }: Props) {
  const [schedule, setSchedule] = useState<ScheduleState | null>(null)
  const [renewed, setRenewed] = useState(false)
  const { apply, applying, awaitingCoOwners, ready } = useApplySchedule({ agentId, safeAddress, chainId, safeDetails })
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
    const result = await apply()
    if (result.ok && 'proposed' in result) {
      // Multi-sig (#800): signed and proposed; recording happens automatically
      // once the co-owners execute (the backend verifies on-chain).
      toast.info('Renewal signed — waiting for your co-owners to approve.')
    } else if (result.ok) {
      setRenewed(true)
      toast.success('Agent budget renewed.')
    } else if (result.reason === 'cancelled') {
      toast.error('Signature was cancelled.')
    } else {
      toast.error('Could not renew the budget. Try again.')
    }
  }, [apply, toast])

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
          {awaitingCoOwners ? (
            <span className="text-xs font-medium">Signed — waiting for your co-owners to approve.</span>
          ) : (
            <Button size="sm" onClick={handleRenew} disabled={applying || !ready}>
              {applying ? 'Renewing…' : 'Renew budget'}
            </Button>
          )}
        </div>
      </ApprovalRequiredBanner>
    </div>
  )
}
