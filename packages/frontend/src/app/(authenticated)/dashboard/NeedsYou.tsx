'use client'

/**
 * The dashboard's "Needs attention" card (#3808; "Needs you" until #3902) —
 * the wired AttentionSection.
 *
 * The OLD panel rendered only when the overview failed to load. This one
 * renders the real conditions: `computeAttentionItems` (#3808, one
 * definition shared with #3809 and #3818) produces the items, and #3805's
 * `AttentionList` renders them. What this component owns is presentation
 * only:
 *
 * - The load-error row stays at the top when the overview failed, exactly as
 *   before — rail-independent, and it coexists with items from the last good
 *   data.
 * - A neutral count badge sits BESIDE the heading (#3902), never inside the
 *   `<h2>`, so the heading's accessible name stays exactly "Needs attention".
 *   It counts every rule item, including those behind "Show N more", and
 *   nothing else (not the guide, the "You're set up" line or the error row).
 *   Neutral, not the mockup's warning tint: the card holds neutral items too.
 * - The rows run full-bleed with dividers (#3902); the error row, the guide
 *   and "Show N more" keep their own inset.
 * - More than four items collapse behind a "Show N more" button whose
 *   accessible name states the count.
 * - With no items the card says only what was measured (#3902):
 *   `attentionEmptyState` in the rules layer decides between the
 *   "You're all caught up" achievement (title only since #3908, still gated
 *   on measured facts), a neutral line that claims nothing, and — while the
 *   budget reads load — nothing at all.
 * - Dismissal is handed back to the caller (`onDismiss`) — #3813 and #4324
 *   own persistence: "No backup signer" (per account) and "Needs setup"
 *   (per agent) write permanent server-saved dismissals; the budget, scope,
 *   sponsorship and failure items write ACKNOWLEDGEMENTS that last until
 *   something new happens. Which kinds are dismissible comes from the
 *   rules layer (`DISMISSIBLE_ATTENTION_KINDS`); low balance and zero USDC
 *   are not.
 *
 * Every row action is a real `Button` (never a nested link), so the list is
 * fully keyboard-operable: rows are static, and the action + dismiss
 * controls are focusable buttons.
 */

