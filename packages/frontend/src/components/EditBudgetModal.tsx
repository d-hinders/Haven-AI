'use client'

/**
 * Edit one active budget's limits in place (#3166) — REPLACE composition.
 *
 * Prefills the current limits, the owner reviews the change as a
 * current-vs-new diff, then the shared composition runs: build a new
 * delegation (existing POST /delegations/build), the OWNER signs it (same
 * ceremony as the first grant), activation replaces the grant in the same
 * (token, recipient) slot, and one more OWNER signature revokes the old
 * delegation on-chain. The delegate key and local signer are never touched —
 * no reconnection, no new credentials handoff.
 *
 * Ordering is activate-then-revoke, deliberately: Haven cannot revoke by
 * itself (the revoke UserOp needs an owner signature), and revoking first
 * would leave the agent with no budget if the new grant were abandoned. While
 * the flow runs, the old budget keeps working; limits change only after the
 * owner signs. Between the two signatures both delegations briefly exist
 * on-chain — the combined exposure is the sum of the two, and every payment
 * stays bounded by each one's own on-chain caveats. That window is stated in
 * the review copy.
 *
 * UI language follows the budget-review recipe (screen-recipes.md): "Review
 * changes" header, a summary answering who can spend, how much, how often,
 * from which Haven wallet, and the over-budget behaviour (refused on-chain).
 * Outcome language only — "delegation" never appears.
 */

import { Check, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isAddress, parseUnits, formatUnits } from 'viem'
import type { Address } from 'viem'
import {
  useDelegationBudget,
  type DelegationBudget,
  type EditBudgetResult,
  type GrantInput,
} from '@/hooks/useDelegationBudget'
import { Icon } from './ui/Icon'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { Select } from './ui/Select'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { useEscapeToClose } from '@/hooks/useEscapeToClose'

interface TokenOption {
  address: string
  symbol: string
  decimals: number
}

/** The PREPARE phases; 'done' and 'error' carry the outcome. */
type Step = 'form' | 'review' | 'working' | 'done' | 'error'

interface Props {
  open: boolean
  onClose: () => void
  agentId: string
  chainId: number
  tokens: TokenOption[]
  /** The ACTIVE budget being edited — its hash and current limits prefill the form. */
  budget: DelegationBudget
  /** Fires after the edit landed (success or partial), mirroring #1090. */
  onBudgetChange?: () => void
}

const PERIODS: Array<{ label: string; seconds: number }> = [
  { label: 'per day', seconds: 86_400 },
  { label: 'per week', seconds: 604_800 },
  { label: 'per month', seconds: 2_592_000 },
]

function periodLabel(seconds: number): string {
  return PERIODS.find((p) => p.seconds === seconds)?.label ?? `every ${seconds}s`
}

