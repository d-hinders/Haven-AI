'use client'

/**
 * Issue a sub-budget from the dashboard (#3506): the owner shares a slice of
 * one agent's budget with ANOTHER agent in the same account.
 *
 * Owner JWT only — Haven builds both rows server-side and no on-chain step
 * comes from the owner, so there is no passkey prompt. The result is PENDING
 * until the sharing agent signs both parts; the success state says so and says
 * what to tell that agent. Refusals are mapped to plain words
 * (`subBudgetRefusalCopy`), never surfaced as codes. The period is not an
 * input: the slice inherits the budget's own period.
 */

import { useEffect, useMemo, useState } from 'react'
import { formatUnits, isAddress } from 'viem'
import { useAgents } from '@/hooks/useAgents'
import { issueSubBudget, type IssueSubBudgetResponse } from '@/hooks/useSubBudgets'
import type { DelegationBudget } from '@/hooks/useDelegationBudget'
import {
  amountErrorCopy,
  expiryDateToUnixSeconds,
  parseSubBudgetAmount,
  subBudgetRefusalCopy,
  unixSecondsToDateInput,
} from '@/lib/sub-budget'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { Select } from './ui/Select'
import { InlineAlert } from './ui/InlineAlert'
import { truncateAddress } from '@/components/haven'

interface TokenOption {
  address: string
  symbol: string
  decimals: number
}

interface Props {
  open: boolean
  onClose: () => void
  /** The agent whose budget the slice comes out of. */
  agentId: string
  /** That agent's ACTIVE budget — the ceiling the slice must fit inside. */
  budget: DelegationBudget
  tokens: TokenOption[]
  /** Fires once after a successful issue so the tree can refresh. */
  onIssued?: () => void
}

const PERIOD_LABELS: Record<number, string> = { 86_400: 'per day', 604_800: 'per week', 2_592_000: 'per month' }

