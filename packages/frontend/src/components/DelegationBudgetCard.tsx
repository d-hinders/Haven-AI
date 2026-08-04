'use client'

/**
 * Delegation-rail budget management on the agent detail page (#833, epic #821).
 *
 * Renders only for delegation-rail accounts. Grant a budget (one signature),
 * see active budgets, revoke (one signature). Outcome language only — the
 * words "delegation", "caveat", "redemption", "UserOp" never appear in the UI
 * (asserted in the tests); a budget is "a budget that refills itself".
 */

import { useCallback, useMemo, useState } from 'react'
import { isAddress, parseUnits, formatUnits } from 'viem'
import type { Address } from 'viem'
import { useDelegationBudget, type DelegationBudget, type GrantInput } from '@/hooks/useDelegationBudget'
import BudgetGrantAction from './BudgetGrantAction'
import { Card } from './ui/Card'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { Select } from './ui/Select'
import { useToast } from './ui/Toast'
import { truncateAddress } from '@/components/haven'

interface TokenOption {
  address: string
  symbol: string
  decimals: number
}

interface Props {
  agentId: string
  chainId: number
  tokens: TokenOption[]
}

const PERIODS: Array<{ label: string; seconds: number }> = [
  { label: 'per day', seconds: 86_400 },
  { label: 'per week', seconds: 604_800 },
  { label: 'per month', seconds: 2_592_000 },
]

export default function DelegationBudgetCard({ agentId, chainId, tokens }: Props) {
  const { budgets, grant, revoke, busy, ready } = useDelegationBudget(agentId, chainId)
  const { toast } = useToast()

  const [token, setToken] = useState(tokens[0]?.address ?? '')
  const [amount, setAmount] = useState('')
  const [period, setPeriod] = useState(86_400)
  const [recipient, setRecipient] = useState('')

  const tokenCfg = useMemo(
    () => tokens.find((t) => t.address.toLowerCase() === token.toLowerCase()) ?? tokens[0],
    [token, tokens],
  )
  const recipientValid = recipient.trim() === '' || isAddress(recipient.trim())
  const amountValid = amount.trim() !== '' && Number(amount) > 0

  // The grant INPUT is this card's business; performing the grant — and
  // telling a cancelled signature apart from a failed one — belongs to the
  // shared BudgetGrantAction, so the modal and this card behave identically
  // (#1073). Null while the form is incomplete, which disables the control.
  const grantInput = useMemo<GrantInput | null>(() => {
    if (!tokenCfg || !amountValid || !recipientValid) return null
    let budgetAtomic: string
    try {
      budgetAtomic = parseUnits(amount, tokenCfg.decimals).toString()
    } catch {
      return null
    }
    return {
      tokenAddress: tokenCfg.address as Address,
      recipientAddress: recipient.trim() ? (recipient.trim() as Address) : null,
      budgetAtomic,
      periodSeconds: period,
    }
  }, [amount, amountValid, period, recipient, recipientValid, tokenCfg])

  const handleGranted = useCallback(() => {
    setAmount('')
    setRecipient('')
    toast.success('Budget set — it refills itself every period.')
  }, [toast])

  const handleRevoke = useCallback(
    async (hash: string) => {
      const result = await revoke(hash)
      if (result.ok) toast.success('Budget stopped.')
      else if (result.reason === 'cancelled') toast.error('Signature was cancelled.')
      else toast.error('Could not stop the budget. Try again.')
    },
    [revoke, toast],
  )

  if (budgets === null) return null

  const active = budgets.filter((b) => b.status === 'active')

  return (
    <Card hover={false} className="mt-6 p-5 md:p-6">
      <div>
        <h2 className="text-base font-semibold text-[var(--v2-ink)]">Agent budgets</h2>
        <p className="mt-0.5 text-sm text-[var(--v2-ink-muted)]">
          Set how much this agent can spend each period. The budget refills itself — no monthly signing.
        </p>
      </div>

      <Card.Section divided className="mt-4">
        {active.length === 0 ? (
          <p className="py-3 text-sm text-[var(--v2-ink-muted)]">
            No budget yet — set one below and your agent can start paying within it.
          </p>
        ) : (
          active.map((b) => (
            <BudgetRow key={b.delegation_hash} budget={b} tokens={tokens} onRevoke={handleRevoke} busy={busy} ready={ready} />
          ))
        )}
      </Card.Section>

      {tokens.length > 0 ? (
        <div className="mt-4 space-y-2">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="Amount"
              className="sm:w-32"
              aria-label="Budget amount"
            />
            {tokens.length > 1 ? (
              <Select value={token} onChange={(e) => setToken(e.target.value)} aria-label="Token" className="sm:w-28">
                {tokens.map((t) => (
                  <option key={t.address} value={t.address}>{t.symbol}</option>
                ))}
              </Select>
            ) : (
              <span className="self-center text-sm text-[var(--v2-ink-muted)]">{tokenCfg?.symbol}</span>
            )}
            <Select value={String(period)} onChange={(e) => setPeriod(Number(e.target.value))} aria-label="Period" className="sm:w-36">
              {PERIODS.map((p) => (
                <option key={p.seconds} value={p.seconds}>{p.label}</option>
              ))}
            </Select>
          </div>
          <Input
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="Recipient address (optional — leave blank for any)"
            className="font-mono"
            aria-label="Recipient"
          />
          <BudgetGrantAction
            grant={grant}
            busy={busy}
            ready={ready}
            input={grantInput}
            label="Set budget"
            busyLabel="Setting…"
            helper="One signature. Refills every period automatically."
            onGranted={handleGranted}
          />
        </div>
      ) : null}
    </Card>
  )
}

function BudgetRow({
  budget,
  tokens,
  onRevoke,
  busy,
  ready,
}: {
  budget: DelegationBudget
  tokens: TokenOption[]
  onRevoke: (hash: string) => void
  busy: boolean
  ready: boolean
}) {
  const t = tokens.find((x) => x.address.toLowerCase() === budget.token_address.toLowerCase())
  const amount = t ? formatUnits(BigInt(budget.budget_atomic), t.decimals) : budget.budget_atomic
  const periodLabel =
    PERIODS.find((p) => p.seconds === budget.period_seconds)?.label ?? `every ${budget.period_seconds}s`
  return (
    <div className="flex items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-[var(--v2-ink)]">
          {amount} {t?.symbol ?? ''} {periodLabel}
        </p>
        <p className="truncate text-xs text-[var(--v2-ink-muted)]">
          {budget.recipient_address ? `to ${truncateAddress(budget.recipient_address)}` : 'to any recipient'}
        </p>
      </div>
      <Button size="sm" variant="ghost" onClick={() => onRevoke(budget.delegation_hash)} disabled={busy || !ready}>
        Stop
      </Button>
    </div>
  )
}
