'use client'

/**
 * The dashboard's agents section (#3809, epic #3801) — how much budget each
 * agent has used, in each budget's own period.
 *
 * Replaces the old `ConnectedAgentsSection` inside `DashboardClient.tsx`. The
 * green "Connected" badge every row wore is gone — a badge appears ONLY when
 * something is off: "Needs setup" (the shared rules' needs-setup items,
 * `lib/dashboard-attention.ts`), "Paused", or "N% used" (#3808's ≥90% arm —
 * read through the SAME `agentUsedPercent` the "Needs attention" item fires on, so
 * the badge and the item cannot disagree).
 *
 * Each row's meter is `BudgetMeter` captioned through `lib/budget-caption.ts`
 * (#3806): the primary of the agent's budgets — the one closest to running
 * out, per `selectPrimaryBudgets` — in the user's currency via #3803's
 * `spotRates`, plus a "+N budgets" count OUTSIDE the meter's ARIA name. A
 * budget with no known read renders an em dash, never a 0% bar; an agent
 * whose only authority is an open received sub-budget reads "Spends from
 * <parent>'s budget", never "No budget" (#3803). A paused agent keeps its
 * live meter — a pause stops only Haven-sent payments — and carries the
 * owner-approved pause wording from `lib/agent-pause-copy.ts` in its short
 * form, so the row cannot drift from the agent page.
 *
 * Order: two groups, attention first. The WITHIN-GROUP order is fixed ONCE —
 * a single anchor list sorted by 30-day spend (descending) that is computed
 * WITHOUT reading the attention classification, so whichever poll lands
 * first cannot choose it (#3871). Group membership is re-evaluated on every
 * render from the current badges: a poll that changes spend within a group
 * moves nothing; a row moves only when it crosses groups. And the rows do
 * not render until the budget reads have settled (`budgetRemainingReady`) —
 * the first rows render is already fully classified, so the DOM order cannot
 * depend on query timing. At most six rows render, then a
 * "View all N agents" link (N from #3803's `agentCount`). Zero agents keeps
 * the old empty state with "Connect agent".
 */

import Link from 'next/link'
import { Fragment, useMemo, useRef } from 'react'
import { Bot, ChevronRight } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { StatusBadge, type StatusTone } from '@/components/ui/StatusBadge'
import { BudgetMeter } from '@/components/haven'
import type { AttentionRuleItem, DashboardBudgetRemaining, DashboardOverview } from '@/lib/dashboard-attention'
import { agentUsedPercent, hasPositiveCap } from '@/lib/dashboard-attention'
import {
  budgetCaption,
  selectPrimaryBudgets,
  type BudgetCaptionRow,
  type BudgetRate,
} from '@/lib/budget-caption'
import { counterpartyLabel, type CounterpartyFields } from '@/lib/transaction-presentation'
import { timeAgo } from '@/lib/format'
import { AGENT_PAUSED_SHORT } from '@/lib/agent-pause-copy'

type DashboardAgent = DashboardOverview['agents'][number]

/** The user's display currency, as the #3803 spend keys are spelled. */
export type DashboardCurrency = 'USD' | 'EUR' | 'SEK'

const CURRENCY_KEY: Record<DashboardCurrency, 'usd' | 'eur' | 'sek'> = {
  USD: 'usd',
  EUR: 'eur',
  SEK: 'sek',
}

/** At most six rows, then the "View all N agents" link (owner-approved cap). */
const MAX_ROWS = 6

// ── The stable two-group order ──────────────────────────────────────────────

export interface GroupOrder {
  attention: string[]
  rest: string[]
}

