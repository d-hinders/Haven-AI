'use client'

/**
 * The shared agent row (#4096, epic #4093) — lifted verbatim out of the
 * dashboard's `AgentsSection.tsx`, where it had been private since #3809.
 * The account page's Agents tab draws agents EXACTLY as the dashboard does —
 * the BudgetMeter, the "refills in 48m" caption, the "Last paid" line — and
 * a page-local copy would drift from this one the first time either changed.
 *
 * The props are the dashboard-overview wire shapes (`DashboardOverview['agents'][number]`,
 * `DashboardBudgetRemaining`) rather than narrowed
 * summaries: the account page reads the SAME dashboard overview (it lists
 * all agents, so it filters by `agent.accountId`) and passes its slices
 * straight through. Narrowing the props would have invented a second
 * projection of the wire for the caption pipeline to re-derive from.
 *
 * `AgentBudget` is exported beside `AgentRow` because it is the row's whole
 * budget block — the meter, the em dash, the received-sub-budget line — and
 * a caller that wants the budget figures without the row chrome (the
 * account page's overview strip) should reuse it, not re-render the caption.
 */

import Link from 'next/link'
import { Fragment, type ReactNode } from 'react'
import { Bot, ChevronRight } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { StatusBadge, type StatusTone } from '@/components/ui/StatusBadge'
import { BudgetMeter } from './BudgetMeter'
import type { AttentionRuleItem, DashboardBudgetRemaining, DashboardOverview } from '@/lib/dashboard-attention'
import { agentUsedPercent, hasPositiveCap } from '@/lib/dashboard-attention'
import { receivedBudgetLine } from '@/lib/agent-budget'
import {
  budgetCaption,
  selectPrimaryBudgets,
  type BudgetCaptionRow,
} from '@/lib/budget-caption'
import { timeAgo } from '@/lib/format'
import { AGENT_PAUSED_SHORT } from '@/lib/agent-pause-copy'

export type DashboardAgent = DashboardOverview['agents'][number]

/** The user's display currency, as the #3803 spend keys are spelled. */
export type DashboardCurrency = 'USD' | 'EUR' | 'SEK'

export const CURRENCY_KEY: Record<DashboardCurrency, 'usd' | 'eur' | 'sek'> = {
  USD: 'usd',
  EUR: 'eur',
  SEK: 'sek',
}

/**
 * The row's badge — only when something is off, and the same three states
 * the dashboard section names: "Needs setup" (the shared rules' needs-setup
 * items, `lib/dashboard-attention.ts`), "Paused", or "N% used" (#3808's ≥90%
 * arm — read through the SAME `agentUsedPercent` the "Needs attention" item
 * fires on, so the badge and the item cannot disagree).
 */
export function agentBadge(
  agent: DashboardAgent,
  attentionItems: AttentionRuleItem[],
  budgetRemaining: DashboardBudgetRemaining | null,
): { label: string; tone: StatusTone } | null {
  if (attentionItems.some((item) => item.kind === 'needs-setup' && item.agentId === agent.id)) {
    return { label: 'Needs setup', tone: 'brand' }
  }
  if (agent.status === 'paused') {
    return { label: 'Paused', tone: 'warning' }
  }
  const pct = agentUsedPercent(agent.id, budgetRemaining)
  if (pct !== null && pct >= 90) {
    const rounded = Math.round(Math.min(100, Math.max(0, pct)))
    return { label: `${rounded}% used`, tone: 'neutral' }
  }
  return null
}

function budgetRemainingEntry(
  agentId: string,
  budget: DashboardAgent['budgets'][number],
  budgetRemaining: DashboardBudgetRemaining | null,
) {
  return budgetRemaining?.budgets.find(
    (entry) =>
      entry.agent_id === agentId &&
      entry.chain_id === budget.chainId &&
      entry.delegation_hash === budget.delegationHash &&
      entry.token_address.toLowerCase() === budget.tokenAddress.toLowerCase(),
  )
}

