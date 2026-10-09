'use client'

/**
 * NoticeRow — one tinted notice line inside a card or modal: a sentence and,
 * optionally, the one action that resolves it (#3845).
 *
 * It replaces three hand-copied rows on the owner-signing surfaces (the
 * budget card's failed signer load and its #3812 "connect your owner wallet"
 * notice, and the edit-budget modal's failed signer load). The tint is a
 * callout — one of the uses the surface-hierarchy rule reserves
 * `--v2-surface` for — so it is not a grouping wrapper.
 *
 * Not `AttentionList` (#3805): that is a dismissable list of "needs you"
 * items. This is a single, non-dismissable line that stays until its cause
 * is gone.
 *
 * Below `sm` the action sits on its own line under the text, so a long
 * sentence never squeezes the button; from `sm` up they share one line, the
 * action at the end. The caller owns the outer margin (`className`), since
 * the row sits in different rhythms (a card's `mb-4`, a modal's `mb-5`).
 */

import type { ReactNode } from 'react'

export function NoticeRow({
  children,
  action,
  className = '',
}: {
  /** The notice text — one sentence. */
  children: ReactNode
  /** The one control that resolves the notice (a button, a wallet connect). */
  action?: ReactNode
  /** Outer spacing from the caller, e.g. `mb-4`. */
  className?: string
}) {
  return (
    <div
      className={`flex flex-col items-start gap-3 rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)] px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between ${className}`.trim()}
    >
      <p className="text-sm text-[var(--v2-ink-2)]">{children}</p>
      {action ? <div data-notice-action className="shrink-0">{action}</div> : null}
    </div>
  )
}
