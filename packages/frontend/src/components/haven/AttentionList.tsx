'use client'

/**
 * AttentionList — the one list of "things that need your eye" (#3805).
 *
 * A `<ul>` of static `Row`s: the row itself is never a link or a button
 * (passing `href`/`onClick` would nest the action inside another control —
 * `Row` renders a link or button when given them), so the caller's action and
 * the dismiss live in the row's `trailing` slot. It exists because every
 * "needs attention" surface was about to hand-roll the same three decisions:
 *
 * ── Tone is also given in TEXT ─────────────────────────────────────────────
 *
 * `Row`'s leading icon is `aria-hidden` — the soft tinted circle carries the
 * tone to the eye and nothing to the ear. So the tone always rides a second
 * channel: a `StatusBadge` label when the item has one, else an `sr-only`
 * tone word. `danger` is for real failures only; a budget REACHED is
 * `neutral` (owner decision 2026-10-09 — the budget did its job, that is a
 * state, not a warning; the detail-page banner ladder in
 * `docs/product/design-system.md` says the same).
 *
 * ── Dismiss ───────────────────────────────────────────────────────────────
 *
 * A button labelled `Dismiss: {title}` (icon-only, so the label is the whole
 * accessible name) calling `onDismiss(id)`. The list holds NO dismissal
 * state — #3813 owns persistence; this component renders what it is given.
 * What it does own is where focus lands: after a dismiss it moves to the
 * next item's dismiss button (the caller re-renders without the dismissed
 * item, and this effect runs after that render), or — when the list emptied —
 * to the caller's list heading via `headingId`. A control that vanishes
 * under the pointer must not strand focus on `body`.
 *
 * ── Mobile ────────────────────────────────────────────────────────────────
 *
 * Below `sm` the trailing slot wraps onto its own line under the body
 * (`basis-full` on the trailing wrapper, in a `flex-wrap` row) and the title
 * line-clamps to two lines instead of `Row`'s single-line truncate — an
 * attention item cut to one line at 390px is an item that cannot be judged.
 * From `sm` up both revert to the plain `Row` rhythm.
 *
 * Zero items renders nothing — the caller shows the empty state. Items
 * render in the order given.
 */

import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Icon, Row, StatusBadge } from '@haven_ai/ui'

export type AttentionTone = 'neutral' | 'brand' | 'warning' | 'danger'

export interface AttentionListItem {
  /** Stable id — handed back through `onDismiss`. */
  id: string
  title: string
  subtitle?: string
  tone: AttentionTone
  /**
   * `StatusBadge` label — the tone in text (`"Budget reached"`, `"Failed"`).
   * Without it, an `sr-only` tone word carries the tone instead.
   */
  badge?: string
  /** Leading icon; renders in the row's tone-tinted circle. `aria-hidden` there — see the tone rule above. */
  icon?: LucideIcon
  /** The caller's action — a button or link, rendered in `trailing` before the dismiss. */
  action?: ReactNode
}

/** The `sr-only` tone words, for items without a badge label. */
const TONE_TEXT: Record<AttentionTone, string> = {
  neutral: 'Informational',
  brand: 'Suggestion',
  warning: 'Warning',
  danger: 'Failure',
}

export function AttentionList({
  items,
  onDismiss,
  headingId,
  className = '',
}: {
  items: AttentionListItem[]
  onDismiss: (id: string) => void
  /**
   * DOM id of the caller's list heading. When a dismiss empties the list,
   * focus moves there — the caller owns the heading and the empty state.
   */
  headingId?: string
  className?: string
}) {
  const listRef = useRef<HTMLUListElement | null>(null)
  // Set at click time, consumed after the caller's re-render has removed the
  // item — focusing a still-mounted row would strand focus on a departing node.
  const pendingFocusIndex = useRef<number | null>(null)

  useEffect(() => {
    if (pendingFocusIndex.current === null) return
    const index = pendingFocusIndex.current
    pendingFocusIndex.current = null
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('[data-attention-dismiss]')
    if (buttons && buttons.length > 0) {
      buttons[Math.min(index, buttons.length - 1)]?.focus()
    } else if (headingId) {
      document.getElementById(headingId)?.focus()
    }
  }, [items, headingId])

  if (items.length === 0) return null

  const handleDismiss = (index: number) => {
    pendingFocusIndex.current = index
    onDismiss(items[index].id)
  }

  return (
    <ul ref={listRef} className={`space-y-1 ${className}`.trim()}>
      {items.map((item, index) => (
        <li key={item.id}>
          <Row
            leading={item.icon ? <Icon icon={item.icon} className="h-4 w-4" /> : undefined}
            leadingTone={item.icon ? item.tone : undefined}
            title={item.title}
            subtitle={item.subtitle}
            titleClassName="whitespace-normal line-clamp-2 sm:whitespace-nowrap sm:line-clamp-none"
            trailingClassName="w-full basis-full self-start sm:w-auto sm:basis-auto sm:self-center"
            className="flex-wrap"
            trailing={
              <div className="flex items-center justify-end gap-2">
                {item.badge !== undefined ? (
                  <StatusBadge tone={item.tone}>{item.badge}</StatusBadge>
                ) : (
                  <span className="sr-only">{TONE_TEXT[item.tone]}</span>
                )}
                {item.action}
                <button
                  type="button"
                  data-attention-dismiss
                  data-testid={`attention-dismiss-${item.id}`}
                  aria-label={`Dismiss: ${item.title}`}
                  onClick={() => handleDismiss(index)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-surface-2)] hover:text-[var(--v2-ink)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                >
                  <Icon icon={X} className="h-4 w-4" />
                </button>
              </div>
            }
          />
        </li>
      ))}
    </ul>
  )
}
