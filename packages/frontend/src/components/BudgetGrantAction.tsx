'use client'

/**
 * The ONE place a budget grant is performed (#1073).
 *
 * Both surfaces that confer spend authority on the delegation rail render this
 * control: the connect-agent modal's approval step and the agent detail page's
 * budget card. It is deliberately not a design-system primitive — it carries
 * money-authority behaviour, not a visual pattern — so it lives beside the two
 * feature components that use it rather than under `ui/`/`haven/`.
 *
 * What it owns, and why it must not be re-implemented per surface:
 *
 * - the disabled predicate (busy, not-ready, incomplete input);
 * - the distinction between a CANCELLED signature and a FAILED one. A
 *   dismissed passkey sheet is the single most common interaction here, and it
 *   means "not yet", not "something broke": it re-arms the control in place,
 *   in neutral copy, and never renders as an error. Only a real failure is
 *   styled as one.
 *
 * The caller owns the budget itself and passes its own `useDelegationBudget`
 * instance in, so a surface that already lists budgets does not open a second
 * one.
 */

import { useState, type ReactNode } from 'react'
import type { GrantInput, GrantResult } from '@/hooks/useDelegationBudget'
import { Button } from './ui/Button'

interface Props {
  /** `grant` from the caller's `useDelegationBudget` instance. */
  grant: (input: GrantInput) => Promise<GrantResult>
  busy: boolean
  /** False while the account has no way to sign yet (owner wallet not connected). */
  ready: boolean
  /** The resolved budget, or null while the caller's input is incomplete. */
  input: GrantInput | null
  label: string
  busyLabel: string
  /** Shown next to the control; omit where the surrounding copy already says it. */
  helper?: string
  /**
   * Rendered to the LEFT of the grant button, in the same row — the modal's
   * Cancel/Close. With it, the row is a standard modal footer: equal-width
   * ghost-then-primary, the grant action carrying the most weight. Without it
   * the button keeps its intrinsic width beside `helper`, which is what a
   * form on a page wants.
   */
  leadingAction?: ReactNode
  /**
   * Rendered right AFTER the grant button in the page-form row — the Cancel
   * of a form that opened in place (#3695). Unlike `leadingAction` it keeps
   * the page shape: the grant button stays its intrinsic width and `helper`
   * stays on the row.
   */
  trailingAction?: ReactNode
  /** Explains what to do when `ready` is false. */
  notReadyHint?: string
  /**
   * The way OUT of a not-ready state — typically a connect-wallet control. A
   * blocked action with no recovery affordance is the dead end this whole
   * issue exists to remove, so surface one wherever `ready` can be false.
   */
  notReadyAction?: ReactNode
  /**
   * Information shown above the control while it IS ready — the #1097
   * cross-device heads-up (#3825). Never a gate: the button stays live.
   */
  readyHint?: ReactNode
  /**
   * The failure sentence shown when the signature fails. Each surface supplies
   * the verb of its own button — the connect modal approves, the agent page
   * sets — because one hard-coded sentence cannot match both (#3895).
   */
  failureMessage: string
  /**
   * #3933: the (token, recipient) slot already holds a live budget, and the
   * backend refused a plain grant into it (`slot_occupied`). Never the
   * generic failure: retrying the same grant cannot succeed. A caller that
   * can edit the existing budget routes there through this callback (the
   * agent page's card), and the control shows nothing of its own.
   */
  onSlotOccupied?: (existingDelegationHash: string | null) => void
  /**
   * #3933: what to show for `slot_occupied` when the caller has no edit flow
   * of its own (the connect modal): a sentence and a way to the agent page.
   * Once shown, the grant control is disabled — the same grant would only be
   * refused again.
   */
  slotOccupiedNotice?: ReactNode
  onGranted?: () => void
  className?: string
}

