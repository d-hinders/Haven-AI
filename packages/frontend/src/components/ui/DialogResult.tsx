'use client'

/**
 * A dialog's outcome screen, in one place (#4564).
 *
 * Three dialogs hand-built the same three states — a spinner while a request
 * is in flight, a tick when it landed, a cross when it did not — each with its
 * own circle size, its own icon and its own copy rhythm: `EditBudgetModal`
 * (`working` / `done` / `error`), `EditAgentModal` and `FundMerchantModal`.
 * This is the shared shape, so the three read the same and a fourth cannot
 * invent a fifth.
 *
 * It owns the CENTRED BLOCK only — icon, title, description, and any extra
 * notices the caller needs. The action row stays the caller's, because it is
 * the screen's own decision (Close, Try again, Stop old budget) and belongs in
 * `Modal`'s footer, outside the scroll box.
 *
 * The busy state uses #4563's `Spinner`, which gates its rotation behind
 * `motion-safe:` — the hand-rolled `animate-spin` rings this replaces had no
 * gate at all. The spinner carries the title as its accessible name, so a
 * screen reader hears "Waiting for your approval…" once, from the status
 * region, rather than reading a decorative glyph.
 *
 * Tone is the state's, never the caller's: success is `--v2-success`, failure
 * `--v2-danger`, and busy is neutral. A caller that needs a different tone is
 * describing a different state, not recolouring this one.
 *
 * The success mark plays `Milestone` Step (#4702): the check pops once, and
 * nothing else moves. Busy and error do not animate. `play` is the specimen's
 * switch — `/design-system` passes `false` until its Replay control — and
 * `strength` lets a first-in-your-Haven-life moment ask for Peak (#4705)
 * without a second component.
 *
 * `announce` adds `role="status"` for the callers that do not already move
 * focus to the outcome region (`EditAgentModal`, `EditBudgetModal`).
 * `FundMerchantModal` and `DelegationSendModal` focus their step region on the
 * change, so they leave it off rather than announce twice. The busy state is
 * never wrapped: its `Spinner` already carries the title as a status region.
 */

import type { ReactNode } from 'react'
import { Check, X } from 'lucide-react'
import { Spinner } from '@haven_ai/ui/Spinner'
import { Icon } from './Icon'
import { Milestone } from './Milestone'

export type DialogResultState = 'busy' | 'success' | 'error'

interface Props {
  state: DialogResultState
  /** The screen's headline — what happened, in outcome language. */
  title: string
  /** The sentence under the title. Omit when the title says it all. */
  description?: ReactNode
  /**
   * Extra content below the description — a count, a second notice, a
   * retry hint. Rendered in the same narrow column as the description, so a
   * caller passes plain `<p>` elements and inherits the type.
   */
  children?: ReactNode
  className?: string
  /** Play the success mark's Step motion. Default `true`; a specimen passes `false`. */
  play?: boolean
  /** The success mark's strength. Step by default; Peak for a first-in-your-Haven-life moment. */
  strength?: 'step' | 'peak'
  /** Announce the outcome with `role="status"` — only where the caller does not already move focus there. */
  announce?: boolean
}

export function DialogResult({
  state,
  title,
  description,
  children,
  className = '',
  play = true,
  strength = 'step',
  announce = false,
}: Props) {
  return (
    <div
      className={`space-y-3 py-2 text-center ${className}`.trim()}
      role={announce && state !== 'busy' ? 'status' : undefined}
    >
      <div className="flex justify-center">
        {state === 'busy' ? (
          <span className="flex h-10 w-10 items-center justify-center">
            <Spinner size="md" label={title} />
          </span>
        ) : state === 'success' ? (
          <Milestone strength={strength} play={play}>
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--v2-success-soft)]">
              <Icon icon={Check} className="h-6 w-6 text-[var(--v2-success)]" />
            </span>
          </Milestone>
        ) : (
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--v2-danger-soft)]">
            <Icon icon={X} className="h-5 w-5 text-[var(--v2-danger)]" />
          </span>
        )}
      </div>
      <p className="text-sm font-medium text-[var(--v2-ink)]">{title}</p>
      {description || children ? (
        <div className="mx-auto max-w-xs space-y-2 text-xs leading-relaxed text-[var(--v2-ink-3)]">
          {description ? <p>{description}</p> : null}
          {children}
        </div>
      ) : null}
    </div>
  )
}

export default DialogResult
