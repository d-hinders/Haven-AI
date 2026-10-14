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
import {
  classifyMerchantBudgetRefusal,
  isPermanentMerchantBudgetRefusal,
} from '@/lib/merchantBudgetRefusal'
import { truncateAddress, BudgetAmountRow, NoticeRow } from './haven'
import { budgetPeriodWords } from '@/lib/budget-caption'
import { findOccupyingBudget, sameSlot, slotOccupantHashesForEdit } from '@/lib/budget-slot'
import { Icon } from './ui/Icon'
import { Button } from './ui/Button'
import WalletConnectAction from './WalletConnectAction'
import PasskeyElsewhereHint from './PasskeyElsewhereHint'
import { Input } from './ui/Input'
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
  /**
   * #3933: the limits the owner typed into a NEW-budget form whose (token,
   * recipient) slot turned out to hold this budget. The backend refuses a
   * plain grant there, so the form routes here instead: the edit opens with
   * these limits rather than the current ones, and says why it opened.
   */
  prefill?: { budgetAtomic: string; periodSeconds: number }
  /**
   * #3933: the merchant the replacement budget pays (the marketplace's Fund
   * flow). Absent, a merchant-locked budget keeps its own merchant (#3331 F3);
   * present, the replacement names this one — the same slot, since a
   * merchant-locked budget's slot is its payment address.
   */
  merchant?: { slug: string; name: string }
}

// The day/week/month rhythm the picker offers (#3806: the words come from the
// caption helper, so a prefilled period outside this trio still reads right).
const PERIODS = [86_400, 604_800, 2_592_000] as const

/** #3933: a small count in words, for the Stop-signature copy ("two parts"). */
function countWord(n: number): string {
  return ['zero', 'one', 'two', 'three', 'four'][n] ?? String(n)
}

/**
 * Plain copy for the merchant-STALE build refusals a merchant-locked budget's
 * edit can hit (round 2 review finding R2-2): the merchant's verified payTo
 * moved since this row was granted, the merchant lost its verified payTo or
 * its ERC-7710 offers, or the merchant no longer exists. Classification is
 * shared with `FundMerchantModal` (`@/lib/merchantBudgetRefusal`); only the
 * wording differs — an EDIT has no "reload and retry", and the way out is
 * named per refusal (stop and fund again; stop and fund again once the
 * merchant confirms an address; check the merchant's page; or use Stop on
 * the budget). Returns `null` for every
 * OTHER refusal (a revoked agent, an in-flight re-key, an unavailable
 * account, an off-rail chain, or anything unrecognised) — those keep
 * surfacing the backend's own sentence, unchanged from before this fix.
 */
function editMerchantRefusalCopy(detail: string | undefined, merchantName: string): string | null {
  switch (classifyMerchantBudgetRefusal(detail)) {
    case 'pay_to_changed':
      return `${merchantName} now uses a different payment address, so this budget can't be changed here. Stop it, then fund ${merchantName} again from its page.`
    case 'no_verified_pay_to':
      return `${merchantName} does not have a confirmed payment address right now, so this budget can't be changed here. Stop it, then fund ${merchantName} again once it has one.`
    case 'not_erc7710':
      // The build checks ERC-7710 BEFORE comparing addresses, so this refusal
      // can also mean the merchant moved to a new address — say only what is
      // true in both cases, and point at the page that tells them apart.
      return `Not every offer from ${merchantName} accepts this kind of budget now, so it can't be changed here. This budget keeps paying only the address it was set up with — ${merchantName}'s page shows whether that is still where it is paid.`
    case 'merchant_not_found':
      return `${merchantName} could not be found, so this budget can't be changed here. Close this and stop the budget on the agent page instead.`
    default:
      return null
  }
}

