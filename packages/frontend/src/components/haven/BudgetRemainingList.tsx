'use client'

/**
 * The dashboard's budget-remaining rows (#3804).
 *
 * Renders the wire shape `GET /dashboard/budget-remaining` returns. The one
 * rule that matters is the UNKNOWN state: when `remaining_from_chain` is
 * false, `remaining_atomic` and `used_atomic` are NULL and the row shows
 * "unavailable" — it must NOT render "0 … left" (a perfectly-funded budget
 * read as spent), NOT render "<budget> … left" (the pre-#1145 fallback that
 * states the full budget as a fact), and NOT render a meter (a meter needs a
 * used measurement; the fallback's used value is a fabrication, exactly why
 * `DelegationBudgetCard`'s unknown usage is `{ kind: 'none' }`).
 *
 * The "… left" copy and the meter for KNOWN reads are the same vocabulary the
 * rest of the budget surfaces speak (`MerchantBudgetsList`, `BudgetMeter`) —
 * one measurement, one bar. Sub-budget spend renders as its own caption: it
 * is a FLOOR (spend that wasn't recorded against a `sub_budget_id` cannot be
 * attributed), never a claim of completeness.
 */

import { formatUnits } from 'viem'
import { BudgetMeter } from './BudgetMeter'
import type { ApiSchema } from '@haven_ai/core'

export type DashboardBudgetRemainingEntry = ApiSchema<'DashboardBudgetRemainingEntry'>

export interface BudgetRemainingListProps {
  budgets: DashboardBudgetRemainingEntry[]
}

function isKnown(entry: DashboardBudgetRemainingEntry): entry is DashboardBudgetRemainingEntry & {
  remaining_atomic: string
  used_atomic: string
  read_at: string
} {
  return entry.remaining_from_chain && entry.remaining_atomic !== null && entry.used_atomic !== null
}

function BudgetRemainingRow({ budget }: { budget: DashboardBudgetRemainingEntry }) {
  const heading = `${budget.token_symbol} budget`
  return (
    <li data-chain-id={budget.chain_id} data-delegation-hash={budget.delegation_hash}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm text-[var(--v2-ink-2)]">{heading}</span>
        {isKnown(budget) ? (
          <span className="text-sm font-medium tabular-nums">
            {`${formatUnits(BigInt(budget.remaining_atomic), budget.token_decimals)} ${budget.token_symbol} left`}
          </span>
        ) : (
          <span className="text-sm text-[var(--v2-ink-3)]">Remaining unavailable</span>
        )}
      </div>
      {isKnown(budget) && (
        <BudgetMeter
          usedPercent={
            budget.budget_atomic === '0'
              ? 0
              : (Number(BigInt(budget.used_atomic)) / Number(BigInt(budget.budget_atomic))) * 100
          }
          label={`${budget.token_symbol} budget used`}
          caption={`${formatUnits(BigInt(budget.used_atomic), budget.token_decimals)} of ${formatUnits(BigInt(budget.budget_atomic), budget.token_decimals)} ${budget.token_symbol} used this period`}
        />
      )}
      {!isKnown(budget) && (
        // Nothing else renders here on purpose: no "0 left", no full-budget
        // fallback, no meter. See the module comment.
        <p className="text-xs text-[var(--v2-ink-3)]">
          The live read is unavailable right now — the last known amount is not shown as a fact.
        </p>
      )}
      {budget.sub_budget_spend.length > 0 && (
        <p className="mt-1 text-xs text-[var(--v2-ink-3)]">
          {`At least ${formatUnits(
            budget.sub_budget_spend.reduce((sum, s) => sum + BigInt(s.spent_atomic), 0n),
            budget.token_decimals,
          )} ${budget.token_symbol} spent through sub-budgets this period`}
        </p>
      )}
    </li>
  )
}

export function BudgetRemainingList({ budgets }: BudgetRemainingListProps) { // design-system-exempt: a live-data wire composite (#3804) — its visual pieces (BudgetMeter, the v2 tokens) are the registered primitives; the list itself renders GET /dashboard/budget-remaining's entries and its unknown state, which no static gallery section can exercise
  if (budgets.length === 0) {
    return <p className="text-sm text-[var(--v2-ink-3)]">No budgets yet.</p>
  }
  return (
    <ul className="space-y-3">
      {budgets.map((budget) => (
        <BudgetRemainingRow
          key={`${budget.chain_id}:${budget.delegation_hash}`}
          budget={budget}
        />
      ))}
    </ul>
  )
}

export default BudgetRemainingList // design-system-exempt: same live-data wire composite as above (#3804)
