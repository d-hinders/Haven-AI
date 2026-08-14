import { RESET_PERIODS } from './allowance-module'
import { formatAllowanceForToken } from './allowance-format'

/**
 * Human phrasing for an allowance/budget reset period, shared by the
 * connect-agent flow and the agent panel (#989 pattern absorption — the same
 * mapping used to be copied into each component).
 */
export function budgetPeriodLabel(mins: number): string {
  const label = (RESET_PERIODS.find((period) => period.value === mins)?.label ?? `${mins}m`).toLowerCase()
  if (label === 'one-time') return 'total budget'
  if (label === 'daily') return 'per day'
  if (label === 'weekly') return 'per week'
  if (label === 'monthly') return 'per month'
  return `every ${label}`
}

/**
 * One budget grant in words: `"25 USDC per day"`.
 *
 * #1394 pattern absorption. The connect flow describes the same grant on the
 * pre-approval screen and again on the approved screen, and the connector says
 * it a third time in the agent's own terminal ("I can now spend up to 25 USDC
 * per day from your Haven wallet"). Three surfaces describing one authority is
 * exactly where wording drifts — a user who reads "25 USDC per day" before
 * approving and "25 USDC daily" after has to wonder whether they are the same
 * number.
 *
 * Scope of the absorption, precisely: the two screens a user sees back to back
 * in this flow (`LocalConnectionReady`, `SetupDoneState`). Four call sites
 * hand-assemble `amount + symbol + period`; the other two —
 * `useAgentConnectionSetup`'s manual-credential PROMPT builder and
 * `DelegationApprovalStep` — are not migrated, because they need only the
 * label form and neither sits beside the other in a single viewport. Worth
 * folding in later; not claimed as done.
 *
 * Parity with the connector holds for the periods this flow actually offers on
 * the delegation rail (daily/weekly/monthly, one-time on legacy). It is NOT
 * total: the connector's own `describeResetPeriod` special-cases only 1440, 60
 * and 0, so a weekly budget prints "per 10080 minutes" in the agent's terminal
 * against "per week" here. That divergence lives in `packages/connect` and is
 * tracked separately rather than silently claimed as fixed.
 *
 * `allowance_amount` is the raw on-chain bigint string, so formatting needs the
 * chain to resolve the token's decimals.
 */
export function describeBudgetGrant(
  budget: { allowance_amount: string; token_symbol: string; reset_period_min: number },
  chainId: number | null | undefined,
  options: { form?: 'label' | 'sentence' } = {},
): string {
  const amount = formatAllowanceForToken(budget.allowance_amount, chainId, budget.token_symbol)
  const period = budgetPeriodLabel(budget.reset_period_min)
  // `budgetPeriodLabel` is built for a LABEL slot ("Budget: 10 USDC total
  // budget"), and one of its outputs is a noun phrase. Dropped into a sentence
  // that reads "…can now spend up to 10 USDC total budget from Operating
  // wallet" — broken grammar on the flow's payoff screen. Sentence callers get
  // the adverbial form. Only the one-time case differs; every other label
  // ("per day", "every 60m") is already adverbial.
  const phrase = options.form === 'sentence' && period === 'total budget' ? 'in total' : period
  return `${amount} ${budget.token_symbol} ${phrase}`
}
