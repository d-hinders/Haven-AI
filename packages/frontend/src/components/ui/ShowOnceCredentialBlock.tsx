'use client'

import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { CopyButton } from '@/components/ui/CopyButton'
import { useToast } from '@/components/ui/Toast'

/**
 * The show-once credential block (#4905, documented in
 * `docs/product/design-system.md` § Show-once credential block): a secret Haven
 * hands over exactly once, in the copy-a-string shape.
 *
 * It was two hand-built copies (`PaymentCredentialsModal`,
 * `ReplaceSigningKeyModal`); the Sales key dialog was the third, so it is built
 * once. The caller owns the heading and the one line saying "shown once" (they
 * differ per secret); this owns the value box and its actions.
 *
 * Decisions the extraction settled:
 * - The actions sit BELOW the tinted value box, not inside it. The tint is the
 *   code-block surface; sibling controls on it are what `CLAUDE.md` § UI
 *   Surface Hierarchy rules out, and inside a Card they would stand on a tint
 *   the card does not own.
 * - A failed copy is a toast, always. A one-time value that fails to copy and
 *   says nothing is a lost credential (#4573).
 * - The creating view shows the value (`revealable` off). A caller reached
 *   later may open masked with a Show / Hide toggle (`revealable`).
 * - After the creating view closes the caller passes `value={null}`: the box
 *   shows `maskedValue` and `fallback` holds the rotate or replace path. The
 *   value is only ever a prop, never copied into this component's state.
 */
export function ShowOnceCredentialBlock({
  value,
  maskedValue,
  label,
  copyText = 'Copy',
  revealable = false,
  onCopied,
  fallback,
}: {
  /** The full secret, or `null` once the creating view has closed. */
  value: string | null
  /** What the box reads when there is no value, or the value is hidden. */
  maskedValue: string
  /** What is copied, lowercase, for the accessible name and the failure toast ("credential"). */
  label: string
  copyText?: string
  /** Opens masked with a Show / Hide toggle beside Copy. */
  revealable?: boolean
  /** Fires only after the clipboard write succeeds. */
  onCopied?: () => void
  /** The actions shown instead of Copy when `value` is `null` (the rotate or replace path). */
  fallback?: ReactNode
}) {
  const { toast } = useToast()
  const [shown, setShown] = useState(!revealable)
  const visible = value !== null && shown

  return (
    <div data-testid="show-once-credential">
      <div className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-3">
        <code className="block break-all font-mono text-xs text-[var(--v2-ink-2)]">
          {visible ? value : maskedValue}
        </code>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {value !== null ? (
          <>
            {revealable ? (
              <Button size="sm" variant="ghost" onClick={() => setShown((current) => !current)}>
                {shown ? 'Hide' : 'Show'}
              </Button>
            ) : null}
            <CopyButton
              value={value}
              label={label}
              text={copyText}
              onCopied={onCopied}
              onCopyFailed={() => toast.error(`Could not copy ${label}`)}
            />
          </>
        ) : (
          fallback
        )}
      </div>
    </div>
  )
}

export default ShowOnceCredentialBlock
