'use client'

import { Button } from '../ui/Button'

export function CopyBlock({
  label,
  value,
  copied,
  onCopy,
  primary = false,
}: {
  label: string
  value: string
  copied: boolean
  onCopy: () => void
  /**
   * #1391: marks THE action that moves the user forward. The waiting screen's
   * only full-width control used to be "Cancel setup", so the abort was the
   * heaviest thing on a screen whose actual next step is copying this prompt.
   * Exactly one block per screen should set this.
   */
  primary?: boolean
}) {
  return (
    <div className="rounded-[10px] border border-[var(--v2-border)] bg-white p-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-xs font-medium text-[var(--v2-ink-3)]">{label}</p>
        {/* #1391 design review: size="sm" is h-9 (36px), under the ≥44px floor
            design-review.md sets for primary mobile touch targets. The recovery
            block in WaitingForConnector already carries min-h-11 for that rule
            on two SECONDARY buttons — missing it on the one control promoted to
            the screen's only primary action was the wrong way round. Scoped to
            primary: the ghost instances are secondary and stay compact. */}
        <Button
          variant={primary ? 'primary' : 'ghost'}
          size="sm"
          className={primary ? 'min-h-11' : undefined}
          onClick={onCopy}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className="max-h-48 overflow-auto rounded-md bg-[var(--v2-surface)] p-3 text-left text-xs leading-relaxed text-[var(--v2-ink)] whitespace-pre-wrap break-words">
        {value}
      </pre>
    </div>
  )
}
