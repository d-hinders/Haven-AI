'use client'

import { ArrowRight, CircleAlert, CreditCard, FlaskConical } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import Link from 'next/link'
import type { SmartAccount } from '@/context/AuthContext'
import { useAccounts } from '@/hooks/useAccounts'
import { useAgents } from '@/hooks/useAgents'
import { usePortfolio } from '@/hooks/usePortfolio'
import { usePreferences } from '@/hooks/usePreferences'
import { DEFAULT_CHAIN_ID } from '@/lib/chains'
import NetworkPill from '@/components/NetworkPill'
import { formatFiat, timeAgo } from '@/lib/format'
import { BalanceFreshnessIndicator } from '@/components/haven'
import { entityCardClassName } from '@/components/ui/entityCardStyles'
import { PageHeader } from '@/components/ui/PageHeader'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/ui/EmptyState'
import { truncateAddress } from '@/components/haven'

// The Safe-rail INFLOW IS CLOSED (#1984, epic #1440). `AddSafeModal` lived
// here and was the dashboard's only Safe entry point: a three-mode modal
// (choose / deploy / import) that POSTed /user/safes/deploy and then
// /user/safes. Both routes now answer 410, so the modal could only ever
// have shown the user an error — it is removed with its trigger rather than
// left as a door into a wall. Nothing Hybrid is lost: this modal never
// offered a delegation-rail account, and onboarding provisions one
// unconditionally. Accounts is now a read + manage surface: list, activate,
// drill in. Setting the default account lives on `/accounts/<id>` only, since
// #2374 dropped the card's unlabelled star. Shared legacy Safe COMPONENTS
// elsewhere are deletion slice #1989's scope, not this one's.
// ── Per-account card (handles its own portfolio fetch) ────────────────

interface AccountCardProps {
  account: SmartAccount
  agentCount: number
  showDefaultBadge: boolean
  currency: 'USD' | 'EUR' | 'SEK'
  staggerIndex: number
}

// Number of top-token rows we surface on the card before collapsing the rest
// into a "+N more" footnote. Three keeps the card height predictable across a
// row of cards regardless of how many tokens any single account holds.
const TOP_TOKENS_PREVIEW = 3

function AccountCard({
  account,
  agentCount,
  showDefaultBadge,
  currency,
  staggerIndex,
}: AccountCardProps) {
  const {
    totalUsd,
    totalEur,
    totalSek,
    breakdown,
    loading: portfolioLoading,
  } = usePortfolio(account.account_address, { chainId: account.chain_id })
  // #3295: the freshest — actually, the oldest — degraded marker among the
  // card's tokens. Any stale/unavailable token means the card's total is
  // computed partly from last-known values, so the whole total gets the
  // indicator; "Unavailable" only when some token has never been read.
  const degradedFreshness = breakdown.find((item) => item.balanceFreshness)?.balanceFreshness
  // SEK (#3127): `?? 0` as on every currency here — the wire's `totalSek` /
  // `sekValue` are optional and an absent key must degrade to 0, not crash.
  const fiatTotal = currency === 'USD' ? totalUsd : currency === 'EUR' ? totalEur : totalSek

  // The breakdown comes back sorted by value, but make it explicit so we never
  // accidentally show dust above a meaningful holding.
  const sortedBreakdown = [...breakdown].sort((a, b) => {
    const aValue = currency === 'USD' ? a.usdValue : currency === 'EUR' ? a.eurValue : a.sekValue
    const bValue = currency === 'USD' ? b.usdValue : currency === 'EUR' ? b.eurValue : b.sekValue
    return (bValue ?? 0) - (aValue ?? 0)
  })
  const visibleTokens = sortedBreakdown.slice(0, TOP_TOKENS_PREVIEW)
  const hiddenTokenCount = Math.max(0, sortedBreakdown.length - TOP_TOKENS_PREVIEW)

  return (
    <div
      data-testid="account-card"
      className={`v2-animate-stagger ${entityCardClassName({ linked: true })} p-5 sm:p-6`}
      style={{
        ['--v2-stagger-delay' as string]: `${staggerIndex * 60}ms`,
      }}
    >
      {/*
        Header — the account's identity. The card holds no action since #3719
        retired "Set active" with the global active account: the whole card is
        a link to `/accounts/<id>`, where "Set as default" lives (#2374). The
        name keeps #2223's wrapping row — `flex-wrap` around a `min-w-0
        truncate` `h3` — so a long name truncates against the container.
      */}
      <div className="mb-2 flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <h3 className="min-w-0 truncate text-base font-semibold text-[var(--v2-ink)]">
            <Link
              href={`/accounts/${account.id}`}
              title={account.name}
              className="block min-w-0 truncate rounded-sm after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
            >
              {account.name}
            </Link>
          </h3>
          {/*
            Beside the name, never on the caption line: the caption already
            measures ~255px of a 265px card at 1280 (#2235).
          */}
          {showDefaultBadge && (
            <span className="flex-shrink-0 rounded bg-[var(--v2-brand-soft)] px-1.5 py-0.5 text-xs font-medium text-[var(--v2-brand)]">
              default
            </span>
          )}
        </div>
      </div>

      {/* Caption — network + age. Replaces the raw 0x address that was too
          technical for an at-a-glance overview. `flex-wrap` because this line
          is already close to full at the 3-up breakpoint: `● Base Sepolia · Added
          4mo ago` measures ~255px in a 265px card, which is exactly why
          #2235's `default` could not join it. */}
      <div className="mb-5 flex flex-wrap items-center gap-2 text-xs text-[var(--v2-ink-3)]">
        <NetworkPill chainId={account.chain_id ?? DEFAULT_CHAIN_ID} />
        <span aria-hidden="true">{'\u00b7'}</span>
        <span>Added {timeAgo(account.created_at)}</span>
      </div>

      {/* Fiat total — carries the stale indicator when any token's balance
          read failed (#3295): the figure is the last-known value, not a
          fresh one, and "Unavailable" only replaces it when nothing is
          known. A clean read renders no indicator at all. */}
      <div className="mb-4" role="status" aria-busy={portfolioLoading} aria-live="polite">
        {portfolioLoading ? (
          <Skeleton className="h-7 w-28" />
        ) : (
          <div className="flex flex-wrap items-baseline gap-2">
            <p className="v2-tabular text-2xl font-semibold tracking-tight text-[var(--v2-ink)]">
              {formatFiat(fiatTotal, currency)}
            </p>
            {degradedFreshness && (
              <span className="relative z-[var(--v2-z-content)]">
                <BalanceFreshnessIndicator freshness={degradedFreshness} size="compact" />
              </span>
            )}
          </div>
        )}
      </div>

      {/* Token breakdown preview — up to 3 top holdings plus a "+N more"
          overflow. Reserves a small minimum height so cards in the same row
          stay aligned even when one account is empty. */}
      <div className="mb-4 min-h-[68px] space-y-1.5">
        {portfolioLoading ? (
          <>
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-3/4" />
          </>
        ) : visibleTokens.length === 0 ? (
          <p className="text-xs text-[var(--v2-ink-3)]">
            No funds yet &mdash; receive to get started.
          </p>
        ) : (
          <>
            {visibleTokens.map((item) => {
              const fiatValue = currency === 'USD' ? item.usdValue : currency === 'EUR' ? item.eurValue : item.sekValue
              return (
                <div
                  key={item.symbol}
                  className="flex items-center justify-between gap-3 text-xs text-[var(--v2-ink-2)]"
                >
                  <span className="truncate">
                    <span className="font-medium text-[var(--v2-ink)]">{item.symbol}</span>{' '}
                    <span className="v2-tabular text-[var(--v2-ink-3)]">{item.formatted}</span>
                  </span>
                  <span className="v2-tabular flex-shrink-0 text-[var(--v2-ink-3)]">
                    {formatFiat(fiatValue ?? 0, currency)}
                  </span>
                </div>
              )
            })}
            {hiddenTokenCount > 0 && (
              <p className="text-xs text-[var(--v2-ink-3)]">+ {hiddenTokenCount} more</p>
            )}
          </>
        )}
      </div>

      {/* Footer chip row — agent count + Open affordance */}
      <div className="flex items-center justify-between gap-3 border-t border-[var(--v2-border)] pt-3 text-xs text-[var(--v2-ink-3)]">
        <span className="flex items-center gap-1.5">
          <Icon icon={FlaskConical} className="h-3.5 w-3.5" />
          {agentCount} agent{agentCount !== 1 ? 's' : ''}
        </span>
        <span className="inline-flex items-center gap-1 font-medium text-[var(--v2-brand)] opacity-70 transition-opacity group-hover:opacity-100">
          Open
          <Icon icon={ArrowRight} className="h-3.5 w-3.5" />
        </span>
      </div>
    </div>
  )
}

