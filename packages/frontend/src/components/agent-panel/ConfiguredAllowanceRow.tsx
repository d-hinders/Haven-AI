'use client'

import { type AgentAllowance } from '@/hooks/useAgents'
import { budgetPeriodLabel } from '@/lib/budget-period'
import { formatConfiguredAllowance } from './agent-display'

/**
 * The agent's granted budget, rendered from the `agent.allowances` array.
 *
 * ── What the number actually is, and why the caption changed (#2224) ─────────
 *
 * This row was captioned **"Configured in Haven"**, which says Haven holds the
 * limit. Traced to the code that emits the value, that is false on every path
 * that can reach this component today:
 *
 *   - `GET /agents` and `GET /agents/:id` fill `allowances` from
 *     `deriveDelegationAllowances` (`backend/src/routes/agents.ts:85-98` and
 *     `:113-121`), which is `rails/delegation-budget-view.ts` projecting the
 *     agent's **ACTIVE `agent_delegations` rows** — `budget_atomic` →
 *     `allowance_amount`, `period_seconds / 60` → `reset_period_min`. Those are
 *     the terms of a delegation the user SIGNED, enforced by the caveat
 *     enforcers during redemption. That file's own header says it: *"Read/
 *     reporting path ONLY: enforcement stays the on-chain delegation."*
 *   - A legacy-rail agent gets `allowances: []` outright — the `agent_allowances`
 *     read surface is retired (#1440/#2020, `infra/repositories/agents.ts:232-237`),
 *     so no row renders here at all and the card shows "No agent budget
 *     configured".
 *
 * So the array is never a Haven-side policy mirror. It is an on-chain-enforced
 * envelope, reported. The caption inverted the one claim Haven makes everywhere
 * else — `/custody` exists to say the limit is enforced by the account and not
 * by Haven's database.
 *
 * **The wording is not new.** `/custody` already labels this exact data
 * "Agent spend authority (enforced on-chain)" and states the honesty caveat
 * that applies here unchanged: *"These are the terms of the delegation you
 * signed"* — the signed terms, not a fresh chain read. Inventing a third
 * phrasing for one fact is the defect #2195 just fixed one surface over, so
 * this reuses `/custody`'s.
 *
 * ── Why the "fallback" framing in the old header was wrong too ───────────────
 *
 * The configured budget row is the ordinary delegation-rail rendering.
 *
 * **Deliberately renders no bar (#1846).** `AgentAllowance` carries
 * `allowance_amount` and `reset_period_min` and nothing else — there is no
 * spend figure on this shape, so there is no proportion to draw. The rule that
 * used to sit here was `h-full w-full`: the same 3px geometry as the retired
 * on-chain meter deleted in #2848 (epic #1440) with its off-chain mirror,
 * permanently pegged at 100%, a meter that renders identically whatever
 * is true. It read as "fully spent" (or as a live meter that happens to be
 * pegged) when what is actually known is only the granted envelope.
 *
 * The component keeps its name: it is named for its INPUT (the configured
 * `allowances` projection), not for the claim it makes about it, and the claim
 * was the defect.
 */
/**
 * The caption, exported so the test can assert the rendered string without
 * restating it, and so a future third surface reuses it rather than minting a
 * fourth phrasing. The independently-restated literal lives in
 * `ConfiguredAllowanceRow.test.tsx`, which is what can catch an unintended copy
 * change.
 */
export const GRANTED_BUDGET_CAPTION = 'Enforced on-chain'

export function ConfiguredAllowanceRow({
  allowance,
  chainId,
}: {
  allowance: AgentAllowance
  chainId: number
}) {
  const reset = budgetPeriodLabel(allowance.reset_period_min)

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium text-[var(--v2-ink-2)]">{allowance.token_symbol}</span>
        <span className="text-right text-[var(--v2-ink-3)]">
          <span className="v2-tabular">{formatConfiguredAllowance(allowance, chainId)}</span>
          {` ${allowance.token_symbol}`}
          {allowance.reset_period_min > 0 ? ` ${reset}` : ''}
        </span>
      </div>
      <p className="text-xs text-[var(--v2-ink-3)]">{GRANTED_BUDGET_CAPTION}</p>
    </div>
  )
}