/**
 * Fold the current agents into the stored anchor and the CURRENT attention
 * classification. The ANCHOR — the within-group order — is fixed on the
 * first call (`stored === null`) by 30-day spend, descending, and is
 * deliberately computed WITHOUT `isAttention`: the classification depends on
 * `budgetRemaining`/`attentionItems`, which resolve independently of the
 * overview, so an attention-keyed anchor would let query timing choose the
 * row order (#3871). Afterwards the stored relative order is kept: vanished
 * agents are dropped and newcomers are appended — never re-sorted, so a
 * poll that moves spend within a group moves no row.
 *
 * Returns the anchor to store AND the group order to render: the anchor is
 * partitioned by the current classification, so group membership is the only
 * thing that ever moves a row between the two lists.
 */
export function applyStableGroupOrder(
  stored: string[] | null,
  agents: DashboardAgent[],
  isAttention: (agent: DashboardAgent) => boolean,
  spend30: (agent: DashboardAgent) => number,
): { anchor: string[]; order: GroupOrder } {
  if (agents.length === 0) return { anchor: [], order: { attention: [], rest: [] } }
  const present = new Set(agents.map((agent) => agent.id))

  let anchor: string[]
  if (!stored) {
    const bySpend = (a: DashboardAgent, b: DashboardAgent) => spend30(b) - spend30(a)
    anchor = [...agents].sort(bySpend).map((agent) => agent.id)
  } else {
    anchor = stored.filter((id) => present.has(id))
    for (const agent of agents) {
      if (!anchor.includes(agent.id)) anchor.push(agent.id)
    }
  }

  const isAttentionById = (id: string) => isAttention(agents.find((agent) => agent.id === id)!)
  return {
    anchor,
    order: {
      attention: anchor.filter(isAttentionById),
      rest: anchor.filter((id) => !isAttentionById(id)),
    },
  }
}

// ── The badge ───────────────────────────────────────────────────────────────

/**
 * The row's badge — only when something is off, and the same three states the
 * section docblock names. The ≥90% badge reads the shared `agentUsedPercent`,
 * the exact function rule 3's arm fires on, so this badge and the "Needs attention"
 * item cannot disagree.
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

// ── The budget meter ────────────────────────────────────────────────────────

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

function receivedSubBudgetLine(agent: DashboardAgent): string | null {
  const open = (agent.receivedSubBudgets ?? []).filter((sub) => sub.open)
  if (open.length === 0) return null
  // Distinct parents; one reads "<parent>'s budget", several "<a> and <b>'s
  // budgets". The parent's own name carries the possessive's voice.
  const parents = [...new Set(open.map((sub) => sub.parentAgentName))]
  const subject = parents.join(' and ')
  return `Spends from ${subject}${parents.length > 1 ? "'s budgets" : "'s budget"}`
}

/**
 * The row's budget block: the meter captioned through #3806, or the em dash
 * when no read is known, or the received-sub-budget / no-budget line.
 */
