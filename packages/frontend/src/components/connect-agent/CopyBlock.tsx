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
  nested = false,
}: {
  label: string
  value: string
  copied: boolean
  onCopy: () => void
  /**
   * #2535: render WITHOUT the `Card` shell, for a caller that is already inside
   * one.
   *
   * The default shell is right for this component's original home — the connect
   * modal, where each block is a standalone content card on a plain background.
   * It is wrong inside another `Card`: `haven-design-reviewer` found the
   * (since deleted) onboarding-prompt card rendering `Card > Card.Section >
   * CopyBlock`, where that third `Card` is a second independently bordered and
   * shadowed box — exactly the nested-filled-card composition `Card.tsx`'s own
   * invariant forbids and the mechanical gates cannot see.
   *
   * An opt-in flag rather than a change to the default, because in the modal
   * the call sites in `WaitingForConnector` are genuinely standalone and their
   * rendering must not move. Its caller since #4065 is the inline first-agent
   * flow on `/agents`, which renders the same step inside a `Card`.
   */
  nested?: boolean
}) {
  const body = (
    <>
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-xs font-medium text-[var(--v2-ink-3)]">{label}</p>
        {/* Secondary by design: since #3832 no screen makes a CopyBlock its
            forward action (the connect step's primary is a full-width Copy
            button), and #4065 deleted the onboarding-prompt card that was the
            last `primary` caller, so the prop went with it. */}
        <Button variant="ghost" size="sm" onClick={onCopy}>
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