export default function BudgetGrantAction({
  grant,
  busy,
  ready,
  input,
  label,
  busyLabel,
  helper,
  leadingAction,
  trailingAction,
  notReadyHint,
  notReadyAction,
  readyHint,
  failureMessage,
  onSlotOccupied,
  slotOccupiedNotice,
  onGranted,
  className,
}: Props) {
  const [outcome, setOutcome] = useState<'cancelled' | 'failed' | 'unconfirmed' | 'slot_occupied' | null>(null)

  async function handleClick() {
    if (!input) return
    // A retry starts clean — the previous outcome is about the previous attempt.
    setOutcome(null)
    const result = await grant(input)
    if (result.ok) {
      onGranted?.()
      return
    }
    // #3933: an occupied slot is not a failure of this grant — it is the
    // backend sending the owner to edit the budget already there. A caller
    // with an edit flow takes it from here; otherwise the control shows the
    // caller's notice.
    if (result.reason === 'slot_occupied') {
      if (onSlotOccupied) {
        onSlotOccupied(result.existingDelegationHash)
        return
      }
      setOutcome('slot_occupied')
      return
    }
    // `too_many` is a revoke-ALL refusal (#1437) and cannot arise from a
    // grant; this surface has no batch. `refused` (#3331) is a NAMED build
    // refusal with its own `detail` sentence — a caller that wants to show it
    // (the fund-merchant modal) reads `grant()`'s result itself rather than
    // going through this generic control. Both fold into the generic failure
    // here rather than teaching this shared control a word it cannot yet
    // display. `unconfirmed` (#3930) does NOT fold: the activation may have
    // committed, so the generic "nothing changed — try again" failure sentence
    // would invite a retry that mints a second enabled grant — it gets its own
    // branch below.
    setOutcome(result.reason === 'too_many' || result.reason === 'refused' ? 'failed' : result.reason)
  }

  // Explanations come BEFORE the action row — the same order the legacy
  // approval step uses, so a user who has seen one recognises the other.
  return (
    <div className={className}>
      {!ready && (notReadyHint || notReadyAction) && (
        <div className="mb-3">
          {notReadyHint && (
            <p className="text-xs leading-relaxed text-[var(--v2-ink-2)]">{notReadyHint}</p>
          )}
          {notReadyAction && <div className="mt-2">{notReadyAction}</div>}
        </div>
      )}

      {ready && readyHint ? <div className="mb-3">{readyHint}</div> : null}

      {/*
        Cancelled is NOT an error state. Muted ink, no border, no danger token —
        the control stays live and the user simply tries again.
      */}
      {outcome === 'cancelled' && (
        <p className="mb-3 text-xs leading-relaxed text-[var(--v2-ink-2)]">
          No signature yet — nothing changed. You can try again when you are ready.
        </p>
      )}

      {/* #3895: the verb belongs to the caller's button — the connect modal
          approves, the agent page sets. The sentence arrives via prop. */}
      {outcome === 'failed' && (
        <p className="mb-3 rounded-[10px] border border-danger/20 bg-[var(--v2-danger-soft)] px-3 py-2 text-xs text-[var(--v2-danger)]">
          {failureMessage}
        </p>
      )}

      {/*
        #3930: the activation response was lost and the re-read could not prove
        what happened. The grant may already be in place, so this is NOT the
        generic failure: the sentence never says "nothing changed", never names
        Haven as the approver, and sends the owner to check the agent's budgets
        BEFORE trying again. #3971: it no longer warns that a retry adds a
        second budget — since #3933 the backend refuses a second live budget in
        the same (token, recipient) slot, and the retry re-reads the attempt
        first.
      */}
      {outcome === 'unconfirmed' && (
        <p className="mb-3 rounded-[10px] border border-danger/20 bg-[var(--v2-danger-soft)] px-3 py-2 text-xs text-[var(--v2-danger)]">
          The budget could not be confirmed — it may already be in place. Check the agent&apos;s
          budgets before trying again; a retry never adds a second budget for the same token and
          recipient.
        </p>
      )}

      {/* #3933: the slot already holds a live budget. Not the danger style:
          nothing failed, and the notice names where to go instead. */}
      {outcome === 'slot_occupied' && (
        <div className="mb-3 text-xs leading-relaxed text-[var(--v2-ink-2)]">
          {slotOccupiedNotice ??
            'This agent already has a live budget for this token and recipient. Edit that budget on the agent page instead.'}
        </div>
      )}

      {/* #2733: the page form's row squeezed the "Set budget" pill at 390px
          until its label wrapped onto two lines. BELOW `sm` (and only when
          there is no leadingAction — the modal footer keeps its inline row)
          the row stacks: button on its own line at full width, helper under
          it; from `sm` up it is the same side-by-side row as before. Layout
          only: the button, its disabled predicate and the helper text are
          unchanged. */}
      <div
        className={
          leadingAction
            ? 'flex items-center gap-3'
            : 'flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3'
        }
      >
        {leadingAction}
        <Button
          onClick={handleClick}
          disabled={busy || !ready || !input || outcome === 'slot_occupied'}
          className={leadingAction ? 'flex-1' : 'sm:w-auto'}
        >
          {busy ? busyLabel : label}
        </Button>
        {!leadingAction ? trailingAction : null}
        {helper && !leadingAction && (
          <span className="text-xs text-[var(--v2-ink-muted)] sm:ml-auto">{helper}</span>
        )}
      </div>
    </div>
  )
}
