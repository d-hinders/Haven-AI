/**
 * "Needs attention" rules (#3808; the card was "Needs you" until #3902) — the
 * ONE definition of "needs attention".
 *
 * Pure functions over the #3803 overview and the #3804 budget-remaining
 * responses. No React, no hooks, no fetches: the dashboard's NeedsYou card
 * (#3808), #3809's badges and ordering, and #3818's setup guide all import
 * these rules, so "needs attention" cannot drift between surfaces.
 *
 * ── The unknown-value rule (#3295) ────────────────────────────────────────
 *
 * A failed read NEVER fires a rule. `usdcBalanceAtomic: null` is unknown —
 * it is never read as zero (`DashboardClient.tsx` #3295 rule), and a budget
 * read that came back unknown (`used_atomic: null`, #3804) never counts as
 * "used 90%". A rule that cannot know its inputs stays silent; the next
 * successful load will know.
 *
 * ── Item order ────────────────────────────────────────────────────────────
 *
 * The returned array follows the issue's fixed order: needs setup, low
 * balance / zero USDC (per account), budget reached and scope refusals (per
 * agent), Haven paused sponsored payments, payments failed (per agent), no
 * backup signer (per account). Renderers must not re-sort.
 *
 * ── Attribution decision (recorded, #3808) ────────────────────────────────
 *
 * Rule 4 counts "refusals in the `failed` bucket plus payment intents with
 * status `failed`, per agent". The overview's per-agent data (#3803) carries
 * refusal ROW counts only; `spend.failedIntents7d` is a USER-level count
 * with no per-agent attribution on the wire. So: an agent with `failed`
 * refusals gets a named danger item; the user-level failed-intent count
 * produces an unattributed item ONLY when no named item exists — if some
 * agent is already named, the intents are plausibly the same events, and a
 * second "payments failed" row with no name would double-report them.
 *
 * ── Dismiss vs acknowledge (#3813, #4324) ─────────────────────────────────
 *
 * Two kinds are DISMISSED for good (#3813): "No backup signer" per account
 * and "Needs setup" per agent. A dismissed `needs-setup` also hides the
 * agent's "Needs setup" badge, because `agentBadge` reads the filtered
 * items (`components/haven/AgentRow.tsx`). #4324 (owner decisions
 * 2026-10-23, reversing the parts of #3813 that made them non-dismissible)
 * lets the event-driven items be ACKNOWLEDGED: the item hides until
 * something NEW happens — a budget, scope, failure or sponsorship refusal
 * newer than the acknowledgement, a failed intent newer than it, or (for
 * the 90%-used item) the next budget period. An event at or before the
 * acknowledgement keeps it hidden. A missing event time (an old response)
 * never hides an item: the unknown-value rule holds. Low balance and zero
 * USDC are never dismissible — money is at stake and "Add funds" is the
 * action.
 */

import type { ApiSchema } from '@haven_ai/core'
import { hasPositiveCap, receivedBudgetLine } from './agent-budget'

export type DashboardOverview = ApiSchema<'DashboardOverviewResponse'>
export type DashboardBudgetRemaining = ApiSchema<'DashboardBudgetRemainingResponse'>
type DashboardAgent = DashboardOverview['agents'][number]
type DashboardAccount = DashboardOverview['accounts'][number]
type BudgetRemainingEntry = DashboardBudgetRemaining['budgets'][number]

/** Same tone set as `AttentionList` (#3805). */
export type AttentionTone = 'neutral' | 'brand' | 'warning' | 'danger'

/**
 * Which rule produced the item. `budget-reached` (a budget refusal),
 * `budget-usage` (>= 90% of a period spent, its own kind since #4324 so the
 * two re-arm independently) and `budget-scope` are all rule 3; `scope`
 * refusals get their own wording ("tried to pay a recipient its budget
 * doesn't cover") and badge ("Outside its rules"), so they are
 * distinguishable.
 */
export type AttentionItemKind =
  | 'needs-setup'
  | 'low-balance'
  | 'zero-usdc'
  | 'budget-reached'
  | 'budget-usage'
  | 'budget-scope'
  | 'haven-paused'
  | 'payments-failed'
  | 'no-backup'