function toCaptionRow(
  agentId: string,
  budget: DashboardAgent['budgets'][number],
  budgetRemaining: DashboardBudgetRemaining | null,
): BudgetCaptionRow {
  const entry = budgetRemainingEntry(agentId, budget, budgetRemaining)
  return {
    token: budget.tokenAddress,
    recipient: null,
    startSec: Math.floor(new Date(budget.startDate).getTime() / 1000),
    periodSeconds: budget.periodSeconds,
    expiresSec: Math.floor(new Date(budget.expiresAt).getTime() / 1000),
    budgetAtomic: budget.budgetAtomic,
    // No matching read = no figure exists (never 0); `remaining_from_chain`
    // false = a failed read. Both render as unknown — see `budgetCaption`.
    usedAtomic: entry?.used_atomic ?? null,
    readFromChain: entry?.remaining_from_chain ?? false,
    periodEndMs: entry ? new Date(entry.period_end).getTime() : new Date(budget.periodEnd).getTime(),
    createdMs: null,
    symbol: budget.tokenSymbol,
    chainId: budget.chainId,
  }
}

/**
 * #3988: the received-budget line is OWNED by `lib/agent-budget.ts` — the
 * one copy every budget-authority display reads, alongside the zero-cap
 * rule. (The dashboard wire is camelCase; `receivedBudgetLine` accepts it.)
 */

/**
 * The row's budget block: the meter captioned through #3806, or the em dash
 * when no read is known, or the received-sub-budget / no-budget line.
 */
export function AgentBudget({
  agent,
  budgetRemaining,
  nowMs,
  trailing,
}: {
  agent: DashboardAgent
  budgetRemaining: DashboardBudgetRemaining | null
  nowMs: number
  /** The row's "Last paid …" node, right-aligned on the caption line (#3989). */
  trailing?: ReactNode
}) {
  // A zero cap is no authority (#3802's rule): it reads "No budget", never a
  // meter captioned "≈$0.00 of $0.00 used" (#3897 item 8 — the exact string
  // reported on dev, and what a zero-cap row renders through the caption).
  const rows = agent.budgets
    .filter((budget) => hasPositiveCap(budget.budgetAtomic))
    .map((budget) => toCaptionRow(agent.id, budget, budgetRemaining))
  const selected = selectPrimaryBudgets(rows, nowMs)

  if (!selected) {
    // The overview's budgets array carries only live budgets (#3802/#3803), so
    // this is the no-authority state — except that an open RECEIVED
    // sub-budget is real authority and must never read "No budget" (#3803).
    // The row's "Last paid" node rides on the same line, right-aligned
    // (#3989): rows without a bar keep the time on the line they have.
    const subBudgetLine = receivedBudgetLine(agent.receivedSubBudgets)
    return (
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-3">
        <p className="text-xs text-[var(--v2-ink-3)]">{subBudgetLine ?? 'No budget'}</p>
        {trailing}
      </div>
    )
  }

  // #3908: the compact row wording, as the mockup draws it — the period word
  // in place of "used this period"; every other surface keeps the full one.
  // No rate (#4165, owner decision 2026-10-20 on #4093): a budget reads in
  // its own token wherever one is set — "1.20 of 3.00 USDC" — matching the
  // account page's "3.00 USDC per day", never a converted "≈$1.20 of $3.00".
  const caption = budgetCaption(selected.primary, { nowMs, style: 'row' })

  if (caption.kind !== 'meter') {
    // Unknown remaining, a failed read, a read past its period — an em dash,
    // never a 0% bar and never the full budget stated as fact. The dash sits
    // on the same line as the row's time node, so it drops to `text-xs` —
    // the two then share one baseline (#3989).
    return (
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-3 text-xs text-[var(--v2-ink-3)]">
        <p>—</p>
        {trailing}
      </div>
    )
  }

  // The extra-budget count rides in the caption line (#3908, the mockup's
  // place for it) — a sibling of the bar, never inside its ARIA name.
  const extra =
    selected.extraCount > 0
      ? ` · +${selected.extraCount} ${selected.extraCount === 1 ? 'budget' : 'budgets'}`
      : ''
  // Each "·" segment after the amounts stays whole (#3908 design review): a
  // narrow row may wrap the caption, but only at a separator — never between
  // "refills in" and "22h", which would strand a time apart from its verb.
  // The amounts segment may wrap at its own spaces ("… of …"): it is the
  // widest, and a large SEK budget kept whole would overflow a 390px row.
  // Each figure is still unbroken — the currency formats separate digits
  // and symbol with no-break spaces, and token mode joins the cap and its
  // symbol with one too (#3910).
  const segments = `${caption.caption}${extra}`.split(' · ')
  return (
    <div className="mt-1.5">
      <BudgetMeter
        usedPercent={caption.usedPercent}
        label={caption.label}
        trailing={trailing}
        caption={segments.map((segment, index) => (
          <Fragment key={index}>
            {index > 0 ? ' · ' : null}
            <span className={index === 0 ? undefined : 'whitespace-nowrap'}>{segment}</span>
          </Fragment>
        ))}
      />
    </div>
  )
}

