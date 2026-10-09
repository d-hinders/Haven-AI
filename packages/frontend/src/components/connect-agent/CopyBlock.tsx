'use client'

import { Button } from '../ui/Button'
import { Card } from '../ui/Card'

/**
 * The code-preview surface every copyable value in the connect flow sits on.
 * #1393: one radius scale — the token 10px tier the Card primitive carries,
 * not the 6px `rounded-md` this used to sit at. Exported for the connect
 * step's "View the prompt" disclosure (#3832), which shows the same value
 * without a second Copy button competing with row 1's primary.
 */
export const CODE_PREVIEW_CLASS =
  'max-h-48 overflow-auto rounded-[10px] bg-[var(--v2-surface)] p-3 text-left text-xs leading-relaxed text-[var(--v2-ink)] whitespace-pre-wrap break-words'

export function CopyBlock({
  label,
  value,
  copied,
  onCopy,
  primary = false,
  nested = false,
}: {
  label: string
  value: string
  copied: boolean
  onCopy: () => void
  /**
   * #1391: marks THE action that moves the user forward. Exactly one block per
   * screen should set this. (#3832 moved the connect step off it — that
   * screen's primary is now a full-width Copy button with the prompt behind a
   * disclosure — so the onboarding-prompt card is its one caller.)
   */
  primary?: boolean
  /**
   * #2535: render WITHOUT the `Card` shell, for a caller that is already inside
   * one.
   *
   * The default shell is right for this component's original home — the connect
   * modal, where each block is a standalone content card on a plain background.
   * It is wrong inside another `Card`: `haven-design-reviewer` found the
   * onboarding-prompt card rendering `Card > Card.Section > CopyBlock`, where
   * that third `Card` is a second independently bordered and shadowed box —
   * exactly the nested-filled-card composition
   * `Card.tsx`'s own invariant forbids and the mechanical gates cannot see.
   *
   * An opt-in flag rather than a change to the default, because the call
   * sites in `WaitingForConnector` are genuinely standalone and their
   * rendering must not move.
   */
  nested?: boolean
}) {
  const body = (
    <>
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-xs font-medium text-[var(--v2-ink-3)]">{label}</p>
        {/* #1391 design review: size="sm" is h-9 (36px), under the ≥44px floor
            design-review.md sets for primary mobile touch targets, so the
            primary instance carries min-h-11. The ghost instances are
            secondary and stay compact. */}
        <Button
          variant={primary ? 'primary' : 'ghost'}
          size="sm"
          className={primary ? 'min-h-11' : undefined}
          onClick={onCopy}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className={CODE_PREVIEW_CLASS}>{value}</pre>
    </>
  )

  if (nested) return body

  // #1393: the design system's white-on-white card, not a hand-rolled
  // rounded/border/bg-white shell — `hover` off since this is a static
  // content block, not an interactive card.
  return (
    <Card hover={false} className="p-3">
      {body}
    </Card>
  )
}