// ── Main Component ──────────────────────────────────────────────────

export default function AccountsOverviewClient() {
  const { accounts: accounts } = useAccounts()
  const { agents } = useAgents()
  const { currency } = usePreferences()

  // Count agents per account
  const agentCountByAccount = new Map<string, number>()
  for (const agent of agents) {
    if (agent.account_id) {
      agentCountByAccount.set(agent.account_id, (agentCountByAccount.get(agent.account_id) ?? 0) + 1)
    }
  }

  // Count orphaned agents (no account_id)
  const orphanedAgents = agents.filter((a) => !a.account_id && a.status === 'active')

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Accounts"
        subtitle={
          accounts.length > 0 ? (
            <>
              <span className="v2-tabular">{accounts.length}</span> {accounts.length === 1 ? 'account' : 'accounts'} linked
            </>
          ) : undefined
        }
      />

      {/* Orphaned agents warning */}
      {orphanedAgents.length > 0 && (
        <div className="flex items-center gap-2 px-4 py-3 mb-6 rounded-lg bg-[var(--v2-warning-soft)] border border-warning/20">
          <Icon icon={CircleAlert} className="h-4 w-4 text-[var(--v2-warning)] flex-shrink-0" />
          <span className="text-sm text-[var(--v2-warning)]">
            {orphanedAgents.length} agent{orphanedAgents.length !== 1 ? 's have' : ' has'} no linked account. Review them in the Agents page.
          </span>
        </div>
      )}

      {/* Account cards grid */}
      {accounts.length === 0 ? (
        // An empty state with no next step would be a dead end, which the
        // design system forbids — so this one explains itself instead. There
        // is no "Add account" button any more (#1984: the Safe rail is
        // retired and its deploy/import routes answer 410), and there is
        // nothing to put in its place: an account is created at sign-in.
        // ProtectedRoute redirects a user with no accounts to /onboarding, so
        // this should be unreachable in practice; the copy says so rather
        // than leaving a blank card that reads as broken.
        <EmptyState
          icon={<Icon icon={CreditCard} className="h-5 w-5" />}
          tone="neutral"
          title="No Haven accounts yet"
          body="Your Haven account is created when you sign in, so you shouldn't normally see this. Try reloading the page."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {accounts.map((account, index) => (
            <AccountCard
              key={account.id}
              account={account}
              agentCount={agentCountByAccount.get(account.id) ?? 0}
              showDefaultBadge={!!account.is_default && accounts.length > 1}
              currency={currency}
              staggerIndex={index}
            />
          ))}
        </div>
      )}
    </div>
  )
}