export default function IssueSubBudgetModal({ open, onClose, agentId, budget, tokens, onIssued }: Props) {
  const { agents, loading: agentsLoading } = useAgents()
  const delegating = agents.find((a) => a.id === agentId) ?? null
  const delegatingName = delegating?.name ?? 'This agent'

  const token = tokens.find((t) => t.address.toLowerCase() === budget.token_address.toLowerCase())
  const decimals = token?.decimals ?? 6
  const symbol = token?.symbol ?? ''

  // Same account, a different agent, not retired, and able to hold a budget.
  const candidates = useMemo(
    () =>
      agents.filter(
        (a) =>
          a.id !== agentId &&
          a.status !== 'revoked' &&
          a.delegate_address != null &&
          (delegating?.account_id == null || a.account_id == null || a.account_id === delegating.account_id),
      ),
    [agents, agentId, delegating],
  )

  const [subAgentId, setSubAgentId] = useState('')
  const [amount, setAmount] = useState('')
  const [endDate, setEndDate] = useState('')
  const [recipient, setRecipient] = useState('')
  const [label, setLabel] = useState('')
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [result, setResult] = useState<IssueSubBudgetResponse | null>(null)

  // Fresh form on every open: nothing from a previous issue (or its refusal)
  // may survive a close/reopen or a switch of agent.
  useEffect(() => {
    if (!open) return
    setSubAgentId('')
    setAmount('')
    setEndDate('')
    setRecipient(budget.recipient_address ?? '')
    setLabel('')
    setTouched(false)
    setBusy(false)
    setRefusal(null)
    setResult(null)
  }, [open, agentId, budget.delegation_hash, budget.recipient_address])

  const subAgentName = candidates.find((a) => a.id === subAgentId)?.name ?? 'The other agent'
  const nowSec = Math.floor(Date.now() / 1000)
  const parsedAmount = parseSubBudgetAmount(amount, decimals)
  const expiresAt = expiryDateToUnixSeconds(endDate, nowSec, budget.expires_at)
  const recipientOk = recipient.trim() === '' || isAddress(recipient.trim())

  const amountMessage = parsedAmount.ok ? null : amountErrorCopy(parsedAmount.reason, decimals)
  const endMessage = endDate !== '' && expiresAt === null ? 'Choose an end date in the future.' : null
  const recipientMessage = recipientOk ? null : 'Recipient must be a valid wallet address, or blank for any recipient.'
  const complete = subAgentId !== '' && parsedAmount.ok && expiresAt !== null && recipientOk

  const parentAmount = (() => {
    try {
      return formatUnits(BigInt(budget.budget_atomic), decimals)
    } catch {
      return budget.budget_atomic
    }
  })()
  const periodLabel = PERIOD_LABELS[budget.period_seconds] ?? `every ${budget.period_seconds}s`

  async function submit() {
    setTouched(true)
    if (!complete || !parsedAmount.ok || expiresAt === null || busy) return
    setBusy(true)
    setRefusal(null)
    try {
      const res = await issueSubBudget(agentId, {
        sub_agent_id: subAgentId,
        token_address: budget.token_address,
        period_amount_atomic: parsedAmount.atomic,
        expires_at: expiresAt,
        ...(recipient.trim() ? { recipient_address: recipient.trim() } : {}),
        ...(label.trim() ? { label: label.trim() } : {}),
      })
      setResult(res)
      onIssued?.()
    } catch (err) {
      const e = err as { status?: number; body?: unknown }
      setRefusal(subBudgetRefusalCopy(e, delegatingName, subAgentName))
    } finally {
      setBusy(false)
    }
  }

  const footer = result ? (
    <Button onClick={onClose} className="w-full">
      Done
    </Button>
  ) : (
    <div className="flex gap-3">
      <Button variant="ghost" onClick={onClose} className="flex-1" disabled={busy}>
        Cancel
      </Button>
      <Button onClick={() => void submit()} className="flex-1" disabled={busy}>
        {busy ? 'Issuing…' : 'Issue sub-budget'}
      </Button>
    </div>
  )

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title="Issue sub-budget"
      subtitle={`Share part of ${delegatingName}'s budget with another agent. No signature needed from you.`}
      footer={footer}
      showCloseButton
      closeButtonDisabled={busy}
      panelTestId="issue-sub-budget-modal"
    >
      {result ? (
        <div className="space-y-3" data-testid="sub-budget-pending">
          <p className="text-sm font-medium text-[var(--v2-ink)]">Sub-budget created — waiting for {delegatingName}</p>
          <p className="text-sm text-[var(--v2-ink-2)]">
            It stays pending until {delegatingName} signs both parts. It can&rsquo;t be spent from yet, and nothing
            has moved.
          </p>
          <p className="text-sm text-[var(--v2-ink-2)]">
            Ask {delegatingName} to finish setting it up — it signs the sub-budget the next time it checks its
            pending signatures (<code className="font-mono text-xs">haven_get_agent</code>). It then shows as
            active here.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          <p className="text-sm text-[var(--v2-ink-2)]" data-testid="sub-budget-ceiling">
            {delegatingName}&rsquo;s budget is {parentAmount} {symbol} {periodLabel}, until{' '}
            {unixSecondsToDateInput(budget.expires_at)}. A sub-budget can be this size or smaller, ends no later,
            and refills on the same schedule.
          </p>

          <div className="space-y-1.5">
            <label htmlFor="sub-budget-agent" className="text-sm font-medium text-[var(--v2-ink)]">
              Share with
            </label>
            <Select
              id="sub-budget-agent"
              value={subAgentId}
              onChange={(e) => setSubAgentId(e.target.value)}
              disabled={busy || candidates.length === 0}
              aria-label="Agent to share with"
            >
              <option value="">{agentsLoading ? 'Loading agents…' : 'Choose an agent'}</option>
              {candidates.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
            {!agentsLoading && candidates.length === 0 ? (
              <p className="text-xs text-[var(--v2-ink-3)]">
                Connect another agent to this account first — a sub-budget goes to a different agent.
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <label htmlFor="sub-budget-amount" className="text-sm font-medium text-[var(--v2-ink)]">
              Amount {periodLabel}
            </label>
            <Input
              id="sub-budget-amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder={`Amount in ${symbol}`.trim()}
              invalid={touched && amountMessage !== null}
              disabled={busy}
              aria-label="Sub-budget amount"
            />
            {amountMessage && (touched || amount !== '') ? <InlineAlert>{amountMessage}</InlineAlert> : null}
          </div>

          <div className="space-y-1.5">
            <label htmlFor="sub-budget-end" className="text-sm font-medium text-[var(--v2-ink)]">
              Ends on
            </label>
            <Input
              id="sub-budget-end"
              type="date"
              value={endDate}
              min={unixSecondsToDateInput(nowSec + 86_400)}
              max={unixSecondsToDateInput(budget.expires_at)}
              onChange={(e) => setEndDate(e.target.value)}
              invalid={touched && (endDate === '' || endMessage !== null)}
              disabled={busy}
              aria-label="Ends on"
            />
            {touched && endDate === '' ? <InlineAlert>Choose when this sub-budget ends.</InlineAlert> : null}
            {endMessage ? <InlineAlert>{endMessage}</InlineAlert> : null}
          </div>

          <Input
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="Recipient address"
            helperText={
              budget.recipient_address
                ? `${delegatingName}'s budget pays ${truncateAddress(budget.recipient_address)} only, so this one does too.`
                : 'Optional — leave blank for any recipient.'
            }
            className="font-mono"
            invalid={!recipientOk}
            disabled={busy || !!budget.recipient_address}
            aria-label="Recipient"
          />
          {recipientMessage ? <InlineAlert>{recipientMessage}</InlineAlert> : null}

          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label (optional)"
            maxLength={80}
            disabled={busy}
            aria-label="Label"
          />

          {touched && subAgentId === '' ? <InlineAlert>Choose which agent to share with.</InlineAlert> : null}
          {refusal ? <InlineAlert>{refusal}</InlineAlert> : null}
        </div>
      )}
    </Modal>
  )
}
