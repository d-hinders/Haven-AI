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
import type { BudgetResult, GrantInput } from '@/hooks/useDelegationBudget'
import { Button } from './ui/Button'

interface Props {
  /** `grant` from the caller's `useDelegationBudget` instance. */
  grant: (input: GrantInput) => Promise<BudgetResult>
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
  /** Explains what to do when `ready` is false. */
  notReadyHint?: string
  /**
   * The way OUT of a not-ready state — typically a connect-wallet control. A
   * blocked action with no recovery affordance is the dead end this whole
   * issue exists to remove, so surface one wherever `ready` can be false.
   */
  notReadyAction?: ReactNode
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
  notReadyHint,
  notReadyAction,
  onGranted,
  className,
}: Props) {
  const [outcome, setOutcome] = useState<'cancelled' | 'failed' | null>(null)

  async function handleClick() {
    if (!input) return
    // A retry starts clean — the previous outcome is about the previous attempt.
    setOutcome(null)
    const result = await grant(input)
    if (result.ok) {
      onGranted?.()
      return
    }
    // `too_many` is a revoke-ALL refusal (#1437) and cannot arise from a
    // grant; this surface has no batch. Fold it into the generic failure
    // rather than teaching a grant screen a word it can never mean.
    setOutcome(result.reason === 'too_many' ? 'failed' : result.reason)
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

      {/*
        Cancelled is NOT an error state. Muted ink, no border, no danger token —
        the control stays live and the user simply tries again.
      */}
      {outcome === 'cancelled' && (
        <p className="mb-3 text-xs leading-relaxed text-[var(--v2-ink-2)]">
          No signature yet — nothing changed. You can try again when you are ready.
        </p>
      )}

      {outcome === 'failed' && (
        <p className="mb-3 rounded-[10px] border border-danger/20 bg-[var(--v2-danger-soft)] px-3 py-2 text-xs text-[var(--v2-danger)]">
          Haven could not set the budget. Nothing changed — try again.
        </p>
      )}

      <div className="flex items-center gap-3">
        {leadingAction}
        <Button
          onClick={handleClick}
          disabled={busy || !ready || !input}
          className={leadingAction ? 'flex-1' : undefined}
        >
          {busy ? busyLabel : label}
        </Button>
        {helper && !leadingAction && (
          <span className="text-xs text-[var(--v2-ink-muted)]">{helper}</span>
        )}
      </div>
    </div>
  )
}