import { useState, type ReactNode } from 'react'
import {
  Bot,
  Check,
  CircleDollarSign,
  Coins,
  Gauge,
  ShieldAlert,
  CirclePause,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { StatusBadge } from '@haven_ai/ui'
import { AttentionList } from '@/components/haven/AttentionList'
import type { AttentionListItem } from '@/components/haven/AttentionList'
import {
  DISMISSIBLE_ATTENTION_KINDS,
  type AttentionEmptyState,
  type AttentionRuleItem,
} from '@/lib/dashboard-attention'

/** Items shown before the "Show N more" collapse. */
const MAX_VISIBLE_ITEMS = 4

const KIND_ICON: Record<AttentionRuleItem['kind'], LucideIcon> = {
  'needs-setup': Bot,
  'low-balance': Coins,
  'zero-usdc': Coins,
  'budget-reached': Gauge,
  'budget-usage': Gauge,
  'budget-scope': CircleDollarSign,
  'haven-paused': CirclePause,
  'payments-failed': TriangleAlert,
  'no-backup': ShieldAlert,
}

function itemAction(
  item: AttentionRuleItem,
  onAddFunds?: (accountId: string) => void,
): AttentionListItem['action'] {
  if (!item.actionLabel) return undefined
  // "Add funds" targets a specific account — the caller opens its modal
  // pre-selected, so the button carries the account through the callback
  // instead of a route.
  if (
    (item.kind === 'low-balance' || item.kind === 'zero-usdc') &&
    item.accountId &&
    onAddFunds
  ) {
    const accountId = item.accountId
    return (
      <Button variant="ghost" size="sm" onClick={() => onAddFunds(accountId)}>
        {item.actionLabel}
      </Button>
    )
  }
  if (item.href) {
    return (
      <Button variant="ghost" size="sm" href={item.href}>
        {item.actionLabel}
      </Button>
    )
  }
  return undefined
}

export default function NeedsYou({
  items,
  hasOverviewError,
  onRetry,
  onDismiss,
  onAddFunds,
  headingId = 'needs-attention-heading',
  title = 'Needs attention',
  titleMeta = null,
  titleAction = null,
  showCount = true,
  emptyState = null,
  guide = null,
}: {
  items: AttentionRuleItem[]
  hasOverviewError: boolean
  onRetry: () => void
  /**
   * Called with the FULL rule item (not just its id) — the caller owns what a
   * dismissal means per kind (#3813: "no-backup" → per-account server-saved
   * dismissal, "needs-setup" → per-agent; everything else → session-only).
   */
  onDismiss: (item: AttentionRuleItem) => void
  /** Opens the Add-funds modal pre-selected to this account. */
  onAddFunds?: (accountId: string) => void
  headingId?: string
  /** The card's heading — "Get started" while the first-run guide is the card (#3818). */
  title?: string
  /**
   * #3897: right side of the header row — the guide's progress and "Hide for
   * now" while it is the card, as the mockup draws it.
   */
  titleAction?: ReactNode
  /** #3897: muted text beside the heading — the guide's "N of 3 done". */
  titleMeta?: ReactNode
  /**
   * #3902: the count badge beside the heading. Off while the card is "Get
   * started" — its header already says "N of 3 done".
   */
  showCount?: boolean
  /**
   * #3902: what the card says with no items, from `attentionEmptyState`.
   * `null` (no overview yet) renders nothing, the same as `pending`.
   */
  emptyState?: AttentionEmptyState | null
  /**
   * #3818: the first-run steps (or the "You're set up" line). While setup is
   * in progress the guide IS this card: it renders first, and the rule items
   * that still apply list below it.
   */
  guide?: ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  const hiddenCount = Math.max(items.length - MAX_VISIBLE_ITEMS, 0)
  const visibleItems = expanded ? items : items.slice(0, MAX_VISIBLE_ITEMS)

  const listItems: AttentionListItem[] = visibleItems.map((item) => ({
    id: item.id,
    title: item.title,
    subtitle: item.subtitle,
    tone: item.tone,
    badge: item.badge,
    icon: KIND_ICON[item.kind],
    action: itemAction(item, onAddFunds),
    // #3813: only the owner-approved kinds offer the control — the rules
    // layer is the one definition of which those are.
    dismissible: DISMISSIBLE_ATTENTION_KINDS.has(item.kind),
  }))

  const count = items.length
  const showEmpty = count === 0 && !hasOverviewError && !guide

  return (
    // #3910: a normal card like Agents and Activity — flat, the shared
    // `Card.Header` band, rows on the page background. The `anchor` tint used
    // to cover the body too, so a single row read as a second header (owner,
    // 2026-10-13); the mockup draws this card plain. `article` + the exact h2
    // name are what the first-run specs and DashboardClient tests find it by.
    <Card as="article" hover={false} className="overflow-hidden v2-animate-slide-in">
      {/* `children` + `padding="none"`: the `title` slot cannot carry the
          focus hand-off's id/tabIndex, and the default padding would grow
          the Get started header (its h-9 "Hide for now") by ~13px. */}
      <Card.Header padding="none" className="flex min-h-[3.25rem] items-center justify-between gap-3 px-5 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <h2 id={headingId} tabIndex={-1} className="text-sm font-semibold text-[var(--v2-ink)]">
            {title}
          </h2>
          {showCount && count > 0 ? (
            <StatusBadge tone="neutral" className="v2-tabular">
              {count}
              <span className="sr-only">{count === 1 ? ' item' : ' items'}</span>
            </StatusBadge>
          ) : null}
          {titleMeta}
        </div>
        {titleAction}
      </Card.Header>

      {hasOverviewError ? (
        <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-[var(--v2-danger)]">Dashboard data could not load</p>
            <p className="mt-1 text-sm text-[var(--v2-ink-2)]">
              Haven could not refresh balances, agents, and activity.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : null}

      {guide ? <div className="px-5 py-4">{guide}</div> : null}

      {/* Mounted at zero items too (it renders nothing then): the dismiss
          that empties the card must still run the list's focus hand-off to
          the heading — an unmounted list runs no effect, and focus would
          drop to <body> with the vanished X. */}
      <div className={count > 0 && (hasOverviewError || guide) ? 'border-t border-[var(--v2-border)]' : ''}>
        <AttentionList
          items={listItems}
          headingId={headingId}
          fullBleed
          onDismiss={(id) => {
            const item = items.find((candidate) => candidate.id === id)
            if (item) onDismiss(item)
          }}
        />
        {hiddenCount > 0 && !expanded ? (
          <div className="border-t border-[var(--v2-border)] px-5 py-3">
            {/* The accessible name states the count — "Show 3 more" says
                what the button reveals without sight of the list. */}
            <Button
              variant="tertiary"
              size="sm"
              aria-label={`Show ${hiddenCount} more items`}
              aria-expanded={expanded}
              onClick={() => setExpanded(true)}
            >
              Show {hiddenCount} more
            </Button>
          </div>
        ) : null}
      </div>

      {showEmpty && emptyState?.kind === 'caught-up' ? (
        // An unboxed success row on the attention rows' geometry (20px inset,
        // 32px icon centred in the row) — the mockup's clear
        // card. Not a dashed EmptyState tile: that is the "nothing here yet"
        // placeholder, and nested in this card it stacks a second surface
        // (#3902 design review).
        <div className="flex items-center gap-3 px-5 py-3">
          <span
            aria-hidden="true"
            className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[var(--v2-success-soft)] text-[var(--v2-success)]"
          >
            <Check className="h-4 w-4" />
          </span>
          <h3 className="min-w-0 text-sm font-semibold text-[var(--v2-ink)]">{emptyState.title}</h3>
        </div>
      ) : showEmpty && emptyState?.kind === 'quiet' ? (
        <p className="px-5 py-4 text-sm text-[var(--v2-ink-2)]">{emptyState.body}</p>
      ) : null}
    </Card>
  )
}
