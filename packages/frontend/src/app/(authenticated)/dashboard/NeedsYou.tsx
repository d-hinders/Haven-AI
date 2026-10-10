'use client'

/**
 * The dashboard's "Needs you" card (#3808) — the wired AttentionSection.
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
 * - More than four items collapse behind a "Show N more" button whose
 *   accessible name states the count.
 * - With no items and no error, one quiet line says nothing needs attention.
 * - Dismissal is handed back to the caller (`onDismiss`) — #3813 owns
 *   persistence: "No backup signer" (per account) and "Needs setup" (per
 *   agent) write server-saved dismissals; everything else stays
 *   session-only. Which kinds are dismissible comes from the rules layer
 *   (`DISMISSIBLE_ATTENTION_KINDS`).
 *
 * Every row action is a real `Button` (never a nested link), so the list is
 * fully keyboard-operable: rows are static, and the action + dismiss
 * controls are focusable buttons.
 */

import { useState } from 'react'
import {
  Bot,
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
import { AttentionList } from '@/components/haven/AttentionList'
import type { AttentionListItem } from '@/components/haven/AttentionList'
import { DISMISSIBLE_ATTENTION_KINDS, type AttentionRuleItem } from '@/lib/dashboard-attention'

/** Items shown before the "Show N more" collapse. */
const MAX_VISIBLE_ITEMS = 4

const KIND_ICON: Record<AttentionRuleItem['kind'], LucideIcon> = {
  'needs-setup': Bot,
  'low-balance': Coins,
  'zero-usdc': Coins,
  'budget-reached': Gauge,
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
  headingId = 'needs-you-heading',
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

  return (
    // Anchor elevation — the "Needs you" panel is the second-most important
    // surface on the dashboard after the balance hero (carried over from the
    // error-only AttentionSection this card replaces).
    <Card as="article" elevation="anchor" className="overflow-hidden v2-animate-slide-in">
      <div className="border-b border-[var(--v2-border)] px-5 py-4">
        <h2 id={headingId} tabIndex={-1} className="text-sm font-semibold text-[var(--v2-ink)]">
          Needs you
        </h2>
      </div>
      <div className="px-5 py-4">
        {hasOverviewError ? (
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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

        {items.length > 0 ? (
          <>
            <AttentionList
              items={listItems}
              headingId={headingId}
              onDismiss={(id) => {
                const item = items.find((candidate) => candidate.id === id)
                if (item) onDismiss(item)
              }}
            />
            {hiddenCount > 0 && !expanded ? (
              <div className="mt-3">
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
          </>
        ) : !hasOverviewError ? (
          <p className="text-sm text-[var(--v2-ink-2)]">
            Nothing needs your attention right now.
          </p>
        ) : null}
      </div>
    </Card>
  )
}
