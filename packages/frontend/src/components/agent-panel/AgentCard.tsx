'use client'

import { EllipsisVertical } from 'lucide-react'
import { useState } from 'react'
import Link from 'next/link'
import { ApprovalRequiredBanner } from '@/components/haven/ApprovalRequiredBanner'
import { AgentBudget, agentBadge, type DashboardAgent } from '@/components/haven/AgentRow'
import { LabelChipRow } from '@/components/haven/LabelChip'
import { Button } from '@/components/ui/Button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu'
import { Icon } from '@/components/ui/Icon'
import { Monogram } from '@/components/ui/Monogram'
import { Skeleton } from '@/components/ui/Skeleton'
import { StatusBadge, type StatusTone } from '@/components/ui/StatusBadge'
import { DELEGATION_BUDGET_CARD_ID } from '@/components/DelegationBudgetCard'
import { type Agent } from '@/hooks/useAgents'
import type { AgentBusyAction } from '@/hooks/useAgentPanelState'
import type { Organization } from '@/hooks/useOrganizations'
import { AGENT_PAUSED_BODY, AGENT_PAUSED_TITLE } from '@/lib/agent-pause-copy'
import { agentMerchantLabel } from '@/lib/agent-merchant-label'
import { DEFAULT_CHAIN_ID } from '@/lib/chains'
import {
  hasUsableBudget,
  type AttentionRuleItem,
  type DashboardBudgetRemaining,
} from '@/lib/dashboard-attention'
import { timeAgo } from '@/lib/format'
import {
  FINISH_REVOKING_LABEL,
  HALF_REVOKED_BODY,
  HALF_REVOKED_TITLE,
  HALF_REVOKED_UNLINKED_BODY,
  canFinishRevoking,
  isHalfRevoked,
} from '@/lib/half-revoked'
import { agentStatusPresentation } from '@/lib/payment-status'
import { STRANDED_FUNDS_TITLE, strandedFundsCause } from '@/lib/stranded-funds-copy'
import MoveAgentModal from '../MoveAgentModal'
import { RemoveAgentDialog } from './RemoveAgentDialog'
import { entityCardClassName } from '../ui/entityCardStyles'

/**
 * What the card reads from the dashboard's two reads (#4209). `GET /agents`
 * carries no used or remaining figures, so the panel joins
 * `useDashboardOverview` + `useBudgetRemaining` by agent id — the way
 * `AccountDetailClient` does — and hands each card its slice.
 */
export interface AgentCardDashboard {
  /**
   * False while the overview's first read, or the budget reads it captions
   * with, are still in flight. The card shows a skeleton then — never "No
   * budget" for an agent whose budget simply has not loaded yet.
   */
  ready: boolean
  /**
   * This agent's overview entry. `null` once ready means the overview has no
   * entry for it: revoked agents are not in it (`dashboard.ts` selects active,
   * paused and pending_approval), and a failed overview read has none.
   */
  agent: DashboardAgent | null
  budgetRemaining: DashboardBudgetRemaining | null
  attentionItems: AttentionRuleItem[]
  nowMs: number
}

/**
 * The card's one badge, only when the agent needs attention. The dashboard's
 * `agentBadge` decides it for every agent it covers, so the dashboard row and
 * this card badge one agent the same way; the two arms it does not cover —
 * Archived (`archived_at`) and Revoked (the shared status words) — come first.
 */
export function agentCardBadge(
  agent: Pick<Agent, 'status' | 'archived_at'>,
  dashboard: AgentCardDashboard,
): { label: string; tone: StatusTone } | null {
  if (agent.archived_at) return { label: 'Archived', tone: 'neutral' }
  if (agent.status === 'revoked') return agentStatusPresentation('revoked')
  if (!dashboard.ready || !dashboard.agent) return null
  return agentBadge(dashboard.agent, dashboard.attentionItems, dashboard.budgetRemaining)
}

/**
 * The footer's one line. "Last paid 20h ago · api.bitrefill.com" when the
 * agent has paid (the merchant label never prints an address); "Connected
 * 2h ago" when it never paid but has connected; "No payments yet", the
 * dashboard's words, otherwise. Null when there is nothing true to say: an
 * agent the overview does not cover (revoked) has unknown payments, so it
 * never reads "No payments yet".
 */
