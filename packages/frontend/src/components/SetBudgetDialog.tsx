'use client'

/**
 * The ONE place a budget is set (#4564, owner decision D3 2026-10-30).
 *
 * The grant form used to open INLINE in the agent page's Spending card, and
 * the card grew to hold it. It is a dialog now: both entry points — the
 * no-budget state's **Set budget** button and a row's ⋯ → **Add budget** —
 * open this, and `?grant=` opens it prefilled (#2539). Only the container
 * changed: the form, its predicates, the #3933 `slot_occupied` route and the
 * #3716 sub-budget entry keep their behaviour.
 *
 * **The dialog stays mounted while closed.** `Modal` renders nothing when
 * `open` is false, so the component costs no DOM, but its state survives —
 * which is what makes the one transition that closes it without the owner's
 * intent work: opening **Issue sub-budget** (#3716). `docs/product/README.md`
 * forbids nested modals, so the card closes this dialog first and reopens it,
 * with the typed amount and recipient intact, when the sub-budget dialog
 * closes. `focusSubBudgetOnOpen` puts focus back on the entry that opened it.
 *
 * **Closing while busy.** A signature or activation in flight disables the ✕,
 * the backdrop and Escape together (`closeButtonDisabled`, `closeOnBackdrop`,
 * `closeOnEscape`) — one unguarded way out would be enough to lose the
 * request.
 *
 * The action row is `BudgetGrantAction`'s dialog-footer mode (`leadingAction`
 * → `DialogActions`), the same shape the Connect agent flow's approval step
 * uses. It sits at the bottom of the BODY rather than in `Modal`'s footer
 * because the control also renders its own outcome notices (cancelled,
 * failed, unconfirmed, slot occupied) directly above the row, and those
 * belong beside the form they are about.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isAddress, parseUnits } from 'viem'
import type { Address } from 'viem'
import type { DelegationBudget, GrantInput, GrantResult } from '@/hooks/useDelegationBudget'
import type { ReceivedSubBudgetGrant } from '@/hooks/useSubBudgets'
import { findOccupyingBudget } from '@/lib/budget-slot'
import { budgetPeriodWords } from '@/lib/budget-caption'
import { BUDGET_END_DEFAULT_DAYS, budgetEndsAt, formatBudgetEndDate } from '@/lib/budget-end'
import BudgetGrantAction from './BudgetGrantAction'
import WalletConnectAction from './WalletConnectAction'
import PasskeyElsewhereHint from './PasskeyElsewhereHint'
import { Modal } from './ui/Modal'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { Select } from './ui/Select'
import { BudgetEndDateSelect, NoticeRow } from '@/components/haven'

interface TokenOption {
  address: string
  symbol: string
  decimals: number
}

/**
 * #2539: the pending build a `?grant=` link names, resolved by the card from
 * the list it already fetched. Applied on the dialog's open edge, so what the
 * human signs is exactly what was constructed.
 */
export interface SetBudgetPrefill {
  tokenAddress: string
  amount: string
  periodSeconds: number
  recipient: string
}

interface Props {
  open: boolean
  onClose: () => void
  tokens: TokenOption[]
  /** The card's live list — the slot check and the "edit instead" label. */
  budgets: DelegationBudget[] | null
  /** The list read failed: the grant is gated on knowing the current budgets (#2473). */
  budgetsError: boolean
  /** An active, unexpired budget exists — the dialog is "Add a budget" then. */
  hasActive: boolean
  /** The card's grant-or-edit submit (#3933). */
  grant: (input: GrantInput) => Promise<GrantResult>
  busy: boolean
  ready: boolean
  signersError: boolean
  signersLoading: boolean
  reloadSigners: () => void | Promise<void>
  passkeyElsewhere: boolean
  /** #2539: the pending build the URL named — applied on the open edge. */
  prefill: SetBudgetPrefill | null
  /** #3988: the grants this agent receives — the empty-state line's nuance. */
  receivedGrants: ReceivedSubBudgetGrant[] | null
  /** #3716: eligible parents; empty hides the sub-budget entry. */
  subBudgetParents: DelegationBudget[]
  onIssueSubBudget: () => void
  /** #3933: the slot holds a live budget — the card routes to Edit. */
  onSlotOccupied: (input: GrantInput, existingDelegationHash: string | null) => void
  onGranted: () => void
  /**
   * #3716: focus the sub-budget entry on this open — set when the dialog is
   * reopening after the sub-budget dialog closed, so focus lands back where
   * it came from rather than on the amount field.
   */
  focusSubBudgetOnOpen?: boolean
}

// The period picker offers the day/week/month rhythm (#3806: the words are
// the caption helper's — a prefilled build may carry any period the CLI chose
// (an hour, a minute-floor of 60s), so the prefilled value gets its own
// option instead of silently desyncing the Select from the state it shows).
const PERIODS = [86_400, 604_800, 2_592_000] as const