export function AgentRow({
  agent,
  budgetRemaining,
  attentionItems,
  accountNames,
  accountCount,
  nowMs,
}: {
  agent: DashboardAgent
  budgetRemaining: DashboardBudgetRemaining | null
  attentionItems: AttentionRuleItem[]
  accountNames: Record<string, string>
  accountCount: number
  nowMs: number
}) {
  const badge = agentBadge(agent, attentionItems, budgetRemaining)
  const accountName =
    (agent.accountId ? accountNames[agent.accountId] : undefined) ?? agent.accountName

  // #3989: the row's last-payment time, labelled "Last paid" (the owner's
  // decision — the value is `stats.lastPaymentAt`, not the agent page's
  // `mcp_last_seen_at` "Last activity", so "Active" would disagree with that
  // page). It rides on the budget's caption line, right-aligned, and moves to
  // `AgentBudget`'s `trailing` slot for rows WITH a bar. The visible label
  // replaces the old `sr-only` "Last payment" prefix, so the label is not
  // read twice. `whitespace-nowrap` keeps "Last paid" and its time together —
  // they wrap as ONE unit onto their own line, never split from each other.
  const hasLastPayment = agent.status !== 'pending_approval' && Boolean(agent.stats)
  const lastPayment = hasLastPayment ? (
    <p
      data-testid="agent-row-last-payment"
      className="ml-auto whitespace-nowrap text-xs text-[var(--v2-ink-3)]"
    >
      {agent.stats?.lastPaymentAt ? `Last paid ${timeAgo(agent.stats.lastPaymentAt)}` : 'No payments yet'}
    </p>
  ) : null

  return (
    // #3989: the bar and its caption line span the row at EVERY width — one
    // three-track grid, no time column and no `time` area. The last-payment
    // time lives on the caption line under the bar (through `AgentBudget`'s
    // `trailing` slot), styled like a transaction row's timestamp, so a 390px
    // row keeps its badge beside the name instead of wrapping under it.
    <Link
      href={`/agents/${agent.id}`}
      className="grid grid-cols-[2rem_minmax(0,1fr)_1rem] items-center gap-x-3 px-5 py-3.5 transition-colors hover:bg-[var(--v2-surface-hover)] [grid-template-areas:'icon_name_chev'_'icon_body_chev']"
    >
      {/* Robot mark matches the sidebar's "agents" icon so the dashboard and
          nav read as the same system (carried from the old section). */}
      <span aria-hidden="true" className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[var(--v2-brand-soft)] text-[var(--v2-brand)] [grid-area:icon]">
        <Icon icon={Bot} className="h-4 w-4" />
      </span>
      {/* flex-wrap (#3908): on a narrow row the badge drops under the name
          rather than squeezing the name to a few letters. */}
      <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-medium text-[var(--v2-ink)] [grid-area:name]">
        <span className="max-w-full truncate">{agent.name}</span>
        {badge && <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>}
      </p>
      <div className="min-w-0 [grid-area:body]">
        {accountCount > 1 && accountName && (
          <p className="mt-0.5 truncate text-xs text-[var(--v2-ink-3)]">{`From ${accountName}`}</p>
        )}
        <AgentBudget
          agent={agent}
          budgetRemaining={budgetRemaining}
          nowMs={nowMs}
          trailing={lastPayment}
        />
        {agent.status === 'paused' && (
          // The owner-approved pause wording, short form — the same module the
          // agent page's banner reads, so the two cannot drift. It stays BELOW
          // the caption line, so the "Last paid" time sits under the bar.
          <p className="mt-1 text-xs text-[var(--v2-ink-3)]">{AGENT_PAUSED_SHORT}</p>
        )}
      </div>
      <Icon icon={ChevronRight} className="h-4 w-4 flex-shrink-0 text-[var(--v2-ink-3)] [grid-area:chev]" />
    </Link>
  )
}