function AgentBudget({
  agent,
  budgetRemaining,
  spotRates,
  currency,
  nowMs,
}: {
  agent: DashboardAgent
  budgetRemaining: DashboardBudgetRemaining | null
  spotRates: DashboardOverview['spotRates'] | undefined
  currency: DashboardCurrency
  nowMs: number
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
    const subBudgetLine = receivedSubBudgetLine(agent)
    return <p className="mt-1 text-xs text-[var(--v2-ink-3)]">{subBudgetLine ?? 'No budget'}</p>
  }

  const perToken = spotRates?.[selected.primary.symbol]
  const rate: BudgetRate | null =
    typeof perToken === 'number' && perToken > 0 ? { currency, perToken } : null
  // #3908: the compact row wording, as the mockup draws it — the period word
  // in place of "used this period"; every other surface keeps the full one.
  const caption = budgetCaption(selected.primary, { nowMs, rate, style: 'row' })

  if (caption.kind !== 'meter') {
    // Unknown remaining, a failed read, a read past its period — an em dash,
    // never a 0% bar and never the full budget stated as fact.
    return <p className="mt-1 text-sm text-[var(--v2-ink-3)]">—</p>
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

// ── The section ─────────────────────────────────────────────────────────────

export interface AgentsSectionProps {
  overview: DashboardOverview | null
  /** #3804's cached reads — the meters' used amounts and the ≥90% badge. */
  budgetRemaining: DashboardBudgetRemaining | null
  /**
   * Whether the budget-remaining read has SETTLED — resolved, or definitively
   * failed (`null` forever is not a steady state; a failed first load renders
   * the rows without the ≥90% badge). The badges — and through them the row
   * order — read it, so until it settles the section keeps its loading
   * skeleton: the first rows render is already fully classified, and the DOM
   * order cannot depend on poll timing (#3871).
   */
  budgetRemainingReady: boolean
  /** The shared "Needs attention" items (`lib/dashboard-attention.ts`) — the needs-setup badges' source. */
  attentionItems: AttentionRuleItem[]
  currency: DashboardCurrency
  /** accountId → display name, the same map the attention rules receive. */
  accountNames: Record<string, string>
  /** `useAgents` knows an agent exists even while the overview lags it. */
  hasAnyAgents: boolean
  loading: boolean
  unavailable: boolean
  onRetry: () => void
  onConnectAgent: () => void
  /**
   * The clock the budget captions render against (#3806 rule 1: the clock is
   * a parameter). Defaults to the render's `Date.now()`; tests and frozen
   * captures pass a fixed instant.
   */
  nowMs?: number
}

export function AgentsSection({
  overview,
  budgetRemaining,
  budgetRemainingReady,
  attentionItems,
  currency,
  accountNames,
  hasAnyAgents,
  loading,
  unavailable,
  onRetry,
  onConnectAgent,
  nowMs,
}: AgentsSectionProps) {
  const effectiveNowMs = nowMs ?? Date.now()
  const agents = overview?.agents ?? []
  const agentCount = overview?.agentCount
  const totalAgents = agentCount
    ? agentCount.active + agentCount.paused + agentCount.pending_approval
    : agents.length

  const anchorRef = useRef<string[] | null>(null)
  const orderedIds = useMemo(() => {
    if (agents.length === 0) {
      // A list that empties resets the anchor: the next load re-fixes the order.
      anchorRef.current = null
      return { attention: [], rest: [] }
    }
    if (budgetRemaining === null && !budgetRemainingReady) {
      // The classification the order reads is still in flight — anchor
      // nothing; the rows stay pending below (#3871).
      return { attention: [], rest: [] }
    }
    const attentionIds = new Set(
      agents
        .filter((agent) => agentBadge(agent, attentionItems, budgetRemaining) !== null)
        .map((agent) => agent.id),
    )
    const { anchor, order } = applyStableGroupOrder(
      anchorRef.current,
      agents,
      (agent) => attentionIds.has(agent.id),
      (agent) => agent.stats?.d30?.net?.[CURRENCY_KEY[currency]] ?? 0,
    )
    anchorRef.current = anchor
    return order
  }, [agents, attentionItems, budgetRemaining, budgetRemainingReady, currency])

  const byId = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents])
  const ordered = [...orderedIds.attention, ...orderedIds.rest]
    .map((id) => byId.get(id))
    .filter((agent): agent is DashboardAgent => agent !== undefined)
  const visible = ordered.slice(0, MAX_ROWS)
  // Rows need the badge inputs settled before they may render (#3871): the
  // same skeleton the overview's initial load shows, never a half-classified
  // frame that a later poll would reorder.
  const classificationPending =
    agents.length > 0 && budgetRemaining === null && !budgetRemainingReady

  return (
    <div className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-bg)] shadow-card overflow-hidden">
      <Card.Header
        as="h2"
        title="Agents"
        actions={
          <Link href="/agents" className="text-sm font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors">
            View all
          </Link>
        }
      />

      {(loading || classificationPending) ? (
        <div className="divide-y divide-[var(--v2-border)]" role="status" aria-busy="true" aria-live="polite" aria-label="Loading agents">
          {[0, 1, 2].map((item) => (
            <div key={item} className="flex items-center gap-3 px-5 h-[72px]">
              <div className="h-8 w-8 rounded-full bg-[var(--v2-surface-2)] animate-pulse" />
              <div className="min-w-0 flex-1">
                <div className="h-3.5 w-36 rounded bg-[var(--v2-surface-2)] animate-pulse" />
                <div className="mt-1.5 h-2.5 w-48 rounded bg-[var(--v2-surface-2)] animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      ) : unavailable ? (
        <div className="p-6">
          <EmptyState
            size="compact"
            title="Agent preview unavailable"
            body="Haven could not verify which agents are connected right now."
            action={<Button variant="ghost" size="sm" onClick={onRetry}>Try again</Button>}
          />
        </div>
      ) : agents.length === 0 ? (
        <div className="p-6">
          <EmptyState
            size="compact"
            title={hasAnyAgents ? 'No connected agents right now' : 'No agents connected yet'}
            body={
              hasAnyAgents
                ? 'Reconnect or create an agent to bring automated spending back online.'
                : 'Create your first agent to give it payment credentials and spend limits.'
            }
            action={
              <div className="flex items-center justify-center gap-3">
                <Button onClick={onConnectAgent} size="sm">
                  Connect agent
                </Button>
                <Link href="/agents" className="text-sm font-medium text-[var(--v2-brand)] hover:text-[var(--v2-brand-strong)] transition-colors">
                  Go to Agents
                </Link>
              </div>
            }
          />
        </div>
      ) : (
        <div className="divide-y divide-[var(--v2-border)] v2-animate-fade-in">
          {visible.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              budgetRemaining={budgetRemaining}
              attentionItems={attentionItems}
              spotRates={overview?.spotRates}
              currency={currency}
              accountNames={accountNames}
              accountCount={totalAccounts(overview)}
              nowMs={effectiveNowMs}
            />
          ))}
          {totalAgents > visible.length && (
            <Link
              href="/agents"
              className="block px-5 py-3 text-sm font-medium text-[var(--v2-brand)] hover:bg-[var(--v2-surface-hover)] transition-colors"
            >
              {`View all ${totalAgents} agents`}
            </Link>
          )}
        </div>
      )}
    </div>
  )
}