export default function SetBudgetDialog({
  open,
  onClose,
  tokens,
  budgets,
  budgetsError,
  hasActive,
  grant,
  busy,
  ready,
  signersError,
  signersLoading,
  reloadSigners,
  passkeyElsewhere,
  prefill,
  receivedGrants,
  subBudgetParents,
  onIssueSubBudget,
  onSlotOccupied,
  onGranted,
  focusSubBudgetOnOpen = false,
}: Props) {
  const [token, setToken] = useState(tokens[0]?.address ?? '')
  const [amount, setAmount] = useState('')
  const [period, setPeriod] = useState(86_400)
  const [recipient, setRecipient] = useState('')
  // #4350: the end date the owner picks for a NEW budget — 30/90/180/365
  // days, 90 the default (owner decision 1 on #4349). Rides the build as
  // `expires_at`; the select renders the resulting date before anything is
  // signed.
  const [endDays, setEndDays] = useState(BUDGET_END_DEFAULT_DAYS)

  const subBudgetEntryRef = useRef<HTMLButtonElement>(null)

  // #2539: apply the pending build on the OPEN edge only, and only ONCE. The
  // card resolves it from the list it already fetched and hands it over;
  // re-applying on every open would wipe what the owner typed after the
  // prefill landed (the dialog stays mounted, so its state survives a close).
  const wasOpenRef = useRef(false)
  const appliedPrefillRef = useRef<SetBudgetPrefill | null>(null)
  useEffect(() => {
    const opening = open && !wasOpenRef.current
    wasOpenRef.current = open
    if (!opening || !prefill || appliedPrefillRef.current === prefill) return
    appliedPrefillRef.current = prefill
    setToken(prefill.tokenAddress)
    setAmount(prefill.amount)
    setPeriod(prefill.periodSeconds)
    setRecipient(prefill.recipient)
  }, [open, prefill])

  const periodOptions = useMemo(() => {
    const list: number[] = [...PERIODS]
    const prefilled = prefill?.periodSeconds
    if (prefilled !== undefined && !list.some((p) => p === prefilled)) {
      list.push(prefilled)
    }
    return list
  }, [prefill])

  const tokenCfg = useMemo(
    () => tokens.find((t) => t.address.toLowerCase() === token.toLowerCase()) ?? tokens[0],
    [token, tokens],
  )
  const recipientValid = recipient.trim() === '' || isAddress(recipient.trim())
  const amountValid = amount.trim() !== '' && Number(amount) > 0

  // The grant INPUT is the card's business; performing the grant — and
  // telling a cancelled signature apart from a failed one — belongs to the
  // shared BudgetGrantAction, so this dialog and the Connect flow behave
  // identically (#1073). Null while the form is incomplete, which disables
  // the control.
  const grantInput = useMemo<GrantInput | null>(() => {
    if (!tokenCfg || !amountValid || !recipientValid) return null
    let budgetAtomic: string
    try {
      budgetAtomic = parseUnits(amount, tokenCfg.decimals).toString()
    } catch {
      return null
    }
    // #4350: the chosen end date rides the build. The presets are always far
    // enough ahead that the conversion is never null on a sane clock.
    const expiresAt = budgetEndsAt(endDays, Math.floor(Date.now() / 1000))
    return {
      tokenAddress: tokenCfg.address as Address,
      recipientAddress: recipient.trim() ? (recipient.trim() as Address) : null,
      budgetAtomic,
      periodSeconds: period,
      ...(expiresAt !== null ? { expiresAt } : {}),
    }
  }, [amount, amountValid, endDays, period, recipient, recipientValid, tokenCfg])

  const nowSec = Math.floor(Date.now() / 1000)
  // #3933: the live budget the form's current input would collide with — the
  // submit then opens the edit flow, and the hint says what that does.
  const formSlotMatch = grantInput && !budgetsError ? findOccupyingBudget(budgets, grantInput, nowSec) : null

  // #3812: `ready` is false for three different reasons. A failed signer-set
  // read has its own Try again, and a pending read is not an answer yet; only
  // the remaining case — the set is known and nobody here can sign — is fixed
  // by connecting the owner wallet, so only it offers that way out.
  const needsOwnerWallet = !ready && !signersError && !signersLoading

  const handleGranted = useCallback(() => {
    // A landed grant clears the form: the next open starts blank rather than
    // re-offering the budget that now exists.
    setAmount('')
    setRecipient('')
    onGranted()
  }, [onGranted])

  const handleSlotOccupied = useCallback(
    (existingDelegationHash: string | null) => {
      if (!grantInput) return
      onSlotOccupied(grantInput, existingDelegationHash)
    },
    [grantInput, onSlotOccupied],
  )

  const title = budgetsError ? 'Set a budget' : hasActive ? 'Add a budget' : 'Set its first budget'
  const subtitle =
    receivedGrants && receivedGrants.length > 0
      ? 'It spends through the received budgets below; a budget of its own adds to that.'
      : 'The agent can start paying within it.'

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      width="md"
      // A signature or activation in flight: every way out is disabled
      // together, or the ✕ becomes the one unguarded exit.
      closeButtonDisabled={busy}
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
      initialFocusRef={focusSubBudgetOnOpen ? subBudgetEntryRef : undefined}
      panelTestId="set-budget-dialog"
    >
      <div className="space-y-4">
        {signersError ? (
          <NoticeRow
            action={
              <Button size="sm" variant="ghost" onClick={() => void reloadSigners()}>
                Try again
              </Button>
            }
          >
            Haven could not load how this account is approved.
          </NoticeRow>
        ) : null}

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
            <span className="self-center text-sm text-[var(--v2-ink-2)]">{tokenCfg?.symbol}</span>
          )}
          <Select value={String(period)} onChange={(e) => setPeriod(Number(e.target.value))} aria-label="Period" className="sm:w-36">
            {periodOptions.map((p) => (
              <option key={p} value={p}>{budgetPeriodWords(p)}</option>
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
        {/* #4350: the end date is a choice, shown with its resulting day —
            the same control the connect flow's approval step and the edit
            modal use, so all three surfaces cannot drift. */}
        <BudgetEndDateSelect
          id="grant-budget-end"
          days={endDays}
          onDaysChange={(d) => setEndDays(d ?? BUDGET_END_DEFAULT_DAYS)}
          nowSec={nowSec}
        />

        {/* #3825: the cross-device heads-up belongs at the moment of
            approval, not at the top of the card — the grant form is the
            signature this dialog asks for. */}
        {ready && passkeyElsewhere ? <PasskeyElsewhereHint /> : null}

        {/* #2473 (money-path review): a grant REPLACES the active budget in
            the same (token, recipient) slot, server-side and silently. In the
            normal state the card's rows are what let an owner see that
            coming; when the list failed to load they cannot, so the action is
            gated on knowing the current budgets rather than on the owner
            reading a warning. `Try again` is the way out. */}
        <BudgetGrantAction
          grant={grant}
          busy={busy}
          ready={ready}
          input={budgetsError ? null : grantInput}
          // #3933: a matching slot opens the edit flow, so the button says so.
          label={formSlotMatch ? 'Edit existing budget' : 'Set budget'}
          busyLabel="Setting…"
          // #3895: the agent page's verb is "set" — its failure sentence
          // keeps the exact wording the shared control used to hard-code.
          failureMessage="Haven could not set the budget. Nothing changed — try again."
          helper={
            budgetsError
              ? 'Reload the current budgets before setting one — a budget for a token and recipient that already has one is edited, not added.'
              : formSlotMatch
                ? 'This agent already has a budget for this token and recipient, so you edit it: you approve the new budget, then approve once more to stop the old one. The review step shows how many approvals that takes. Stopping it ends any open task budget or sub-budget taken from it.'
                : // #4350: the pre-sign copy names the chosen end date — the
                  // "One approval." line may never again hide when the
                  // budget ends (the issue's copy rule).
                  (() => {
                    const endsAt = budgetEndsAt(endDays, nowSec)
                    return endsAt != null
                      ? `One approval. Refills every period automatically until ${formatBudgetEndDate(endsAt)}.`
                      : 'One approval. Refills every period automatically.'
                  })()
          }
          onSlotOccupied={handleSlotOccupied}
          onGranted={handleGranted}
          notReadyHint={needsOwnerWallet ? 'Connect your account owner wallet to set a budget.' : undefined}
          notReadyAction={needsOwnerWallet ? <WalletConnectAction /> : undefined}
          // The dialog's own dismiss, in the action row beside the action it
          // cancels — the shared DialogActions pair.
          leadingAction={
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
          }
        />

        {/* #3716: sharing a slice of an EXISTING budget with another agent is
            a different thing from giving this agent more spending power, so
            it sits below the form — under Set budget and Cancel — and reads
            as another action, never an option of the form. It shows only
            while the dialog is open, keeping the #3506 gate: eligible parents
            (active, unexpired, not merchant-pinned) and no failed budgets
            read (the real hook nulls `budgets` on error, so `subBudgetParents`
            is empty there). */}
        {subBudgetParents.length > 0 && !budgetsError ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-[var(--v2-ink-3)]">
              Or share part of an existing budget with another agent
            </p>
            <Button ref={subBudgetEntryRef} variant="tertiary" onClick={onIssueSubBudget}>
              Issue sub-budget
            </Button>
          </div>
        ) : null}
      </div>
    </Modal>
  )
}