export interface AttentionRuleItem {
  /** Stable across polls — the dismiss/id channel and test selectors. */
  id: string
  kind: AttentionItemKind
  tone: AttentionTone
  /** `StatusBadge` label — the tone in text. */
  badge?: string
  title: string
  subtitle?: string
  /** The row action's label; `href` is where it sends the user. */
  actionLabel?: string
  href?: string
  agentId?: string
  accountId?: string
  /**
   * `budget-usage` only: the firing budget's `period_end` (#4324). An
   * acknowledgement stores it, and the item re-arms once that budget's
   * period has moved past it.
   */
  periodEnd?: string
}

/**
 * One server-saved dismissal or acknowledgement, keyed by the rule-item id
 * it hides (`useAttentionDismissals`). `acknowledgedAt` is when the user
 * last dismissed it; `acknowledgedPeriodEnd` is set on `budget-usage` only.
 */
export interface AttentionAcknowledgement {
  acknowledgedAt: string
  acknowledgedPeriodEnd: string | null
}

export interface DashboardAttentionInput {
  overview: DashboardOverview
  /** #3804's response. `null` (load failed / not yet fetched) never fires the ≥90% rule. */
  budgetRemaining: DashboardBudgetRemaining | null
  /**
   * accountId → display name. The overview's account block (#3803) carries no
   * name, and a two-account user's low-balance item must NAME the short
   * account — the session's accounts list is the label source; agents'
   * `accountName` is the fallback for accounts that list none.
   */
  accountNames?: Record<string, string>
  /**
   * The server-saved dismissals and acknowledgements (#3813, #4324,
   * `useAttentionDismissals`), keyed by rule-item id. A dismissal is PER
   * ACCOUNT / PER AGENT because it is keyed by the item id
   * (`no-backup:<accountId>`, `needs-setup:<agentId>`, `budget-reached:<agentId>`
   * …): an account funded after a backup dismissal elsewhere still raises
   * its own item. A permanent kind is hidden by its presence; an
   * acknowledged kind only until a newer event (see the file header).
   */
  acknowledgements?: ReadonlyMap<string, AttentionAcknowledgement>
  /** Ids hidden for this session only — never persisted. */
  dismissedIds?: ReadonlySet<string>
  /**
   * While the setup guide's "Add USDC" step is open (#3818), the low-balance
   * and zero-USDC items are held back — the guide IS the ask for funds.
   */
  holdBackLowBalance?: boolean
}

/**
 * The kinds a user can dismiss. #3813 (2026-10-09) allowed two, for good:
 * "No backup signer" (per account) and "Needs setup" for an agent kept
 * without a budget on purpose (per agent). #4324 (owner decisions
 * 2026-10-23) supersedes the rest of that rule: budget, scope, sponsorship
 * and failure items are acknowledged until something new happens. Low
 * balance and zero USDC still offer NO dismiss control — money is at stake
 * and "Add funds" is the action. `NeedsYou` reads this to set each row's
 * `dismissible`, so the rules layer stays the one definition and
 * #3809/#3818 cannot drift from the dashboard.
 */
export const DISMISSIBLE_ATTENTION_KINDS: ReadonlySet<AttentionItemKind> = new Set([
  'needs-setup',
  'no-backup',
  'budget-reached',
  'budget-usage',
  'budget-scope',
  'haven-paused',
  'payments-failed',
])

/** #3813's two kinds: a dismissal hides them for good. */
export const PERMANENT_ATTENTION_KINDS: ReadonlySet<AttentionItemKind> = new Set([
  'needs-setup',
  'no-backup',
])

/**
 * #4324: `payments-failed` reads calm (neutral) until an agent — or, for the
 * unattributed item, the user — has this many in 7 days. Counted in refusal
 * ROWS (a retry folded within 60 s is one row).
 */
export const PAYMENTS_FAILED_DANGER_COUNT = 3

/** The agent Activity tab filtered to its refused attempts (#4323). */
function refusedAttemptsHref(agentId: string): string {
  return `/agents/${agentId}?tab=activity&status=refused`
}

