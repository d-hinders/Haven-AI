'use client'

/**
 * "Remaining this period", per agent, for a merchant's merchant-locked
 * budgets (#3331) — `GET /merchants/{slug}/budgets`, dashboard session only.
 * Renders nothing when there is nothing to show: a merchant with no
 * merchant-locked budgets carries no section at all, the same "nothing
 * yet" absence `DelegationBudgetCard` uses for a fresh agent.
 */

import Link from 'next/link'
import { formatUnits } from 'viem'
import { StatusBadge, type StatusTone } from '@/components/ui/StatusBadge'
import { truncateAddress } from '@/components/haven'
import { chainName } from '@/lib/marketplace'
import { getChainConfig } from '@/lib/chains'
import type { MerchantBudget } from '@/hooks/useMerchantBudgets'

/**
 * #3331 review finding design-7: plain labels, and ONE outcome sentence each
 * that says who pays now / what happens — never "pinning", "recipient" or
 * jargon about the mechanism.
 */
const PIN_STATUS_COPY: Record<MerchantBudget['pin_status'], { label: string; tone: StatusTone; helper: string }> = {
  current: { label: 'Current', tone: 'success', helper: '' },
  stale: {
    label: 'Old address',
    tone: 'warning',
    helper:
      "This merchant now uses a new address. Payments there come from the agent's open budget, if it has one — this budget still only pays the old address.",
  },
  unverified: {
    label: 'Address unconfirmed',
    tone: 'warning',
    helper: "This budget still pays the address it was set up with, but Haven cannot confirm it is still the merchant's.",
  },
  not_erc7710: {
    label: "Can't pay now",
    tone: 'warning',
    // Design review round 2, finding 4: state the outcome AND the next step —
    // not just that this budget stopped working.
    helper:
      "Payments to this merchant now go through the agent's open budget instead, if it has one. To fund it again, stop this budget, then fund it from the merchant's page.",
  },
}

function resolveToken(chainId: number, tokenAddress: string): { symbol: string; decimals: number } | null {
  try {
    const cfg = getChainConfig(chainId)
    const token = Object.values(cfg.tokens).find((t) => t.address?.toLowerCase() === tokenAddress.toLowerCase())
    return token ? { symbol: token.symbol, decimals: token.decimals } : null
  } catch {
    return null
  }
}

export function MerchantBudgetsList({ budgets }: { budgets: MerchantBudget[] }) {
  if (budgets.length === 0) return null

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-[var(--v2-ink)]">Agent budgets for this merchant</h2>
      <ul className="space-y-2" data-testid="merchant-budgets-list">
        {budgets.map((b) => {
          // #3331 review finding F8: an unknown token must not silently read
          // as 18-decimal "tokens" — that renders a WRONG figure, not just an
          // unlabelled one. Show the raw atomic amounts and say so instead.
          const resolved = resolveToken(b.chain_id, b.token_address)
          const status = PIN_STATUS_COPY[b.pin_status]
          return (
            <li
              key={b.delegation_hash}
              data-testid={`merchant-budget-${b.agent_id}`}
              className="rounded-xl border border-[var(--v2-border)] bg-[var(--v2-bg)] p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                {/* #3331 review finding design-7: the agent name links to its page. */}
                <Link
                  href={`/agents/${b.agent_id}`}
                  className="text-sm font-medium text-[var(--v2-brand)] hover:underline"
                >
                  {b.agent_name}
                </Link>
                <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
              </div>
              <p className="v2-tabular mt-1 text-sm text-[var(--v2-ink-2)]">
                {resolved
                  ? `${formatUnits(BigInt(b.remaining_atomic), resolved.decimals)} ${resolved.symbol} left of ${formatUnits(BigInt(b.budget_atomic), resolved.decimals)} ${resolved.symbol} this period`
                  : `${b.remaining_atomic} left of ${b.budget_atomic} this period (unknown token)`}
              </p>
              <p className="mt-0.5 text-xs text-[var(--v2-ink-3)]">
                {chainName(b.chain_id)} · to {truncateAddress(b.recipient_address)}
              </p>
              {!b.remaining_is_from_chain && (
                <p className="mt-1 text-xs text-[var(--v2-ink-3)]">
                  Haven could not confirm the live figure just now — showing the full budget.
                </p>
              )}
              {status.helper && <p className="mt-1 text-xs text-[var(--v2-ink-3)]">{status.helper}</p>}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
