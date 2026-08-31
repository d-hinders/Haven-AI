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
 * Parity with the connector (#1426): `describeResetPeriod` in
 * `packages/connect/src/runtime.ts` phrases every dashboard-offered period
 * with this file's sentence words ("per week", "per month", "in total") and
 * its tests pin each one. The mapping is deliberately duplicated, not shared:
 * connect is a published package and the only shared home would be the
 * PRIVATE `@haven_ai/core` — the tests are the coupling.
 *
 * ── Which `allowance_amount` shape callers actually pass (#2295) ─────────────
 *
 * That field carries two incompatible shapes across the API, and this
 * docstring used to name only one of them ("the raw on-chain bigint string").
 * True for every current caller, false for the field in general — which is
 * exactly the memory-not-contract gap that made #2283 a production bug.
 *
 * Both call sites pass the ATOMIC shape, because both describe a connect-setup
 * budget REQUEST rather than an agent's derived budget view:
 * `SetupStates.tsx`'s `SetupDoneState` and `LocalConnectionReady.tsx`, each
 * mapping over `setupStatus.agent_budget` from `GET /agent-connection-setups/*`
 * — whose schema is `allowanceAtomicAmount`. (The two unmigrated describers
 * named above, `DelegationApprovalStep` and `useAgentConnectionSetup`'s prompt
 * builder, read the same atomic `agent_budget` rows.)
 *
 * No caller passes the human-decimal `AgentAllowance` projection today. If one
 * ever does, it renders correctly anyway — see below — but this list is what
 * makes the claim checkable rather than remembered.
 *
 * It is nonetheless safe against the other shape and must stay so:
 * `formatAllowanceForToken` hands the string to `formatAllowanceAmount`, which
 * takes an atomic-bigint primary path and a decimal-string secondary path
 * explicitly, never by catching a `BigInt` throw. Either shape renders. What
 * this function needs the chain for is the atomic case — resolving the token's
 * decimals to divide by.
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