/** Compare two ISO instants; NaN-safe (an unparseable value is unknown). */
function instant(value: string | undefined | null): number | null {
  if (value === undefined || value === null) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

/**
 * An acknowledged item stays hidden while its latest event is known and at
 * or before the acknowledgement. A missing or unparseable event time never
 * hides it (#3295).
 */
function acknowledgedSinceLatestEvent(
  acknowledgement: AttentionAcknowledgement | undefined,
  latestEventAt: string | undefined | null,
): boolean {
  if (!acknowledgement) return false
  const event = instant(latestEventAt)
  const acknowledged = instant(acknowledgement.acknowledgedAt)
  if (event === null || acknowledged === null) return false
  return event <= acknowledged
}

/**
 * The 90%-used item stays hidden while the firing budget's current period
 * ends at or before the period end stored with the acknowledgement — i.e.
 * until the next period starts.
 */
function acknowledgedThisPeriod(
  acknowledgement: AttentionAcknowledgement | undefined,
  periodEnd: string | undefined,
): boolean {
  if (!acknowledgement) return false
  const current = instant(periodEnd)
  const stored = instant(acknowledgement.acknowledgedPeriodEnd)
  if (current === null || stored === null) return false
  return current <= stored
}

/**
 * A budget cap above zero (#3897) — OWNED by `lib/agent-budget.ts` (#3988):
 * the one definition every budget-authority display reads. A zero cap is no
 * authority — the agents section reads it "No budget" (#3802's rule) and it
 * never completes setup. An unparseable cap is kept: the caption shows it as
 * unknown.
 */
export { hasPositiveCap }

/** A usable budget: a live delegation budget with a cap above zero, or an open received sub-budget. */
export function hasUsableBudget(agent: DashboardAgent): boolean {
  return (
    (agent.budgets ?? []).some((budget) => hasPositiveCap(budget.budgetAtomic)) ||
    receivedBudgetLine(agent.receivedSubBudgets) !== null
  )
}

/**
 * #3818: the one definition of an agent that can actually pay — active or
 * paused (paused is set up; Haven just is not sending its payments) and
 * holding a usable budget. The first-run guide's step 2 completes on it, and
 * it is the complement of the "Needs setup" rule below for the statuses that
 * rule covers. A `pending_approval` agent never qualifies; revoked agents are
 * not in the overview at all.
 */
export function agentIsSetUp(agent: DashboardAgent): boolean {
  return (agent.status === 'active' || agent.status === 'paused') && hasUsableBudget(agent)
}

/** The agent the "Needs setup" rule offers "Finish setup" for (not "Remove"). */
function agentAwaitsFinishSetup(agent: DashboardAgent): boolean {
  if (agent.status === 'pending_approval') {
    return agent.setupStatus !== 'expired' && agent.setupStatus !== 'failed'
  }
  return agent.status === 'active' && !hasUsableBudget(agent)
}

/** What the first-run guide needs from the overview (#3818). */
export interface FirstRunSetupState {
  /** Any account's own USDC above zero; `null` when no account says so and at least one read is unknown. */
  usdcFunded: boolean | null
  hasSetUpAgent: boolean
  /**
   * The most recently connected agent awaiting "Finish setup", and how many
   * more do. `awaiting` says which half is missing: the budget approval of a
   * `pending_approval` agent, or a budget for an active agent with none.
   */
  pendingAgent: { id: string; name: string; moreCount: number; awaiting: 'approval' | 'budget' } | null
}

/**
 * #3818: the first-run guide's facts, from the same overview the rules read.
 *
 * - Step 1 reads each account's `funded` (#3803: its own USDC > 0, `null`
 *   when the read is unavailable). Any account funded completes it (owner
 *   decision 2026-10-09: any USDC above zero); it is `false` only when every
 *   account is KNOWN to hold none, and `null` otherwise — never a guessed zero.
 * - Step 2 names the newest agent awaiting setup. The overview carries no
 *   timestamps, so `createdAtById` (from `GET /agents`) orders them; an agent
 *   without one sorts FIRST — it is newer than that read.
 */
export function firstRunSetupState(
  overview: DashboardOverview,
  createdAtById: Record<string, string> = {},
): FirstRunSetupState {
  const accounts = overview.accounts ?? []
  const agents = overview.agents ?? []
  const usdcFunded = accounts.some((account) => account.funded === true)
    ? true
    : accounts.length > 0 && accounts.every((account) => account.funded === false)
      ? false
      : null
  // An agent missing from GET /agents is newer than that read (it polls less
  // often than the overview), so it sorts FIRST. Ties keep the overview's own
  // order (newest first per status). Plain string comparison of ISO
  // timestamps — no locale collation.
  const newestFirst = (a?: string, b?: string): number => {
    if (a === b) return 0
    if (a === undefined) return -1
    if (b === undefined) return 1
    return a > b ? -1 : 1
  }
  const awaiting = agents
    .filter(agentAwaitsFinishSetup)
    .map((agent, index) => ({ agent, index }))
    .sort((a, b) => newestFirst(createdAtById[a.agent.id], createdAtById[b.agent.id]) || a.index - b.index)
    .map(({ agent }) => agent)
  const newest = awaiting[0]
  return {
    usdcFunded,
    hasSetUpAgent: agents.some(agentIsSetUp),
    pendingAgent: newest
      ? {
          id: newest.id,
          name: newest.name,
          moreCount: awaiting.length - 1,
          awaiting: newest.status === 'pending_approval' ? 'approval' : 'budget',
        }
      : null,
  }
}

function accountLabel(
  account: DashboardAccount,
  overview: DashboardOverview,
  accountNames: Record<string, string> | undefined,
): string {
  const named = accountNames?.[account.accountId]
  if (named) return named
  const viaAgent = (overview.agents ?? []).find(
    (agent) => agent.accountId === account.accountId,
  )?.accountName
  return viaAgent ?? 'This account'
}

/**
 * Rule 2 — the account's USDC lasts under 7 days at its pace. The pace is
 * the 7-day spend (net of sweeps), so "lasts under 7 days" is exactly
 * `balance < pace7d` — no division, no float, atomic strings throughout.
 */
function usdcRunsOutUnder7Days(balanceAtomic: string, pace7dAtomic: string): boolean {
  try {
    const balance = BigInt(balanceAtomic)
    const pace = BigInt(pace7dAtomic)
    return balance > 0n && pace > 0n && balance < pace
  } catch {
    // A malformed read is an unknown read (#3295) — never a warning.
    return false
  }
}

/**
 * The agent's highest KNOWN used percent across its budgets, from #3804's
 * reads — null when no read is known. `used_atomic: null` (unknown read)
 * never counts, a zero budget never divides. Rule 3's ≥90% arm below and
 * #3809's "N% used" badge both read THIS one function, so the badge and the
 * "Needs attention" item cannot disagree about whether a budget is nearly spent.
 */
export function agentUsedPercent(
  agentId: string,
  budgetRemaining: DashboardBudgetRemaining | null,
): number | null {
  let best: number | null = null
  for (const entry of budgetRemaining?.budgets ?? []) {
    if (entry.agent_id !== agentId) continue
    if (entry.used_atomic === null) continue
    try {
      const budget = BigInt(entry.budget_atomic)
      if (budget <= 0n) continue
      const used = BigInt(entry.used_atomic)
      // Two decimals: floor(used×10000 / budget)/100. `floor(p×100) ≥ 9000`
      // is the same integer comparison the ≥90% rule below makes — no drift.
      const pct = Number((used * 10_000n) / budget) / 100
      if (best === null || pct > best) best = pct
    } catch {
      continue
    }
  }
  return best
}

/**
 * Rule 3's ≥90% arm: the agent's budget whose KNOWN read shows the highest
 * share of its period spent, when that is at least 90%. `used_atomic: null`
 * (unknown read, #3804) never counts, and a zero budget never reads as
 * "reached". #4324: the item carries this budget's `period_end`, which an
 * acknowledgement stores. Same percent arithmetic as `agentUsedPercent`.
 */
function firingUsageBudget(
  agentId: string,
  budgetRemaining: DashboardBudgetRemaining | null,
): BudgetRemainingEntry | null {
  let best: { entry: BudgetRemainingEntry; pct: number } | null = null
  for (const entry of budgetRemaining?.budgets ?? []) {
    if (entry.agent_id !== agentId) continue
    if (entry.used_atomic === null) continue
    try {
      const budget = BigInt(entry.budget_atomic)
      if (budget <= 0n) continue
      const pct = Number((BigInt(entry.used_atomic) * 10_000n) / budget) / 100
      if (best === null || pct > best.pct) best = { entry, pct }
    } catch {
      continue
    }
  }
  return best !== null && best.pct >= 90 ? best.entry : null
}

/**
 * Compute the "Needs attention" items, in the issue's fixed order. Each item fires
 * only when its condition holds on KNOWN values.
 */
export function computeAttentionItems(input: DashboardAttentionInput): AttentionRuleItem[] {
  const { overview, budgetRemaining, accountNames, acknowledgements, dismissedIds, holdBackLowBalance } = input
  const items: AttentionRuleItem[] = []
  /** #4324: each acknowledgeable item's latest event time, by item id. */
  const latestEventById = new Map<string, string | undefined>()
  // Defensive at the wire edge: an overview without the #3803 fields (an old
  // cached response, a lagging fixture) means the data is UNKNOWN — the same
  // rule as a failed read. No items, never a render crash.
  const agents = overview.agents ?? []
  const accounts = overview.accounts ?? []
  const failedIntents7d = overview.spend?.failedIntents7d ?? 0

  // ── 1. Needs setup (brand) — one item per agent, never two ──────────────
  for (const agent of agents) {
    if (agent.status === 'pending_approval') {
      // #3803, owner decision 2: a pending agent whose setup expired or
      // failed shows "Remove" instead of "Finish setup".
      const setupFailed = agent.setupStatus === 'expired' || agent.setupStatus === 'failed'
      items.push({
        id: `needs-setup:${agent.id}`,
        kind: 'needs-setup',
        tone: 'brand',
        badge: 'Needs setup',
        title: `${agent.name} is waiting to be set up`,
        subtitle: setupFailed
          ? 'Its setup did not complete. Remove it and connect it again.'
          : 'Finish setting it up to give it a budget.',
        actionLabel: setupFailed ? 'Remove' : 'Finish setup',
        href: `/agents/${agent.id}`,
        agentId: agent.id,
      })
    } else if (agent.status === 'active' && !hasUsableBudget(agent)) {
      items.push({
        id: `needs-setup:${agent.id}`,
        kind: 'needs-setup',
        tone: 'brand',
        badge: 'Needs setup',
        title: `${agent.name} has no budget`,
        subtitle: 'Set a budget so it can spend.',
        actionLabel: 'Finish setup',
        href: `/agents/${agent.id}`,
        agentId: agent.id,
      })
    }
  }

  // ── 2. Low balance / zero USDC (warning) — per account, USDC only ───────
  // Agents cannot spend another account's money or ETH, so the account's
  // registry USDC is the only balance that can strand a payment.
  if (!holdBackLowBalance) {
    for (const account of accounts) {
      // A failed read is unknown — never zero, never a warning (#3295).
      if (account.usdcBalanceAtomic === null) continue
      const label = accountLabel(account, overview, accountNames)
      if (account.usdcBalanceAtomic === '0') {
        const agentsHaveBudgets = agents.some(
          (agent) => agent.accountId === account.accountId && hasUsableBudget(agent),
        )
        // Firm warning: agents with budgets but no USDC to spend. #4324: its
        // badge is "No USDC", so it is not the same word as low balance.
        if (agentsHaveBudgets) {
          items.push({
            id: `zero-usdc:${account.accountId}`,
            kind: 'zero-usdc',
            tone: 'warning',
            badge: 'No USDC',
            title: `${label} is out of USDC`,
            subtitle: 'Its agents have budgets to spend, but no USDC left to spend.',
            actionLabel: 'Add funds',
            accountId: account.accountId,
          })
        }
        continue
      }
      if (usdcRunsOutUnder7Days(account.usdcBalanceAtomic, account.usdcPace7dAtomic)) {
        items.push({
          id: `low-balance:${account.accountId}`,
          kind: 'low-balance',
          tone: 'warning',
          badge: 'Low balance',
          title: `${label}'s USDC is running low`,
          subtitle: 'At the current pace, its USDC lasts under 7 days.',
          actionLabel: 'Add funds',
          accountId: account.accountId,
        })
      }
    }
  }

  // ── 3. Budget reached (neutral, owner decision 2026-10-09) — per agent ──
  for (const agent of agents) {
    const refusals = agent.stats?.d7?.refusals
    const refusalItemId = `budget-reached:${agent.id}`
    const refusalFires = (refusals?.budget ?? 0) > 0
    if (refusalFires) {
      items.push({
        id: refusalItemId,
        kind: 'budget-reached',
        tone: 'neutral',
        badge: 'Budget reached',
        title: `${agent.name} reached its budget`,
        subtitle: 'Its budget stopped a payment in the last 7 days.',
        actionLabel: 'Review',
        href: refusedAttemptsHref(agent.id),
        agentId: agent.id,
      })
      latestEventById.set(refusalItemId, refusals?.lastBudgetAt)
    }
    // #4324: the 90%-used item is its own kind, re-armed by the budget
    // period rather than by refusals. One budget item per agent at a time:
    // while the refusal item is showing it says the more urgent thing, and
    // the 90% item appears once that one is acknowledged.
    const refusalShowing =
      refusalFires &&
      !acknowledgedSinceLatestEvent(acknowledgements?.get(refusalItemId), refusals?.lastBudgetAt)
    const firing = firingUsageBudget(agent.id, budgetRemaining)
    if (firing !== null && !refusalShowing) {
      items.push({
        id: `budget-usage:${agent.id}`,
        kind: 'budget-usage',
        tone: 'neutral',
        badge: 'Budget reached',
        title: `${agent.name} has used 90% of its budget`,
        subtitle: 'Its current budget period is nearly spent.',
        actionLabel: 'Review',
        // The agent page leads with its Spending hero. No hash: scrolling
        // to one after a client navigation is unverified.
        href: `/agents/${agent.id}`,
        agentId: agent.id,
        periodEnd: firing.period_end,
      })
    }
    // `scope` refusals (no budget for that target) are reported here too,
    // with their own wording and badge. A budget did its job — but the
    // recipient was outside the agent's rules, which reads differently from
    // a cap hit.
    if ((refusals?.scope ?? 0) > 0) {
      const id = `budget-scope:${agent.id}`
      items.push({
        id,
        kind: 'budget-scope',
        tone: 'neutral',
        badge: 'Outside its rules',
        title: `${agent.name} tried to pay a recipient its budget doesn't cover`,
        subtitle: 'The payment was refused — the recipient is outside its rules.',
        actionLabel: 'Review',
        href: refusedAttemptsHref(agent.id),
        agentId: agent.id,
      })
      latestEventById.set(id, refusals?.lastScopeAt)
    }
  }

  // `haven` refusals (relayer_budget) are Haven's own cap — never blamed on
  // the user's budget. One quiet item, unattributed to any agent. #4324:
  // "Review" opens the refused attempts of the agent with the LATEST one;
  // when any contributing agent's time is unknown (an old response), the
  // item shows no action and still re-arms as before.
  const havenAgents = agents.filter((agent) => (agent.stats?.d7?.refusals?.haven ?? 0) > 0)
  if (havenAgents.length > 0) {
    let latest: { agentId: string; at: string; ms: number } | null = null
    let allKnown = true
    for (const agent of havenAgents) {
      const at = agent.stats?.d7?.refusals?.lastHavenAt
      const ms = instant(at)
      if (at === undefined || ms === null) {
        allKnown = false
        continue
      }
      if (latest === null || ms > latest.ms) latest = { agentId: agent.id, at, ms }
    }
    const known = allKnown ? latest : null
    items.push({
      id: 'haven-paused',
      kind: 'haven-paused',
      tone: 'neutral',
      title: 'Haven paused sponsored payments',
      // Reassurance first (owner decision 2026-10-10, #3880): the two-line
      // clamp can cut the end of this line in the narrow desktop panel.
      subtitle: "Your budgets are untouched. Haven's own cap stopped a payment.",
      ...(known ? { actionLabel: 'Review', href: refusedAttemptsHref(known.agentId) } : {}),
    })
    latestEventById.set('haven-paused', known?.at)
  }

  // ── 4. Payments failed — calm unless repeated (#4324) ───────────────────
  // Per-agent attribution comes from the refusal buckets. The user-level
  // failed-intent count (#3803) surfaces only when nothing is named — see
  // the attribution decision in the file header.
  let namedFailedAgent = false
  for (const agent of agents) {
    const failed = agent.stats?.d7?.refusals?.failed ?? 0
    if (failed > 0) {
      namedFailedAgent = true
      const repeated = failed >= PAYMENTS_FAILED_DANGER_COUNT
      const id = `payments-failed:${agent.id}`
      items.push({
        id,
        kind: 'payments-failed',
        tone: repeated ? 'danger' : 'neutral',
        badge: 'Failed',
        title: `${agent.name} had a failed payment`,
        subtitle: repeated
          ? 'Payments keep failing — check the agent.'
          : 'A payment was refused by the network. No money moved.',
        actionLabel: 'Review',
        href: refusedAttemptsHref(agent.id),
        agentId: agent.id,
      })
      latestEventById.set(id, agent.stats?.d7?.refusals?.lastFailedAt)
    }
  }
  if (!namedFailedAgent && failedIntents7d > 0) {
    // These are `payment_intents` with status `failed`, not refusals, so the
    // subtitle never claims that no money moved.
    const repeated = failedIntents7d >= PAYMENTS_FAILED_DANGER_COUNT
    items.push({
      id: 'payments-failed:unattributed',
      kind: 'payments-failed',
      tone: repeated ? 'danger' : 'neutral',
      badge: 'Failed',
      title: 'A payment failed',
      subtitle: repeated
        ? 'Payments keep failing — check your agents.'
        : 'A payment did not go through in the last 7 days.',
      actionLabel: 'View transactions',
      href: '/transactions',
    })
    latestEventById.set('payments-failed:unattributed', overview.spend?.lastFailedIntentAt)
  }

  // ── 5. No backup signer (warning) — per account ─────────────────────────
  // `needs_backup_recommendation` is the server's answer (#1205) — false on
  // test networks by construction (`mainnet-gate.ts`), so the frontend keeps
  // no second copy of "which chains carry value". `funded: null` is an
  // unknown USDC read — never a nag. Hiding is owned by the dismissals
  // (#3813) below, which are per account because they are keyed by item id.
  for (const account of accounts) {
    if (account.isTestnet) continue
    if (account.needs_backup_recommendation !== true) continue
    if (account.funded !== true) continue
    const label = accountLabel(account, overview, accountNames)
    items.push({
      id: `no-backup:${account.accountId}`,
      kind: 'no-backup',
      tone: 'warning',
      badge: 'Backup',
      title: `${label} has one way to approve payments`,
      subtitle:
        'Add a backup — a backup passkey or a wallet — so a lost device never means a lost account.',
      actionLabel: 'Add backup',
      href: `/accounts/${account.accountId}`,
      accountId: account.accountId,
    })
  }

  // ── 6. Dismissed and acknowledged (#3813, #4324) — the last word ────────
  // A failed dismissal read NEVER hides an item: the map only ever holds
  // rows a successful server read (or this session's own dismiss) put
  // there, so a read that failed shows the items again — the nag is the
  // safe direction, silence is the destructive one.
  return items.filter((item) => {
    if (dismissedIds?.has(item.id)) return false
    const acknowledgement = acknowledgements?.get(item.id)
    if (!acknowledgement) return true
    if (PERMANENT_ATTENTION_KINDS.has(item.kind)) return false
    if (item.kind === 'budget-usage') return !acknowledgedThisPeriod(acknowledgement, item.periodEnd)
    return !acknowledgedSinceLatestEvent(acknowledgement, latestEventById.get(item.id))
  })
}

/**
 * #3902: what the "Needs attention" card says when it lists nothing.
 *
 * An empty item list is not a measurement. `computeAttentionItems` returns
 * `[]` when a balance read is unknown, when a zero balance has no budgeted
 * agents behind it, when nothing was spent this week, while the budget reads
 * are still loading or came back unknown, after a dismissal, and for a paused
 * agent with no budget. So the achievement state is driven by FACTS, each
 * measured and holding — never by the list being empty. Since #3908 it shows
 * its title alone (owner, 2026-10-13); the facts still gate it:
 *
 * - **Runway, per account.** Agents cannot spend across accounts, so a summed
 *   balance would be wrong. Every account's USDC must be known and above zero.
 *   "Lasts well over a month" means each account with spend this week has
 *   `balance × 7 > pace7d × 30` (BigInt — the pace is the 7-day spend, so
 *   `balance ÷ (pace7d ÷ 7)` days `> 30`). No spend this week on any account
 *   also holds: nothing is drawing the balance down.
 * - **Room in budgets.** At least one agent holds a usable budget, and every
 *   such agent has every budget read KNOWN, the highest below 90% (`agentUsedPercent`, the
 *   one function rule 3 and the agent badges read) and no budget or scope
 *   stop in the last 7 days that the user has not acknowledged (#4324: an
 *   acknowledged stop with none newer counts as reviewed; the 90% fact still
 *   blocks "caught up" until the period turns, by design).
 *
 * Anything short of that gets the neutral line, which states only that the
 * list is empty. While the budget reads are loading the card says neither:
 * `pending` renders nothing until they settle.
 */
export type AttentionEmptyState =
  | { kind: 'pending' }
  | { kind: 'caught-up'; title: string }
  | { kind: 'quiet'; body: string }

export const ATTENTION_CAUGHT_UP_TITLE = "You're all caught up"
export const ATTENTION_QUIET_LINE = 'No items to review right now.'

/** `balance × 7 > pace7d × 30` for every account with spend; `null` when any read is unknown or zero. */
function runwayFact(accounts: DashboardAccount[]): 'month' | 'no-spend' | null {
  if (accounts.length === 0) return null
  let anySpend = false
  for (const account of accounts) {
    if (account.usdcBalanceAtomic === null) return null
    let balance: bigint
    let pace: bigint
    try {
      balance = BigInt(account.usdcBalanceAtomic)
      pace = BigInt(account.usdcPace7dAtomic)
    } catch {
      // A malformed read is an unknown read (#3295).
      return null
    }
    if (balance <= 0n) return null
    if (pace <= 0n) continue
    anySpend = true
    if (balance * 7n <= pace * 30n) return null
  }
  return anySpend ? 'month' : 'no-spend'
}

/** A read is known only when it is present AND parses — a malformed one is unknown (#3295). */
function isKnownAtomic(value: string | null): boolean {
  // `BigInt('')` is `0n`: an empty string is no reading, not a zero.
  if (value === null || value.trim() === '') return false
  try {
    BigInt(value)
    return true
  } catch {
    return false
  }
}

function budgetRoomFact(
  agents: DashboardAgent[],
  budgetRemaining: DashboardBudgetRemaining | null,
  acknowledgements: ReadonlyMap<string, AttentionAcknowledgement> | undefined,
): boolean {
  const budgeted = agents.filter(hasUsableBudget)
  if (budgeted.length === 0) return false
  return budgeted.every((agent) => {
    const refusals = agent.stats?.d7?.refusals
    // #4324: a budget or scope stop the user has acknowledged — none newer
    // than the acknowledgement — counts as reviewed.
    const budgetStopOpen =
      (refusals?.budget ?? 0) > 0 &&
      !acknowledgedSinceLatestEvent(acknowledgements?.get(`budget-reached:${agent.id}`), refusals?.lastBudgetAt)
    const scopeStopOpen =
      (refusals?.scope ?? 0) > 0 &&
      !acknowledgedSinceLatestEvent(acknowledgements?.get(`budget-scope:${agent.id}`), refusals?.lastScopeAt)
    if (budgetStopOpen || scopeStopOpen) return false
    // EVERY read of the agent's budgets must be known: `agentUsedPercent`
    // returns the highest KNOWN percent, so one known 10% beside an unknown
    // read would otherwise claim room in a budget nobody measured.
    const reads = (budgetRemaining?.budgets ?? []).filter((entry) => entry.agent_id === agent.id)
    if (reads.some((entry) => !isKnownAtomic(entry.used_atomic))) return false
    const pct = agentUsedPercent(agent.id, budgetRemaining)
    return pct !== null && pct < 90
  })
}

export function attentionEmptyState(input: {
  overview: DashboardOverview
  budgetRemaining: DashboardBudgetRemaining | null
  budgetRemainingLoading: boolean
  /** #4324: an acknowledged budget or scope stop counts as reviewed. */
  acknowledgements?: ReadonlyMap<string, AttentionAcknowledgement>
}): AttentionEmptyState {
  const { overview, budgetRemaining, budgetRemainingLoading, acknowledgements } = input
  if (budgetRemainingLoading) return { kind: 'pending' }
  const runway = runwayFact(overview.accounts ?? [])
  const room = budgetRoomFact(overview.agents ?? [], budgetRemaining, acknowledgements)
  if (runway === null || !room) return { kind: 'quiet', body: ATTENTION_QUIET_LINE }
  return { kind: 'caught-up', title: ATTENTION_CAUGHT_UP_TITLE }
}
