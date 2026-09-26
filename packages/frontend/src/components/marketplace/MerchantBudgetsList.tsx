'use client'

/**
 * "Remaining this period", per agent, for a merchant's merchant-locked
 * budgets (#3331) — `GET /merchants/{slug}/budgets`, dashboard session only.
 * Renders nothing when there is nothing to show: a merchant with no
 * merchant-locked budgets carries no section at all, the same "nothing
 * yet" absence `DelegationBudgetCard` uses for a fresh agent.
 */

import { formatUnits } from 'viem'
import { StatusBadge, type StatusTone } from '@/components/ui/StatusBadge'
import { truncateAddress } from '@/components/haven'
import { chainName } from '@/lib/marketplace'
import { getChainConfig } from '@/lib/chains'
import type { MerchantBudget } from '@/hooks/useMerchantBudgets'

const PIN_STATUS_COPY: Record<MerchantBudget['pin_status'], { label: string; tone: StatusTone; helper: string }> = {
  current: { label: 'Current', tone: 'success', helper: '' },
  stale: {
    label: 'Stale',
    tone: 'warning',
    helper: 'This merchant now pays to a different address. This budget still pays only the old one.',
  },
  unverified: {
    label: 'Unverified',
    tone: 'warning',
    helper: 'Haven can no longer confirm one payment address for this merchant here.',
  },
  not_erc7710: {
    label: 'Unsupported now',
    tone: 'warning',
    helper: 'This merchant no longer accepts this budget’s payment method here.',
  },
}

function tokenSymbol(chainId: number, tokenAddress: string): string {
  try {
    const cfg = getChainConfig(chainId)
    const token = Object.values(cfg.tokens).find((t) => t.address?.toLowerCase() === tokenAddress.toLowerCase())
    return token?.symbol ?? 'tokens'
  } catch {
    return 'tokens'
  }
}

function tokenDecimals(chainId: number, tokenAddress: string): number {
  try {
    const cfg = getChainConfig(chainId)
    const token = Object.values(cfg.tokens).find((t) => t.address?.toLowerCase() === tokenAddress.toLowerCase())
    return token?.decimals ?? 18
  } catch {
    return 18
  }
}

export function MerchantBudgetsList({ budgets }: { budgets: MerchantBudget[] }) {
  if (budgets.length === 0) return null

  return (
    <section>
      <h2 className="mb-2 text-sm font-semibold text-[var(--v2-ink)]">Agent budgets for this merchant</h2>
      <ul className="space-y-2" data-testid="merchant-budgets-list">
        {budgets.map((b) => {
          const decimals = tokenDecimals(b.chain_id, b.token_address)
          const symbol = tokenSymbol(b.chain_id, b.token_address)
          const remaining = formatUnits(BigInt(b.remaining_atomic), decimals)
          const total = formatUnits(BigInt(b.budget_atomic), decimals)
          const status = PIN_STATUS_COPY[b.pin_status]
          return (
            <li
              key={b.delegation_hash}
              data-testid={`merchant-budget-${b.agent_id}`}
              className="rounded-xl border border-[var(--v2-border)] bg-[var(--v2-bg)] p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-[var(--v2-ink)]">{b.agent_name}</p>
                <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
              </div>
              <p className="mt-1 text-sm text-[var(--v2-ink-2)]">
                {remaining} {symbol} left of {total} {symbol} this period
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
