'use client'

/**
 * Agent recipients (#796, the #784 follow-up): who this agent may pay on the
 * session rail. Rows are bookkeeping until the owner signs — adding or
 * removing a recipient surfaces a "sign to apply" step that replaces the
 * budget schedule in ONE signature (the shared useApplySchedule flow). On a
 * legacy account the card explains that the wallet budget applies to any
 * recipient. Outcome language only — never session/permission jargon.
 */

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { isAddress } from 'viem'
import { useApplySchedule } from '@/hooks/useApplySchedule'
import { Card } from './ui/Card'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { useToast } from './ui/Toast'
import type { SafeDetails } from '@/types/transactions'

interface RecipientRow {
  recipient_address: string
  token_address: string
  label: string | null
  effective_budget: string
  inherits_allowance: boolean
}

interface Props {
  agentId: string
  safeAddress: string | null
  chainId: number
  safeDetails: SafeDetails | null
  /** The agent's configured tokens (from its allowances) — new rows use the first. */
  tokenAddress: string | null
  tokenSymbol: string | null
  tokenDecimals: number
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

function formatBudget(atomic: string, decimals: number): string {
  try {
    const v = BigInt(atomic)
    const base = 10n ** BigInt(decimals)
    const whole = v / base
    const frac = ((v % base) * 100n) / base
    return frac === 0n ? whole.toString() : `${whole}.${frac.toString().padStart(2, '0')}`
  } catch {
    return '0'
  }
}

export default function AgentRecipientsCard({
  agentId,
  safeAddress,
  chainId,
  safeDetails,
  tokenAddress,
  tokenSymbol,
  tokenDecimals,
}: Props) {
  const [recipients, setRecipients] = useState<RecipientRow[] | null>(null)
  const [sessionRail, setSessionRail] = useState(false)
  const [scheduleEnabled, setScheduleEnabled] = useState(false)
  const [pendingApply, setPendingApply] = useState(false)
  const [address, setAddress] = useState('')
  const [label, setLabel] = useState('')
  const [saving, setSaving] = useState(false)
  const { apply, applying, ready } = useApplySchedule({ agentId, safeAddress, chainId, safeDetails })
  const { toast } = useToast()

  const reload = useCallback(async () => {
    try {
      const [list, schedule] = await Promise.all([
        api.get<{ recipients: RecipientRow[] }>(`/agents/${agentId}/recipients`),
        api.get<{ session_rail: boolean; enabled: boolean }>(`/agents/${agentId}/schedule`),
      ])
      setRecipients(list.recipients)
      setSessionRail(schedule.session_rail)
      setScheduleEnabled(schedule.enabled)
    } catch {
      setRecipients(null)
    }
  }, [agentId])

  useEffect(() => {
    void reload()
  }, [reload])

  const handleAdd = useCallback(async () => {
    if (!tokenAddress || !isAddress(address)) return
    setSaving(true)
    try {
      await api.post(`/agents/${agentId}/recipients`, {
        recipient_address: address,
        token_address: tokenAddress,
        label: label.trim() || null,
      })
      setAddress('')
      setLabel('')
      setPendingApply(true)
      await reload()
    } catch (err) {
      console.error('[Haven] Add recipient failed:', err)
      toast.error('Could not save the recipient. Try again.')
    } finally {
      setSaving(false)
    }
  }, [address, agentId, label, reload, toast, tokenAddress])

  const handleRemove = useCallback(
    async (row: RecipientRow) => {
      try {
        await api.delete(
          `/agents/${agentId}/recipients/${row.recipient_address}?token_address=${encodeURIComponent(row.token_address)}`,
        )
        setPendingApply(true)
        await reload()
      } catch (err) {
        console.error('[Haven] Remove recipient failed:', err)
        toast.error('Could not remove the recipient. Try again.')
      }
    },
    [agentId, reload, toast],
  )

  const handleApply = useCallback(async () => {
    const result = await apply()
    if (result.ok) {
      setPendingApply(false)
      toast.success('Recipient changes applied.')
    } else if (result.reason === 'multisig') {
      toast.error('Applying needs your other owners — use Update budget instead.')
    } else if (result.reason === 'cancelled') {
      toast.error('Signature was cancelled.')
    } else {
      toast.error('Could not apply the changes. Try again.')
    }
  }, [apply, toast])

  // The card only renders where it means something: recipients are enforced
  // on the session rail. Legacy accounts keep the plain wallet budget.
  if (!sessionRail || recipients === null) return null

  return (
    <Card hover={false} className="mt-6 p-5 md:p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-[var(--v2-ink)]">Recipients</h2>
          <p className="mt-0.5 text-sm text-[var(--v2-ink-muted)]">
            Who this agent can pay. Each recipient spends within the agent budget.
          </p>
        </div>
        {pendingApply && scheduleEnabled ? (
          <Button size="sm" onClick={handleApply} disabled={applying || !ready}>
            {applying ? 'Applying…' : 'Sign to apply'}
          </Button>
        ) : null}
      </div>

      {pendingApply && scheduleEnabled ? (
        <p className="mt-2 text-xs text-[var(--v2-warning)]">
          Changes are saved but not active yet — sign once to apply them to your agent&apos;s budget.
        </p>
      ) : null}

      <Card.Section divided className="mt-4">
        {recipients.length === 0 ? (
          <p className="py-3 text-sm text-[var(--v2-ink-muted)]">
            No recipients yet — add the first address your agent should be able to pay.
          </p>
        ) : (
          recipients.map((row) => (
            <div
              key={`${row.token_address}:${row.recipient_address}`}
              className="flex items-center justify-between gap-3 py-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-[var(--v2-ink)]">
                  {row.label || shortAddress(row.recipient_address)}
                </p>
                <p className="truncate font-mono text-xs text-[var(--v2-ink-muted)]">
                  {row.recipient_address}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="text-xs text-[var(--v2-ink-muted)]">
                  {formatBudget(row.effective_budget, tokenDecimals)} {tokenSymbol ?? ''}
                  {row.inherits_allowance ? ' (full budget)' : ''}
                </span>
                <Button size="sm" variant="ghost" onClick={() => handleRemove(row)}>
                  Remove
                </Button>
              </div>
            </div>
          ))
        )}
      </Card.Section>

      {tokenAddress ? (
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <Input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="Recipient address (0x…)"
            className="flex-1 font-mono"
            aria-label="Recipient address"
          />
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Name (optional)"
            className="sm:w-44"
            aria-label="Recipient name"
          />
          <Button onClick={handleAdd} disabled={saving || !isAddress(address)}>
            {saving ? 'Saving…' : 'Add'}
          </Button>
        </div>
      ) : null}
    </Card>
  )
}