/** #3803: the account name shows only when the user has more than one account. */
function totalAccounts(overview: DashboardOverview | null): number {
  return overview?.accounts?.length ?? 0
}

function AgentRow({
  agent,
  budgetRemaining,
  attentionItems,
  spotRates,
  currency,
  accountNames,
  accountCount,
  nowMs,
}: {
  agent: DashboardAgent
  budgetRemaining: DashboardBudgetRemaining | null
  attentionItems: AttentionRuleItem[]
  spotRates: DashboardOverview['spotRates'] | undefined
  currency: DashboardCurrency
  accountNames: Record<string, string>
  accountCount: number
  nowMs: number
}) {
  const badge = agentBadge(agent, attentionItems, budgetRemaining)
  const accountName =
    (agent.accountId ? accountNames[agent.accountId] : undefined) ?? agent.accountName

  // #3810's naming: the counterparty through `counterpartyLabel`'s no-address
  // mode — a raw address can never surface. The backend resolved the name
  // (`merchantName`); there is no chain-scoped map client-side, so it rides
  // in as `resolvedName`, the same shim the activity rows use.
  const lastCounterparty = agent.stats?.lastCounterparty
  // `lastCounterparty` carries no activityType/agentName (it is a payment's
  // counterparty, not a row) — the fields the label can read are mapped, the
  // rest undefined, so the shim stays honest (same as the activity rows).
  const counterparty: CounterpartyFields | null = lastCounterparty
    ? {
        activityType: undefined,
        agentName: undefined,
        source: lastCounterparty.source ?? undefined,
        x402ResourceUrl: lastCounterparty.x402ResourceUrl ?? undefined,
        direction: 'out',
        to: lastCounterparty.to ?? '',
        from: lastCounterparty.to ?? '',
        chainId: agent.accountChainId ?? 0,
      }
    : null
  const counterpartyLabelValue = counterparty
    ? counterpartyLabel(counterparty, undefined, undefined, {
        noAddress: true,
        resolvedName: lastCounterparty?.merchantName,
      })
    : null

  const hasLastPaymentColumn = agent.status !== 'pending_approval' && Boolean(agent.stats)

  return (
    // #3910: one grid, two flows. Below `sm` the last-payment time sits on the
    // name line and the body (bar, caption, paused line) spans the row's full
    // width — a 390px paused row ran ~9 lines squeezed beside the column.
    // From `sm` the column spans both lines beside the body at ONE fixed width,
    // 10rem, in every row (#3912): each row is its own grid, so a
    // content-sized column (`fit-content(40%)`, #3910) gave every bar a
    // different length depending on its merchant. The merchant truncates and
    // carries its full name as a tooltip. Below `sm` the time-only column
    // stays content-sized. The column renders once.
    <Link
      href={`/agents/${agent.id}`}
      className={`grid grid-cols-[2rem_minmax(0,1fr)_fit-content(40%)_1rem] items-center sm:grid-cols-[2rem_minmax(0,1fr)_10rem_1rem] gap-x-3 px-5 py-3.5 transition-colors hover:bg-[var(--v2-surface-hover)] ${
        hasLastPaymentColumn
          ? // From `sm` the name line spans the row and the time column sits
            // beside the body only: with a fixed 10rem column, a name sharing
            // the 1fr track pushed a "92% used" badge under the name (#3912).
            "[grid-template-areas:'icon_name_time_chev'_'icon_body_body_chev'] sm:[grid-template-areas:'icon_name_name_chev'_'icon_body_time_chev']"
          : // No time cell (a setup row, or no stats): below `sm` the name and
            // body span the empty column and its gap, or the badge wraps at 390
            // (#3910 review). From `sm` the column is a fixed 10rem, so the
            // body stays out of it — or this row's bar would run 172px longer
            // than everyone else's (#3912). The name may still span it.
            "[grid-template-areas:'icon_name_name_chev'_'icon_body_body_chev'] sm:[grid-template-areas:'icon_name_name_chev'_'icon_body_._chev']"
      }`}
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
          spotRates={spotRates}
          currency={currency}
          nowMs={nowMs}
        />
        {agent.status === 'paused' && (
          // The owner-approved pause wording, short form — the same module the
          // agent page's banner reads, so the two cannot drift.
          <p className="mt-1 text-xs text-[var(--v2-ink-3)]">{AGENT_PAUSED_SHORT}</p>
        )}
      </div>
      {/* #3908: the last payment in a right-hand column, as the mockup draws
          it — the time on top, the merchant (never a raw address) under it.
          The merchant shows from `sm` only (#3910): at 390 it truncated to a
          few characters, and it stays on the agent page. A setup row has
          nothing to say here yet. */}
      {hasLastPaymentColumn && agent.stats ? (
        <div data-testid="agent-row-last-payment" className="min-w-0 self-start text-right [grid-area:time] sm:self-center">
          {agent.stats.lastPaymentAt ? (
            <>
              <p className="text-sm font-medium text-[var(--v2-ink)] whitespace-nowrap">
                {/* The column drops the visible "Last payment" words; a screen
                    reader still hears what the time is. */}
                <span className="sr-only">Last payment </span>
                {timeAgo(agent.stats.lastPaymentAt)}
              </p>
              {counterpartyLabelValue ? (
                <p className="mt-0.5 hidden truncate text-xs text-[var(--v2-ink-3)] sm:block" title={counterpartyLabelValue}>
                  {counterpartyLabelValue}
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-sm font-medium text-[var(--v2-ink)] whitespace-nowrap">No payments yet</p>
          )}
        </div>
      ) : null}
      <Icon icon={ChevronRight} className="h-4 w-4 flex-shrink-0 text-[var(--v2-ink-3)] [grid-area:chev]" />
    </Link>
  )
}

export default AgentsSection
