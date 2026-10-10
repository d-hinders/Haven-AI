/**
 * "Needs you" rules (#3808) — the ONE definition of "needs attention".
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
 */

import type { ApiSchema } from '@haven_ai/core'

export type DashboardOverview = ApiSchema<'DashboardOverviewResponse'>
export type DashboardBudgetRemaining = ApiSchema<'DashboardBudgetRemainingResponse'>
type DashboardAgent = DashboardOverview['agents'][number]
type DashboardAccount = DashboardOverview['accounts'][number]
type BudgetRemainingEntry = DashboardBudgetRemaining['budgets'][number]

/** Same tone set as `AttentionList` (#3805). */
export type AttentionTone = 'neutral' | 'brand' | 'warning' | 'danger'

/**
 * Which rule produced the item. `budget-reached` and `budget-scope` are both
 * rule 3; `scope` refusals get their own wording ("tried to pay a recipient
 * its budget doesn't cover"), so they are distinguishable.
 */
export type AttentionItemKind =
  | 'needs-setup'
  | 'low-balance'
  | 'zero-usdc'
  | 'budget-reached'
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
   * The legacy global dismissal (`haven.recovery-nudge.dismissed`): one flag
   * that hides every backup item, until #3813 owns persistence per item.
   */
  backupDismissed?: boolean
  /**
   * While the setup guide's "Add USDC" step is open (#3818), the low-balance
   * and zero-USDC items are held back — the guide IS the ask for funds.
   */
  holdBackLowBalance?: boolean
}

/** A usable budget: a live delegation budget, or an open received sub-budget. */
function hasUsableBudget(agent: DashboardAgent): boolean {
  return (
    (agent.budgets?.length ?? 0) > 0 ||
    (agent.receivedSubBudgets ?? []).some((sub) => sub.open)
  )
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
 * "Needs you" item cannot disagree about whether a budget is nearly spent.
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
 * Rule 3's ≥90% arm: any of the agent's budgets whose KNOWN read shows at
 * least 90% of the period budget spent. `used_atomic: null` (unknown read,
 * #3804) never counts, and a zero budget never reads as "reached".
 */
function usedAtLeast90Percent(
  agentId: string,
  budgetRemaining: DashboardBudgetRemaining | null,
): boolean {
  const pct = agentUsedPercent(agentId, budgetRemaining)
  return pct !== null && pct >= 90
}

/**
 * Compute the "Needs you" items, in the issue's fixed order. Each item fires
 * only when its condition holds on KNOWN values.
 */
export function computeAttentionItems(input: DashboardAttentionInput): AttentionRuleItem[] {
  const { overview, budgetRemaining, accountNames, backupDismissed, holdBackLowBalance } = input
  const items: AttentionRuleItem[] = []
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
        // Firm warning: agents with budgets but no USDC to spend.
        if (agentsHaveBudgets) {
          items.push({
            id: `zero-usdc:${account.accountId}`,
            kind: 'zero-usdc',
            tone: 'warning',
            badge: 'Low balance',
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
    if ((refusals?.budget ?? 0) > 0) {
      items.push({
        id: `budget-reached:${agent.id}`,
        kind: 'budget-reached',
        tone: 'neutral',
        badge: 'Budget reached',
        title: `${agent.name} reached its budget`,
        subtitle: 'Its budget stopped a payment in the last 7 days.',
        actionLabel: 'Review',
        href: `/agents/${agent.id}`,
        agentId: agent.id,
      })
    } else if (usedAtLeast90Percent(agent.id, budgetRemaining)) {
      items.push({
        id: `budget-reached:${agent.id}`,
        kind: 'budget-reached',
        tone: 'neutral',
        badge: 'Budget reached',
        title: `${agent.name} has used 90% of its budget`,
        subtitle: 'Its current budget period is nearly spent.',
        actionLabel: 'Review',
        href: `/agents/${agent.id}`,
        agentId: agent.id,
      })
    }
    // `scope` refusals (no budget for that target) are reported here too,
    // with their own wording. A budget did its job — but the recipient was
    // outside the agent's rules, which reads differently from a cap hit.
    if ((refusals?.scope ?? 0) > 0) {
      items.push({
        id: `budget-scope:${agent.id}`,
        kind: 'budget-scope',
        tone: 'neutral',
        badge: 'Budget reached',
        title: `${agent.name} tried to pay a recipient its budget doesn't cover`,
        subtitle: 'The payment was refused — the recipient is outside its rules.',
        actionLabel: 'Review',
        href: `/agents/${agent.id}`,
        agentId: agent.id,
      })
    }
  }

  // `haven` refusals (relayer_budget) are Haven's own cap — never blamed on
  // the user's budget. One quiet item, unattributed to any agent.
  if (agents.some((agent) => (agent.stats?.d7?.refusals?.haven ?? 0) > 0)) {
    items.push({
      id: 'haven-paused',
      kind: 'haven-paused',
      tone: 'neutral',
      title: 'Haven paused sponsored payments',
      // Reassurance first (owner decision 2026-10-10, #3880): the two-line
      // clamp can cut the end of this line in the narrow desktop panel.
      subtitle: "Your budgets are untouched. Haven's own cap stopped a payment.",
    })
  }

  // ── 4. Payments failed (danger) ─────────────────────────────────────────
  // Per-agent attribution comes from the refusal buckets. The user-level
  // failed-intent count (#3803) surfaces only when nothing is named — see
  // the attribution decision in the file header.
  let namedFailedAgent = false
  for (const agent of agents) {
    if ((agent.stats?.d7?.refusals?.failed ?? 0) > 0) {
      namedFailedAgent = true
      items.push({
        id: `payments-failed:${agent.id}`,
        kind: 'payments-failed',
        tone: 'danger',
        badge: 'Failed',
        title: `${agent.name} had a failed payment`,
        subtitle: 'A payment did not go through in the last 7 days.',
        actionLabel: 'View activity',
        href: `/agents/${agent.id}`,
        agentId: agent.id,
      })
    }
  }
  if (!namedFailedAgent && failedIntents7d > 0) {
    items.push({
      id: 'payments-failed:unattributed',
      kind: 'payments-failed',
      tone: 'danger',
      badge: 'Failed',
      title: 'A payment failed',
      subtitle: 'A payment did not go through in the last 7 days.',
      actionLabel: 'View transactions',
      href: '/transactions',
    })
  }

  // ── 5. No backup signer (warning) — per account ─────────────────────────
  // `needs_backup_recommendation` is the server's answer (#1205) — false on
  // test networks by construction (`mainnet-gate.ts`), so the frontend keeps
  // no second copy of "which chains carry value". `funded: null` is an
  // unknown USDC read — never a nag.
  if (!backupDismissed) {
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
  }

  return items
}