export function agentCardFooter(
  agent: Pick<Agent, 'mcp_last_seen_at'>,
  dashboard: AgentCardDashboard,
): string | null {
  const stats = dashboard.agent?.stats ?? null
  if (stats?.lastPaymentAt) {
    const merchant = agentMerchantLabel(stats.lastCounterparty)
    const paid = `Last paid ${timeAgo(stats.lastPaymentAt)}`
    return merchant ? `${paid} · ${merchant}` : paid
  }
  if (agent.mcp_last_seen_at) return `Connected ${timeAgo(agent.mcp_last_seen_at)}`
  return dashboard.agent ? 'No payments yet' : null
}

const MENU_TRIGGER_CLASS =
  'inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-[var(--v2-ink-3)] transition-colors hover:bg-[var(--v2-surface-hover)] hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 disabled:cursor-not-allowed disabled:opacity-50'

const BUSY_LABEL: Record<NonNullable<AgentBusyAction>, string> = {
  pause: 'Pausing…',
  resume: 'Resuming…',
  archive: 'Removing…',
  restore: 'Restoring…',
}

export function AgentCard({
  agent,
  dashboard,
  showAccountName = false,
  onPause,
  onResume,
  onRevokeCredential,
  onArchive,
  onRestore,
  onMoveToOrganization,
  onBudgetEnded,
  busyAction,
  chainId = DEFAULT_CHAIN_ID,
  organizations = [],
}: {
  agent: Agent
  dashboard: AgentCardDashboard
  /** #3719: the account name prints only when the user has two or more. */
  showAccountName?: boolean
  onPause: (agent: Agent) => void
  onResume: (agent: Agent) => void
  /** RemoveAgentDialog step 2: plain POST /agents/:id/revoke, throws on failure. */
  onRevokeCredential: (agentId: string) => Promise<void>
  /** RemoveAgentDialog step 3: archive (#1401), throws on failure. */
  onArchive: (agent: Agent) => Promise<void>
  onRestore: (agent: Agent) => void
  /** #3164: the card hosts the Move modal; this delivers the saved agent back. */
  onMoveToOrganization: (agent: Agent) => void
  /**
   * #3542: called once Finish revoking (or Remove) has ended the agent's budget,
   * so the owner of the agent list can clear the half-revoked marker.
   */
  onBudgetEnded?: (agentId: string) => void
  busyAction: AgentBusyAction
  chainId?: number
  /** #3164: the user's organization tree, for the card's Move picker. */
  organizations?: Organization[]
}) {
  // #3717: pause is one click everywhere, so it is a plain menu item — no
  // confirmation; the paused banner says what it did.
  const [removeModalOpen, setRemoveModalOpen] = useState(false)
  // #3542: the same dialog in its finish mode — ends the remaining budget of an
  // agent that is already revoked or archived, and moves nothing.
  const [finishModalOpen, setFinishModalOpen] = useState(false)
  const [moveModalOpen, setMoveModalOpen] = useState(false)

  const isActive = agent.status === 'active'
  const isPaused = agent.status === 'paused'
  const isPending = agent.status === 'pending_approval'
  const isRevoked = agent.status === 'revoked'
  const isArchived = Boolean(agent.archived_at)
  const isOperational = !isRevoked && !isArchived
  const isBusy = busyAction !== null
  const halfRevoked = isHalfRevoked(agent)
  const canFinish = canFinishRevoking(agent)

  const badge = agentCardBadge(agent, dashboard)
  const footer = agentCardFooter(agent, dashboard)
  const budgetHref = `/agents/${agent.id}#${DELEGATION_BUDGET_CARD_ID}`
  const needsBudget =
    isActive && dashboard.ready && dashboard.agent !== null && !hasUsableBudget(dashboard.agent)

  // ONE call to action, the step this agent needs next (#4209). Finishing a
  // revocation ends live spend authority, so it outranks everything; stranded
  // funds come next because they are the owner's money sitting outside the
  // account. Everything else lives in the ⋯ menu.
  const cta = canFinish ? (
    <Button
      size="sm"
      onClick={() => setFinishModalOpen(true)}
      disabled={isBusy}
      aria-label={`${FINISH_REVOKING_LABEL} ${agent.name}`}
    >
      {FINISH_REVOKING_LABEL}
    </Button>
  ) : agent.has_stranded_funds ? (
    // The list knows only THAT funds are stranded (`has_stranded_funds` is
    // an EXISTS), not how many payments, so the count-aware "Review the N
    // payments" label (`reviewStrandedPaymentsLabel`) cannot be honest here.
    // The card names the agent page's own action instead and goes there.
    <Button size="sm" href={`/agents/${agent.id}`}>
      Recover funds
    </Button>
  ) : isPending ? (
    <Button size="sm" href={budgetHref}>
      Finish setup
    </Button>
  ) : needsBudget ? (
    <Button size="sm" href={budgetHref}>
      Set budget
    </Button>
  ) : null

  const menuItems: Array<{ key: string; label: string; onSelect: () => void; danger?: boolean } | 'separator'> = []
  if (isOperational) {
    if (isActive) menuItems.push({ key: 'pause', label: 'Pause payments', onSelect: () => onPause(agent) })
    if (isPaused) menuItems.push({ key: 'resume', label: 'Resume payments', onSelect: () => onResume(agent) })
    // #3222: Move only when there is somewhere to move to.
    if (organizations.length > 0) {
      menuItems.push({ key: 'move', label: 'Move to organization', onSelect: () => setMoveModalOpen(true) })
    }
    if (menuItems.length > 0) menuItems.push('separator')
    // #1402: Remove stops the live delegation and archives the credential.
    menuItems.push({ key: 'remove', label: 'Remove', onSelect: () => setRemoveModalOpen(true), danger: true })
  } else if (isArchived) {
    menuItems.push({ key: 'restore', label: 'Restore to list', onSelect: () => onRestore(agent) })
  } else {
    menuItems.push({ key: 'remove', label: 'Remove from list', onSelect: () => setRemoveModalOpen(true) })
  }

  return (
    <>
    <div
      data-testid="agent-card"
      // #4209: a column, so the footer can sit on `mt-auto` and line up across
      // a grid row (the panel's grid stretches cards to the tallest). An open
      // ⋯ menu lifts its card above the next one, which the panel would
      // otherwise paint over it.
      className={`${entityCardClassName({ muted: isRevoked || isArchived, linked: true })} flex min-w-0 flex-col has-[[aria-expanded=true]]:z-[var(--v2-z-content)]`}
    >
      <div className="flex items-start gap-3">
        <Monogram name={agent.name} size="sm" decorative />
        <div className="min-w-0 flex-1">
          {/* #2237: the title row wraps, so a long name never pays for the
              badge — the badge drops under it instead. */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <h3 className="min-w-0 max-w-full truncate text-sm font-semibold text-[var(--v2-ink)]">
              <Link
                href={`/agents/${agent.id}`}
                className="block min-w-0 truncate rounded-sm after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
              >
                {agent.name}
              </Link>
            </h3>
            {badge ? (
              <span data-testid="agent-status-chip" className="inline-flex">
                <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
              </span>
            ) : null}
          </div>
          {showAccountName && agent.account_name ? (
            <p className="mt-0.5 truncate text-xs text-[var(--v2-ink-3)]">{agent.account_name}</p>
          ) : null}
          {/* #3167: up to three labels, then "+N". Rendered only when labels
              exist (#3197), so an unlabelled card gains no gap. */}
          {agent.labels.length > 0 && (
            <div data-testid="agent-card-labels" className="relative z-[var(--v2-z-content)] mt-1.5">
              <LabelChipRow labels={agent.labels} />
            </div>
          )}
        </div>
        {/* A sibling control raised above the stretched name link
            (`design-system.md` § Cards), so it opens the menu, not the page. */}
        <div className="relative z-[var(--v2-z-content)] -mr-2 -mt-2 flex items-center gap-1">
          <span role="status" className="sr-only">
            {busyAction ? BUSY_LABEL[busyAction] : ''}
          </span>
          {busyAction ? (
            <span aria-hidden="true" className="text-xs text-[var(--v2-ink-3)]">
              {BUSY_LABEL[busyAction]}
            </span>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={`Actions for ${agent.name}`}
              disabled={isBusy}
              className={MENU_TRIGGER_CLASS}
            >
              <Icon icon={EllipsisVertical} className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              {menuItems.map((item, index) =>
                item === 'separator' ? (
                  <DropdownMenuSeparator key={`separator-${index}`} />
                ) : (
                  <DropdownMenuItem
                    key={item.key}
                    onSelect={item.onSelect}
                    tone={item.danger ? 'danger' : 'default'}
                  >
                    {item.label}
                  </DropdownMenuItem>
                ),
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="mt-3 space-y-3">
        {isOperational ? (
          !dashboard.ready ? (
            <div data-testid="agent-card-budget-loading" aria-hidden="true" className="space-y-2 pt-1">
              <Skeleton className="h-1.5 w-full rounded-full" />
              <Skeleton variant="text" className="h-2.5 w-40" />
            </div>
          ) : dashboard.agent ? (
            // The dashboard row's own budget block (#4096): the same meter and
            // caption, "+N budgets", the received-sub-budget line and "No
            // budget" — nothing re-composed here.
            <div data-testid="agent-card-budget">
              <AgentBudget
                agent={dashboard.agent}
                budgetRemaining={dashboard.budgetRemaining}
                nowMs={dashboard.nowMs}
              />
            </div>
          ) : (
            // The overview failed or has no entry: usage is unknown — an em
            // dash, never a meter and never "No budget" (#1846).
            <p data-testid="agent-card-budget" className="text-xs text-[var(--v2-ink-3)]">—</p>
          )
        ) : null}

        {/* #2230 / #3717: the paused copy is the detail page's banner, shared. */}
        {isPaused && (
          <ApprovalRequiredBanner title={AGENT_PAUSED_TITLE} tone="neutral" density="compact">
            {AGENT_PAUSED_BODY}
          </ApprovalRequiredBanner>
        )}

        {agent.has_stranded_funds && (
          <ApprovalRequiredBanner title={STRANDED_FUNDS_TITLE} tone="warning" density="compact">
            {/* #2195: the shared title and cause clause. The count is `null`:
                `has_stranded_funds` is an EXISTS, so the card knows the state
                and not its size; the agent page holds the list. */}
            <span>{strandedFundsCause(null)} Open the agent to recover these funds.</span>
          </ApprovalRequiredBanner>
        )}

        {/* #3542: revoked or removed, yet a budget is still redeemable
            on-chain — the one place the card says so. */}
        {halfRevoked && (
          <div data-testid="half-revoked-marker">
            <ApprovalRequiredBanner title={HALF_REVOKED_TITLE} tone="warning" density="compact">
              {canFinish ? HALF_REVOKED_BODY : HALF_REVOKED_UNLINKED_BODY}
            </ApprovalRequiredBanner>
          </div>
        )}

        {/* Revoked and archived cards draw no meter — the overview does not
            cover revoked agents, and #1846 forbids a meter when usage is not
            known — so they say why instead. */}
        {isRevoked && !isArchived && !halfRevoked ? (
          <p className="text-xs text-[var(--v2-ink-3)]">Network access already revoked</p>
        ) : null}
        {isArchived ? (
          <p className="text-xs text-[var(--v2-ink-3)]">
            {halfRevoked
              ? 'Restoring to the list does not end its budget'
              : 'History stays readable; restoring never re-enables spending'}
          </p>
        ) : null}

        {cta ? (
          <div data-testid="agent-card-cta" className="relative z-[var(--v2-z-content)] flex">
            {cta}
          </div>
        ) : null}
      </div>

      {/* #4209 (owner decision 2026-10-21, reversing #2237's `items-start`):
          the footer is pinned with `mt-auto`, so in a row stretched to its
          tallest card every footer sits on the same line, as on `/accounts`.
          #2237 had kept cards at their own height so one wrapping title did
          not pad its neighbour; a footer that lines up across the row is now
          the rule, and the spare space sits above the divider. */}
      <div
        data-testid="agent-card-footer"
        className="mt-auto pt-4"
      >
        {/* One 16px line in every state — loading, empty and filled — so a
            footer with nothing true to say still lines up with its row. */}
        <div className="flex h-4 items-center border-t border-[var(--v2-border)] pt-3 text-xs leading-4 text-[var(--v2-ink-3)] box-content">
          {!dashboard.ready ? (
            <Skeleton variant="text" className="h-2.5 w-32" />
          ) : footer ? (
            <p className="min-w-0 truncate v2-tabular">{footer}</p>
          ) : null}
        </div>
      </div>
    </div>

    {/* Mounted only while open: its hooks (budget prepare, delegate-balance
        read) are per-agent and must not run for every card in the list. */}
    {removeModalOpen && (
      <RemoveAgentDialog
        agent={agent}
        chainId={chainId}
        onRevokeCredential={() => onRevokeCredential(agent.id)}
        onArchive={() => onArchive(agent)}
        onBudgetEnded={() => onBudgetEnded?.(agent.id)}
        onClose={() => setRemoveModalOpen(false)}
      />
    )}

    {finishModalOpen && (
      <RemoveAgentDialog
        agent={agent}
        chainId={chainId}
        mode="finish"
        onRevokeCredential={() => onRevokeCredential(agent.id)}
        onArchive={() => onArchive(agent)}
        onBudgetEnded={() => onBudgetEnded?.(agent.id)}
        onClose={() => setFinishModalOpen(false)}
      />
    )}

    {/* #3164: the org picker for THIS agent, mounted only while open. */}
    {moveModalOpen && (
      <MoveAgentModal
        open={moveModalOpen}
        onClose={() => setMoveModalOpen(false)}
        agent={agent}
        organizations={organizations}
        onMoved={onMoveToOrganization}
      />
    )}
    </>
  )
}