export default function EditBudgetModal({
  open,
  onClose,
  agentId,
  chainId,
  tokens,
  budget,
  onBudgetChange,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, open)
  const { editBudget, busy, ready, signersError, reloadSigners } = useDelegationBudget(
    agentId,
    chainId,
    { enabled: open },
  )

  const token = useMemo(
    () => tokens.find((t) => t.address.toLowerCase() === budget.token_address.toLowerCase()),
    [budget.token_address, tokens],
  )

  const [step, setStep] = useState<Step>('form')
  const [amount, setAmount] = useState('')
  const [period, setPeriod] = useState(budget.period_seconds)
  const [recipient, setRecipient] = useState(budget.recipient_address ?? '')
  const [outcome, setOutcome] = useState<EditBudgetResult | null>(null)

  // Prefill every time the modal opens (also re-prefills after a close/reopen
  // on a REFRESHED budget row — the card reloads between opens, so a stale
  // amount must not survive).
  useEffect(() => {
    if (!open) return
    setStep('form')
    setOutcome(null)
    setPeriod(budget.period_seconds)
    setRecipient(budget.recipient_address ?? '')
    try {
      setAmount(formatUnits(BigInt(budget.budget_atomic), token?.decimals ?? 18))
    } catch {
      // A malformed stored amount leaves the field empty rather than
      // prefilling something the form would refuse — the human types it.
      setAmount('')
    }
  }, [open, budget, token])

  const periodOptions = useMemo(() => {
    const list = [...PERIODS]
    if (!list.some((p) => p.seconds === period)) {
      list.push({ label: `every ${period}s`, seconds: period })
    }
    return list
  }, [period])

  const recipientValid = recipient.trim() === '' || isAddress(recipient.trim())
  const amountValid = amount.trim() !== '' && Number(amount) > 0

  // The new delegation's input. Null while incomplete, which disables Review.
  const input = useMemo<GrantInput | null>(() => {
    if (!token || !amountValid || !recipientValid) return null
    let budgetAtomic: string
    try {
      budgetAtomic = parseUnits(amount, token.decimals).toString()
    } catch {
      return null
    }
    return {
      tokenAddress: token.address as Address,
      recipientAddress: recipient.trim() ? (recipient.trim() as Address) : null,
      budgetAtomic,
      periodSeconds: period,
    }
  }, [amount, amountValid, period, recipient, recipientValid, token])

  // The change the owner is about to sign, at human precision. Both sides are
  // formatted through viem so a decimal comparison never compares strings.
  const changes = useMemo(() => {
    if (!input || !token) return null
    let newAmount: string
    try {
      newAmount = formatUnits(BigInt(input.budgetAtomic), token.decimals)
    } catch {
      return null
    }
    let oldAmount: string
    try {
      oldAmount = formatUnits(BigInt(budget.budget_atomic), token.decimals)
    } catch {
      oldAmount = budget.budget_atomic
    }
    const raised = BigInt(input.budgetAtomic) > BigInt(budget.budget_atomic)
    const lowered = BigInt(input.budgetAtomic) < BigInt(budget.budget_atomic)
    const periodChanged = input.periodSeconds !== budget.period_seconds
    const recipientChanged =
      (input.recipientAddress ?? null)?.toLowerCase() !==
      (budget.recipient_address ?? null)?.toLowerCase()
    return {
      raised,
      lowered,
      oldAmount,
      newAmount,
      symbol: token.symbol,
      periodChanged,
      oldPeriod: budget.period_seconds,
      newPeriod: input.periodSeconds,
      recipientChanged,
      oldRecipient: budget.recipient_address,
      newRecipient: input.recipientAddress ?? null,
      changed: raised || lowered || periodChanged || recipientChanged,
    }
  }, [budget, input, token])

  const handleClose = useCallback(() => {
    if (busy) return
    onClose()
  }, [busy, onClose])

  useEscapeToClose(open, handleClose, { enabled: !busy })

  const run = useCallback(async () => {
    if (!input || !changes) return
    setStep('working')
    const result = await editBudget(budget.delegation_hash, input)
    setOutcome(result)
    if (result.ok) {
      setStep('done')
      onBudgetChange?.()
    } else if (result.reason === 'cancelled') {
      // A dismissed signature is "not yet" (same treatment BudgetGrantAction
      // gives it): reopen the review so the owner can simply try again.
      setStep('review')
    } else {
      setStep('error')
      // The partial shape means the new budget IS live — refresh the card.
      if (result.reason === 'revoke_unfinished') onBudgetChange?.()
    }
  }, [budget.delegation_hash, changes, editBudget, input, onBudgetChange])

  if (!open) return null

  const changed = changes?.changed ?? false

  return (
    // `v2-safe-overlay` + a 1rem gutter is `p-4` that also clears the notch and
    // the home indicator (#2730), the same wrapper EditAgentModal paints.
    <div className="fixed inset-0 z-[var(--v2-z-modal)] flex items-center justify-center v2-safe-overlay [--v2-safe-gutter:1rem] v2-modal-backdrop">
      <div className="absolute inset-0" onClick={busy ? undefined : handleClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Edit budget"
        className="relative max-h-[calc(90vh-var(--v2-safe-top)-var(--v2-safe-bottom))] w-full max-w-lg overflow-y-auto rounded-2xl border border-[var(--v2-border)] bg-[var(--v2-bg)] shadow-modal"
      >
        <div className="flex items-center justify-between border-b border-[var(--v2-border)] px-6 py-5">
          <div>
            <h2 className="text-lg font-semibold text-[var(--v2-ink)]">Edit budget</h2>
            <p className="mt-0.5 text-xs text-[var(--v2-ink-3)]">
              Change what this agent can spend. Nothing changes until you sign.
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            disabled={busy}
            aria-label="Close"
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-surface-2)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 disabled:opacity-50"
          >
            <Icon icon={X} className="h-4 w-4" />
          </button>
        </div>

        <div className="p-6">
          {signersError ? (
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)] px-4 py-3">
              <p className="text-sm text-[var(--v2-ink-2)]">
                Haven could not load how this account is approved.
              </p>
              <Button size="sm" variant="ghost" onClick={() => void reloadSigners()}>
                Try again
              </Button>
            </div>
          ) : null}

          {step === 'form' && (
            <div className="space-y-5">
              <p className="text-sm text-[var(--v2-ink-2)]">
                Editing the {formatUnits(BigInt(budget.budget_atomic), token?.decimals ?? 18)}{' '}
                {token?.symbol} {periodLabel(budget.period_seconds)} budget
                {budget.recipient_address ? ' for its recipient' : ''}. Your current budget keeps
                working until the new one is signed.
              </p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="Amount"
                  className="sm:w-32"
                  aria-label="Budget amount"
                />
                <span className="self-center text-sm text-[var(--v2-ink-muted)]">
                  {token?.symbol}
                </span>
                <Select
                  value={String(period)}
                  onChange={(e) => setPeriod(Number(e.target.value))}
                  aria-label="Period"
                  className="sm:w-36"
                >
                  {periodOptions.map((p) => (
                    <option key={p.seconds} value={p.seconds}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              </div>
              <Input
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder="Recipient address"
                helperText="Optional — leave blank for any recipient."
                className="font-mono"
                aria-label="Recipient"
              />
              {!recipientValid ? (
                <p className="text-xs text-[var(--v2-danger)]">
                  Recipient must be a valid wallet address, or blank for any recipient.
                </p>
              ) : !amountValid ? (
                <p className="text-xs text-[var(--v2-ink-3)]">
                  Enter an amount above zero to continue.
                </p>
              ) : null}
              <div className="flex gap-3">
                <Button variant="ghost" onClick={handleClose} className="flex-1" disabled={busy}>
                  Cancel
                </Button>
                <Button
                  onClick={() => setStep('review')}
                  disabled={!changed}
                  className="flex-1"
                >
                  Review changes
                </Button>
              </div>
            </div>
          )}

          {step === 'review' && changes && (
            <div className="space-y-5">
              <div className="space-y-3 rounded-xl border border-[var(--v2-border)] bg-[var(--v2-surface)] p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs font-medium text-[var(--v2-ink-3)]">Budget</p>
                  {changes.raised ? (
                    <span className="rounded-full border border-warning/30 bg-[var(--v2-warning-soft)] px-2 py-0.5 text-xs font-medium text-[var(--v2-ink)]">
                      Raise
                    </span>
                  ) : changes.lowered ? (
                    <span className="rounded-full border border-[var(--v2-border)] bg-[var(--v2-surface-2)] px-2 py-0.5 text-xs font-medium text-[var(--v2-ink-2)]">
                      Lower
                    </span>
                  ) : null}
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-[var(--v2-ink-3)]">Now</p>
                  <p className="text-sm text-[var(--v2-ink-2)]">
                    {changes.oldAmount} {changes.symbol} {periodLabel(changes.oldPeriod)}
                    {changes.oldRecipient ? ' · one recipient' : ' · any recipient'}
                  </p>
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-[var(--v2-ink-3)]">After you sign</p>
                  <p className="text-sm font-medium text-[var(--v2-ink)]">
                    {changes.newAmount} {changes.symbol} {periodLabel(changes.newPeriod)}
                    {changes.newRecipient ? ' · one recipient' : ' · any recipient'}
                  </p>
                </div>
                {changes.raised ? (
                  <p className="text-xs leading-relaxed text-[var(--v2-ink-2)]">
                    You are raising what this agent can spend from your Haven wallet. Payments
                    above the budget are refused on-chain — they are not held for approval.
                  </p>
                ) : (
                  <p className="text-xs leading-relaxed text-[var(--v2-ink-2)]">
                    Payments above the budget are refused on-chain — they are not held for
                    approval.
                  </p>
                )}
              </div>
              <div className="space-y-2 rounded-xl border border-[var(--v2-border)] p-4 text-xs leading-relaxed text-[var(--v2-ink-2)]">
                <p>
                  Signing once sets the new limits. Your current budget keeps working until then —
                  if you stop here, nothing changes.
                </p>
                <p>
                  Right after you sign, both the old and the new budget exist briefly (the
                  agent could spend up to their combined limit) until you sign once more to stop
                  the old one. Haven will ask for that second signature.
                </p>
              </div>
              <div className="flex gap-3">
                <Button variant="ghost" onClick={() => setStep('form')} className="flex-1" disabled={busy}>
                  Back
                </Button>
                <Button onClick={() => void run()} disabled={busy} className="flex-1">
                  Sign new budget
                </Button>
              </div>
            </div>
          )}

          {step === 'working' && (
            <div className="space-y-4 py-8 text-center">
              <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-[var(--v2-brand)] border-t-transparent" />
              <p className="text-sm font-medium text-[var(--v2-ink)]">Waiting for your signature…</p>
              <p className="mx-auto max-w-xs text-xs text-[var(--v2-ink-3)]">
                Approve in your wallet or with your passkey. The budget changes only after you
                sign.
              </p>
            </div>
          )}

          {step === 'done' && (
            <div className="space-y-5">
              <div className="py-4 text-center">
                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--v2-success-soft)]">
                  <Icon icon={Check} className="h-6 w-6 text-[var(--v2-success)]" />
                </div>
                <p className="text-sm font-medium text-[var(--v2-ink)]">Budget updated</p>
                <p className="mt-1 text-xs text-[var(--v2-ink-3)]">
                  The new limits are live
                  {outcome?.ok && !outcome.oldDelegationRevoked
                    ? ' — the previous budget was already stopped'
                    : ' and the previous budget is stopped'}
                  .
                </p>
              </div>
              <Button variant="ghost" onClick={handleClose} className="w-full">
                Done
              </Button>
            </div>
          )}

          {step === 'error' && outcome && !outcome.ok && (
            <div className="space-y-5">
              <div className="space-y-3 py-2 text-center">
                <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-[var(--v2-danger-soft)]">
                  <Icon icon={X} className="h-5 w-5 text-[var(--v2-danger)]" />
                </div>
                {outcome.reason === 'revoke_unfinished' ? (
                  <>
                    <p className="text-sm font-medium text-[var(--v2-ink)]">
                      New budget is live — one step left
                    </p>
                    <p className="mx-auto max-w-xs text-xs leading-relaxed text-[var(--v2-ink-3)]">
                      The new limits took effect, but the previous budget still needs to be
                      stopped. Use Stop next to it in the budget list when you are ready.
                    </p>
                  </>
                ) : outcome.reason === 'refused' ? (
                  <>
                    <p className="text-sm font-medium text-[var(--v2-ink)]">
                      The budget could not be changed
                    </p>
                    <p className="mx-auto max-w-xs text-xs leading-relaxed text-[var(--v2-ink-3)]">
                      {outcome.detail ?? 'Haven could not prepare the change.'} Your current
                      budget is unchanged.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-sm font-medium text-[var(--v2-ink)]">
                      Budget update failed
                    </p>
                    <p className="mx-auto max-w-xs text-xs leading-relaxed text-[var(--v2-ink-3)]">
                      Nothing changed — your current budget still works. Try again.
                    </p>
                  </>
                )}
              </div>
              <div className="flex gap-3">
                <Button variant="ghost" onClick={handleClose} className="flex-1">
                  Close
                </Button>
                <Button onClick={() => setStep('review')} className="flex-1" disabled={busy}>
                  Try again
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
