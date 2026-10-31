'use client'

import { useEffect, useId, useRef } from 'react'
import { Button } from '../ui/Button'

/**
 * The connect flow's close guard (#4570): an INLINE confirmation panel, not a
 * dialog.
 *
 * It replaces the app's only `window.confirm`, which guarded closing the flow
 * while a one-time manual credential was unsaved. It is deliberately not a
 * `ConfirmDialog`: `ConnectAgentModal` already wraps the flow in a `Modal`, and
 * `ConfirmDialog` is itself a `Modal`, so a dialog here would nest
 * (`docs/product/README.md:222`). The same panel serves the inline `/agents`
 * path, where the flow renders in a `Card` with no modal parent — one
 * component, one behaviour.
 *
 * It carries no `role="dialog"`: the flow's own container owns that role, and
 * a second one would be the nesting this panel exists to avoid. It is a
 * labelled group, and it takes focus on open so a keyboard user lands on the
 * question rather than behind it.
 */
export function CloseGuardPanel({
  onCancel,
  onConfirm,
}: {
  /** Keep the credential and stay in the flow. */
  onCancel: () => void
  /** Drop the credential and leave the flow. */
  onConfirm: () => void
}) {
  const headingId = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)

  // Focus lands on Cancel, never on the destructive answer: the panel opens
  // from a close the user just asked for, and a second Enter must not throw
  // the credential away.
  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  return (
    <div
      role="group"
      aria-labelledby={headingId}
      data-testid="connect-close-guard"
      className="rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)] p-4"
    >
      <h3 id={headingId} className="text-sm font-medium text-[var(--v2-ink)]">
        Close without saving the credential?
      </h3>
      <p className="mt-1 text-sm leading-relaxed text-[var(--v2-ink-2)]">
        This one-time manual credential will be hidden if you close now.
      </p>
      <div className="mt-3 flex flex-wrap gap-3">
        <Button ref={cancelRef} type="button" variant="tertiary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" variant="danger" onClick={onConfirm}>
          Close anyway
        </Button>
      </div>
    </div>
  )
}
