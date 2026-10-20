/**
 * The Agents tab's one-line budget snapshot (#4097, epic #4093).
 *
 * The mockup's line: "5 agents can spend up to 27.01 USDC per day from this
 * account" — the account's agents, the total they can spend in ONE shared
 * period. When the budgets do not share a period, the line stops claiming a
 * number and just counts: "5 agents with budgets" (the owner's wording, the
 * issue's example). No budgets at all keeps the request-payment framing the
 * old "Agent access" card used — a budget-less agent can still request; its
 * budget is what stops it.
 *
 * Sums are in TOKEN units when every budget shares one token (the mockup's
 * "27.01 USDC"), because that is what the user set and no conversion can
 * round it; mixed-token accounts are summed in the display currency through
 * the #3803 spot rates (the agent rows beside it read in their own token
 * since #4165, so this line is the only converted figure). A missing rate
 * never produces a guessed figure — the line falls back to the count.
 */
import type { DashboardAgent } from '@/components/haven'
import { hasPositiveCap } from '@/lib/dashboard-attention'
import { budgetPeriodLabel } from '@/lib/budget-period'
import { formatFiat } from '@/lib/format'
import type { DisplayCurrency } from '@/lib/account-holdings'

/** `27.01` — a token-unit figure, up to two fraction digits, no separators. */
function formatTokenUnits(value: number): string {
  return value.toFixed(2)
}

function agentCountWord(count: number): string {
  return `${count} agent${count === 1 ? '' : 's'}`
}

/**
 * The summary line. `agents` are the account's agents from the dashboard
 * overview (revoked agents are not in the overview at all); `spotRates` is
 * the overview's #3803 map, priced in `currency`.
 */
export function agentSpendSummaryLine(
  agents: readonly DashboardAgent[],
  currency: DisplayCurrency,
  spotRates: Readonly<Record<string, number | null>> | undefined,
): string {
  const count = agents.length
  if (count === 0) return ''
  const base = agentCountWord(count)

  // The overview carries only live budgets (#3802), and a zero cap is no
  // authority (#3802's rule) — neither belongs in a spending total.
  const budgets = agents.flatMap((agent) => (agent.budgets ?? []).filter((b) => hasPositiveCap(b.budgetAtomic)))
  if (budgets.length === 0) {
    return `${base} can request payments from this account.`
  }

  // One shared period is what makes a per-period TOTAL honest: summing a
  // daily cap with a weekly cap would state a number no single window
  // describes. One-time grants (a non-repeating periodSeconds) do not share
  // a window either — they fall back with the mixed case.
  const periodSeconds = budgets[0].periodSeconds
  const sharedPeriod =
    periodSeconds > 0 && budgets.every((budget) => budget.periodSeconds === periodSeconds)
  if (!sharedPeriod) {
    return `${base} with budgets.`
  }
  const periodWord = budgetPeriodLabel(periodSeconds / 60)

  const sameToken =
    budgets.every((budget) => budget.tokenSymbol === budgets[0].tokenSymbol) &&
    budgets.every((budget) => budget.decimals === budgets[0].decimals)
  if (sameToken) {
    const atomicTotal = budgets.reduce((sum, budget) => sum + Number(budget.budgetAtomic), 0)
    const total = atomicTotal / 10 ** budgets[0].decimals
    return `${base} can spend up to ${formatTokenUnits(total)} ${budgets[0].tokenSymbol} ${periodWord} from this account.`
  }

  // Mixed tokens: sum in the display currency through the #3803 spot rates.
  // Any missing or unusable rate keeps the figure unclaimed — a total built
  // on a guessed price is worse than no total.
  let fiatTotal = 0
  for (const budget of budgets) {
    const rate = spotRates?.[budget.tokenSymbol]
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
      return `${base} with budgets.`
    }
    fiatTotal += (Number(budget.budgetAtomic) / 10 ** budget.decimals) * rate
  }
  return `${base} can spend up to ${formatFiat(fiatTotal, currency)} ${periodWord} from this account.`
}