export default function EditBudgetModal({
  open,
  onClose,
  agentId,
  chainId,
  tokens,
  budget,
  onBudgetChange,
  prefill,
  merchant,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, open)
  const { budgets, editBudget, revoke, busy, ready, signersError, signersLoading, reloadSigners, passkeyElsewhere } = useDelegationBudget(
    agentId,
    chainId,
    { enabled: open },
  )

  const token = useMemo(
    () => tokens.find((t) => t.address.toLowerCase() === budget.token_address.toLowerCase()),
    [budget.token_address, tokens],
  )

  // #3331 review finding F3: a merchant-locked budget's Edit must not be able
  // to silently turn it into a plain pinned budget by letting the recipient
  // be retargeted or cleared — that drops the merchant label and the row out
  // of `GET /merchants/{slug}/budgets` the moment it activates. The recipient
  // is read-only here and the build carries `merchant_slug` so the server
  // keeps pinning it to the SAME merchant.
  //
  // #3933: a Fund flow routed here names the merchant the replacement pays
  // (`merchant`); otherwise the budget's own merchant is kept.
  const replacementMerchantSlug = merchant?.slug ?? budget.merchant_slug ?? null
  const isMerchantLocked = !!replacementMerchantSlug
  const oldMerchantName = budget.merchant_slug ? (budget.merchant_name ?? 'this merchant') : null
  const newMerchantName = merchant?.name ?? oldMerchantName ?? 'this merchant'

  const [step, setStep] = useState<Step>('form')
  const [amount, setAmount] = useState('')
  const [period, setPeriod] = useState(budget.period_seconds)
  const [recipient, setRecipient] = useState(budget.recipient_address ?? '')
  const [outcome, setOutcome] = useState<EditBudgetResult | null>(null)
  // #3933: the finish action on the `revoke_unfinished` screen — the Stop of
  // the previous budget, through the same per-hash revoke the card's Stop uses.
  const [finishState, setFinishState] = useState<'idle' | 'stopping' | 'failed' | 'cancelled'>('idle')

  // Prefill every time the modal opens (also re-prefills after a close/reopen
  // on a REFRESHED budget row — the card reloads between opens, so a stale
  // amount must not survive). Only on the closed → open edge (#3537): `budget`
  // and `token` change identity on every agent poll, and re-running on that
  // wiped the typed amount, the review step and the outcome screen.
  const wasOpenRef = useRef(false)
  useEffect(() => {
    const opening = open && !wasOpenRef.current
    wasOpenRef.current = open
    if (!opening) return
    setStep('form')
    setOutcome(null)
    setFinishState('idle')
    // #3933: a routed grant opens with the limits the owner typed.
    setPeriod(prefill?.periodSeconds ?? budget.period_seconds)
    setRecipient(budget.recipient_address ?? '')
    try {
      setAmount(formatUnits(BigInt(prefill?.budgetAtomic ?? budget.budget_atomic), token?.decimals ?? 18))
    } catch {
      // A malformed stored amount leaves the field empty rather than
      // prefilling something the form would refuse — the human types it.
      setAmount('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `prefill` is read on the open edge only, like `budget`
  }, [open, budget, token])

  const periodOptions = useMemo(() => {
    const list: number[] = [...PERIODS]
    if (!list.some((p) => p === period)) {
      list.push(period)
    }
    // Labels are the caption helper's period words (#3806) — the picker, the
    // row and the confirmation all phrase one period the same way.
    return list.map((seconds) => ({ label: budgetPeriodWords(seconds), seconds }))
  }, [period])

  // A merchant-locked budget's recipient is never user-editable (F3) — it is
  // always valid because it is never touched here.
  const recipientValid = isMerchantLocked || recipient.trim() === '' || isAddress(recipient.trim())
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
      recipientAddress: isMerchantLocked
        ? ((budget.recipient_address as Address | null) ?? null)
        : recipient.trim()
          ? (recipient.trim() as Address)
          : null,
      budgetAtomic,
      periodSeconds: period,
      // #3331 review finding F3: keep naming the merchant on the replacement
      // grant — omitting this is what silently downgraded a merchant-locked
      // budget to a plain pinned one. #3933: or the Fund flow's merchant.
      ...(replacementMerchantSlug ? { merchantSlug: replacementMerchantSlug } : {}),
    }
  }, [amount, amountValid, budget.recipient_address, isMerchantLocked, period, recipient, recipientValid, replacementMerchantSlug, token])

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
    // #3933: the Fund flow can move a budget to another merchant sharing the
    // same payment address — a change even when the limits are equal.
    const merchantChanged = (input.merchantSlug ?? null) !== (budget.merchant_slug ?? null)
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
      changed: raised || lowered || periodChanged || recipientChanged || merchantChanged,
    }
  }, [budget, input, token])

  // #3933 review findings 1 and 2: the slot facts the owner must see before
  // signing. `oldBudgetHashes` is every live row of the edited budget's slot
  // (a budget carried through "Replace signing key" is two rows, and each
  // needs its own Stop signature). `moved` is an edit that changes the
  // recipient, so the new budget goes into ANOTHER slot; `targetOccupant` is
  // a live budget already in that slot, which the backend would refuse.
  const nowSec = Math.floor(Date.now() / 1000)
  const oldSlot = { tokenAddress: budget.token_address, recipientAddress: budget.recipient_address }
  const oldBudgetHashes = slotOccupantHashesForEdit(budgets, budget.delegation_hash, oldSlot, nowSec)
  const stopCount = oldBudgetHashes.length
  const moved = !!input && !sameSlot(oldSlot, { tokenAddress: input.tokenAddress, recipientAddress: input.recipientAddress })
  const targetOccupant =
    moved && input
      ? findOccupyingBudget(budgets, { tokenAddress: input.tokenAddress, recipientAddress: input.recipientAddress }, nowSec)
      : null

  const handleClose = useCallback(() => {
    if (busy) return
    onClose()
  }, [busy, onClose])

  useEscapeToClose(open, handleClose, { enabled: !busy })

  const run = useCallback(async () => {
    if (!input || !changes) return
    setStep('working')
    const result = await editBudget(budget.delegation_hash, input, {
      oldSlot: { tokenAddress: budget.token_address, recipientAddress: budget.recipient_address },
    })
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
      // #3933: so does `slot_occupied` — the budget changed under the modal,
      // and the card must show the current one — and `target_slot_occupied`,
      // whose occupant the card's list did not show yet.
      if (
        result.reason === 'revoke_unfinished' ||
        result.reason === 'slot_occupied' ||
        result.reason === 'target_slot_occupied'
      ) {
        onBudgetChange?.()
      }
    }
  }, [budget.delegation_hash, budget.recipient_address, budget.token_address, changes, editBudget, input, onBudgetChange])

  // #3933: finish a replace whose Stop did not land — the same per-hash revoke
  // the card's Stop uses, once per row still enabled (a re-key pair is two),
  // one owner signature each. "Already revoked" comes back as `ok` from the
  // hook (stopped out-of-band, or a revoke-all got there first): finished. A
  // Stop that does not finish keeps the rows still to stop, so the next try
  // resumes there instead of asking again for one already signed.
  const finishStop = useCallback(async () => {
    if (!outcome || outcome.ok) return
    const remaining = outcome.unstoppedDelegationHashes ?? [budget.delegation_hash]
    setFinishState('stopping')
    let signedAny = false
    for (let i = 0; i < remaining.length; i++) {
      const result = await revoke(remaining[i])
      if (!result.ok) {
        setOutcome({ ...outcome, unstoppedDelegationHashes: remaining.slice(i) })
        setFinishState(result.reason === 'cancelled' ? 'cancelled' : 'failed')
        if (i > 0) onBudgetChange?.()
        return
      }
      if (!result.alreadyStopped) signedAny = true
    }
    setFinishState('idle')
    setOutcome({ ok: true, newDelegationHash: outcome.newDelegationHash ?? '', oldDelegationRevoked: signedAny })
    setStep('done')
    onBudgetChange?.()
  }, [budget.delegation_hash, onBudgetChange, outcome, revoke])

  // Round 2 review findings R2-2 / design 2: a merchant-STALE build refusal
  // gets plain copy naming the way out (Stop, then fund again) instead of the
  // raw backend sentence, and — because no retry with the SAME input can ever
  // succeed here — the footer drops "Try again" down to a single "Close".
  // Every other refusal (re-key in flight, account unavailable, off-rail,
  // unrecognised) is unchanged: raw detail + "Your current budget is
  // unchanged.", Close + Try again.
  const refusalKind =
    outcome && !outcome.ok && outcome.reason === 'refused' ? classifyMerchantBudgetRefusal(outcome.detail) : null
  const mappedRefusalCopy =
    outcome && !outcome.ok && outcome.reason === 'refused'
      ? editMerchantRefusalCopy(outcome.detail, budget.merchant_name ?? 'This merchant')
      : null
  const permanentRefusal = refusalKind !== null && isPermanentMerchantBudgetRefusal(refusalKind)

  if (!open) return null

  const changed = changes?.changed ?? false
  const unstoppedCount =
    outcome && !outcome.ok && outcome.reason === 'revoke_unfinished'
      ? (outcome.unstoppedDelegationHashes?.length ?? 1)
      : 0
  // Was the edit that produced this outcome a move? The form can change after
  // an error only through Back, so the current input still describes it.
  const outcomeMoved = moved
  // #3933: the still-enabled budget, named on the `revoke_unfinished` screen.
  const previousBudgetPhrase = (() => {
    let amountText: string
    try {
      amountText = formatUnits(BigInt(budget.budget_atomic), token?.decimals ?? 18)
    } catch {
      amountText = budget.budget_atomic
    }
    return `${amountText} ${token?.symbol ?? ''} ${budgetPeriodWords(budget.period_seconds)}`.replace(/\s+/g, ' ')
  })()

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
            <NoticeRow
              className="mb-5"
              action={
                <Button size="sm" variant="ghost" onClick={() => void reloadSigners()}>
                  Try again
                </Button>
              }
            >
              Haven could not load how this account is approved.
            </NoticeRow>
          ) : null}

          {step === 'form' && (
            <div className="space-y-5">
              {prefill ? (
                // #3933: opened from a new-budget form whose slot holds this
                // budget. Say why the owner is editing rather than adding.
                <NoticeRow>
                  This agent already has a budget for this token and recipient, so your new limits
                  replace it here.
                </NoticeRow>
              ) : null}
              <p className="text-sm text-[var(--v2-ink-2)]">
                Editing the {formatUnits(BigInt(budget.budget_atomic), token?.decimals ?? 18)}{' '}
                {token?.symbol} {budgetPeriodWords(budget.period_seconds)} budget
                {/* Design review round 2, finding 1: a merchant-locked budget
                    already names its merchant in the read-only row just below
                    — "budget for its recipient" here would be a second, vaguer
                    way of saying the same thing. */}
                {!isMerchantLocked && budget.recipient_address ? ' for its recipient' : ''}. Your current
                budget keeps working until the new one is signed.
              </p>
              {/* #3398: the amount row is the shared `BudgetAmountRow` — the
                  token symbol rides inside the amount input as a suffix, so
                  below `sm` no line holds only the token label (it used to
                  orphan on its own stacked line, `self-center`). The budget
                  being edited has ONE token — its (token, recipient) slot is
                  fixed — so exactly that token is passed, never a picker. */}
              <BudgetAmountRow
                amount={amount}
                onAmountChange={setAmount}
                tokens={token ? [token] : []}
                selectedTokenAddress={token?.address ?? null}
                onTokenChange={() => undefined}
                period={period}
                onPeriodChange={setPeriod}
                periods={periodOptions}
                // w-40, not w-32: the symbol now lives INSIDE the input, and a
                // 128px box (minus padding and the suffix reservation) cannot
                // hold the "Amount" placeholder beside it. 160px keeps
                // placeholder and symbol in one box.
                inputClassName="sm:w-40"
                periodSelectClassName="sm:w-36"
              />
              {isMerchantLocked ? (
                // #3331 review finding F3: read-only — never a retarget or a
                // clear-to-open for a budget that pays exactly one merchant.
                <div className="rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)] px-3 py-2">
                  <p className="text-xs text-[var(--v2-ink-2)]">
                    {/* Design review round 2, finding 6: show the truncated
                        address alongside the merchant name, the same "who and
                        where" shape the review step now uses. */}
                    Pays {newMerchantName} only
                    {budget.recipient_address ? ` · ${truncateAddress(budget.recipient_address)}` : ''}. The
                    recipient cannot be changed here.
                  </p>
                </div>
              ) : (
                <Input
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  placeholder="Recipient address"
                  helperText="Optional — leave blank for any recipient."
                  className="font-mono"
                  aria-label="Recipient"
                />
              )}
              {!recipientValid ? (
                <p className="text-xs text-[var(--v2-danger)]">
                  Recipient must be a valid wallet address, or blank for any recipient.
                </p>
              ) : targetOccupant ? (
                // #3933 review finding 2: caught before any signature — the
                // backend refuses a second live budget in that slot.
                <p className="text-xs text-[var(--v2-danger)]">
                  This recipient already has a live budget for this token. Edit that budget
                  instead, or pick another recipient.
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
                  disabled={!changed || !!targetOccupant}
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
                    {changes.oldAmount} {changes.symbol} {budgetPeriodWords(changes.oldPeriod)}
                    {/* Design review round 2, finding 1: name the merchant (and
                        its truncated address) for a merchant-locked budget —
                        the recipient never changes here, so "one recipient" is
                        a strictly vaguer way of saying the same fixed fact. */}
                    {oldMerchantName && changes.oldRecipient
                      ? ` · ${oldMerchantName} only · ${truncateAddress(changes.oldRecipient)}`
                      : changes.oldRecipient
                        ? ' · one recipient'
                        : ' · any recipient'}
                  </p>
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-[var(--v2-ink-3)]">After you sign</p>
                  <p className="text-sm font-medium text-[var(--v2-ink)]">
                    {changes.newAmount} {changes.symbol} {budgetPeriodWords(changes.newPeriod)}
                    {isMerchantLocked && changes.newRecipient
                      ? ` · ${newMerchantName} only · ${truncateAddress(changes.newRecipient)}`
                      : changes.newRecipient
                        ? ' · one recipient'
                        : ' · any recipient'}
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
                {stopCount > 1 ? (
                  // #3933 review finding 1: a budget carried through "Replace
                  // signing key" is held as more than one part, and each part
                  // takes its own Stop signature. Say so before signing.
                  <p>
                    Right after you sign, both the old and the new budget exist briefly (the
                    agent could spend up to their combined limit) until you stop the old one. It
                    is held in {countWord(stopCount)} parts since this agent&apos;s signing key
                    was replaced, so stopping it takes {countWord(stopCount)} more signatures,
                    one per part. Haven will ask for each.
                  </p>
                ) : (
                  <p>
                    Right after you sign, both the old and the new budget exist briefly (the
                    agent could spend up to their combined limit) until you sign once more to stop
                    the old one. Haven will ask for that second signature.
                  </p>
                )}
                {/* #3933: what the Stop signature does on-chain, and what it
                    ends with it. A move (finding 2) leaves the old budget
                    fully working, in Haven too, until it is stopped. */}
                {moved ? (
                  <p>
                    The old budget pays a different recipient, so it keeps working, in Haven and
                    outside it, until it is stopped. Stopping it also ends any open task budget or
                    sub-budget taken from it.
                  </p>
                ) : (
                  <p>
                    Until it is stopped, the old budget can still be spent outside Haven. Stopping it
                    also ends any open task budget or sub-budget taken from it.
                  </p>
                )}
              </div>
              {ready && passkeyElsewhere ? <PasskeyElsewhereHint /> : null}
              {!ready && !signersError && !signersLoading ? (
                // #3812: the wallet can go away after Edit opened (Edit itself
                // is disabled without a signer). Say so before the signature
                // fails, and offer the way back in place.
                <div className="space-y-2">
                  <p className="text-xs text-[var(--v2-ink-3)]">
                    Connect your account owner wallet to sign the new budget.
                  </p>
                  <WalletConnectAction />
                </div>
              ) : null}
              <div className="flex gap-3">
                <Button variant="ghost" onClick={() => setStep('form')} className="flex-1" disabled={busy}>
                  Back
                </Button>
                <Button
                  onClick={() => void run()}
                  // #3812 design review: dead while the hint above says no one
                  // here can sign, the same gate BudgetGrantAction applies.
                  disabled={busy || (!ready && !signersError && !signersLoading)}
                  className="flex-1"
                >
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
                    {/* #3933: name the still-enabled budget, say what it can
                        still do, and offer the Stop right here. */}
                    {outcomeMoved ? (
                      <p className="mx-auto max-w-xs text-xs leading-relaxed text-[var(--v2-ink-3)]">
                        The new limits took effect. The previous {previousBudgetPhrase} budget pays
                        a different recipient, so it keeps working, in Haven and outside it, until
                        it is stopped. Stopping it also ends any open task budget or sub-budget
                        taken from it.
                      </p>
                    ) : (
                      <p className="mx-auto max-w-xs text-xs leading-relaxed text-[var(--v2-ink-3)]">
                        The new limits took effect. The previous {previousBudgetPhrase} budget can
                        still be spent outside Haven until it is stopped. Stopping it also ends any
                        open task budget or sub-budget taken from it.
                      </p>
                    )}
                    {unstoppedCount > 1 ? (
                      <p className="mx-auto max-w-xs text-xs leading-relaxed text-[var(--v2-ink-3)]">
                        It is held in {countWord(unstoppedCount)} parts, so stopping it takes{' '}
                        {countWord(unstoppedCount)} signatures.
                      </p>
                    ) : null}
                    {finishState === 'failed' ? (
                      <p className="mx-auto max-w-xs text-xs leading-relaxed text-[var(--v2-danger)]">
                        The previous budget could not be stopped. Try again.
                      </p>
                    ) : finishState === 'cancelled' ? (
                      <p className="mx-auto max-w-xs text-xs leading-relaxed text-[var(--v2-ink-2)]">
                        No signature yet. The previous budget is not stopped.
                      </p>
                    ) : null}
                  </>
                ) : outcome.reason === 'slot_occupied' ? (
                  <>
                    <p className="text-sm font-medium text-[var(--v2-ink)]">
                      This budget has changed
                    </p>
                    <p className="mx-auto max-w-xs text-xs leading-relaxed text-[var(--v2-ink-3)]">
                      It was replaced after you opened this, so nothing was signed. Close this and
                      edit the current budget.
                    </p>
                  </>
                ) : outcome.reason === 'target_slot_occupied' ? (
                  // #3933 review finding 2: the edited budget is untouched —
                  // the recipient chosen for the new one is the problem.
                  <>
                    <p className="text-sm font-medium text-[var(--v2-ink)]">
                      This recipient already has a budget
                    </p>
                    <p className="mx-auto max-w-xs text-xs leading-relaxed text-[var(--v2-ink-3)]">
                      The recipient you chose already has a live budget for this token, so nothing
                      was signed and this budget is unchanged. Edit that budget instead, or pick
                      another recipient.
                    </p>
                  </>
                ) : outcome.reason === 'unconfirmed' ? (
                  <>
                    <p className="text-sm font-medium text-[var(--v2-ink)]">
                      The change could not be confirmed
                    </p>
                    <p className="mx-auto max-w-xs text-xs leading-relaxed text-[var(--v2-ink-3)]">
                      The new budget may already be in place. Check the agent&apos;s budgets before
                      trying again — a second grant would add a second budget.
                    </p>
                  </>
                ) : outcome.reason === 'refused' ? (
                  <>
                    <p className="text-sm font-medium text-[var(--v2-ink)]">
                      The budget could not be changed
                    </p>
                    <p className="mx-auto max-w-xs text-xs leading-relaxed text-[var(--v2-ink-3)]">
                      {mappedRefusalCopy ??
                        `${outcome.detail ?? 'Haven could not prepare the change.'} Your current budget is unchanged.`}
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
                {outcome.reason === 'revoke_unfinished' ? (
                  <>
                    <Button variant="ghost" onClick={handleClose} className="flex-1" disabled={busy}>
                      Close
                    </Button>
                    <Button
                      onClick={() => void finishStop()}
                      className="flex-1"
                      disabled={busy || finishState === 'stopping' || (!ready && !signersError && !signersLoading)}
                    >
                      {finishState === 'stopping' ? 'Stopping…' : 'Stop old budget'}
                    </Button>
                  </>
                ) : outcome.reason === 'target_slot_occupied' ? (
                  <>
                    <Button variant="ghost" onClick={handleClose} className="flex-1">
                      Close
                    </Button>
                    <Button onClick={() => setStep('form')} className="flex-1">
                      Pick another recipient
                    </Button>
                  </>
                ) : permanentRefusal || outcome.reason === 'slot_occupied' ? (
                  <Button onClick={handleClose} className="flex-1">
                    Close
                  </Button>
                ) : (
                  <>
                    <Button variant="ghost" onClick={handleClose} className="flex-1">
                      Close
                    </Button>
                    <Button onClick={() => setStep('review')} className="flex-1" disabled={busy}>
                      Try again
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
