'use client'

import { ArrowRight, CircleAlert, CreditCard, FlaskConical, Star } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import Link from 'next/link'
import { useAuth, type UserSafe } from '@/context/AuthContext'
import { useUserSafes } from '@/hooks/useUserSafes'
import { useAgents } from '@/hooks/useAgents'
import { usePortfolio } from '@/hooks/usePortfolio'
import { usePreferences } from '@/hooks/usePreferences'
import { DEFAULT_CHAIN_ID } from '@/lib/chains'
import NetworkPill from '@/components/NetworkPill'
import { timeAgo } from '@/lib/format'
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
// set default, drill in. Shared legacy Safe COMPONENTS elsewhere are
// deletion slice #1989's scope, not this one's.
// ── Per-Safe card (handles its own portfolio fetch) ────────────────

function formatFiat(value: number, currency: 'USD' | 'EUR'): string {
  const symbol = currency === 'USD' ? '$' : '€'
  if (value === 0) return `${symbol}0.00`
  if (value < 0.01) return `< ${symbol}0.01`
  return `${symbol}${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

interface SafeCardProps {
  safe: UserSafe
  isActive: boolean
  showActiveBadge: boolean
  agentCount: number
  showDefaultBadge: boolean
  currency: 'USD' | 'EUR'
  staggerIndex: number
  onClick: () => void
  onSetActive: () => void
  onSetDefault: () => void
}

// Number of top-token rows we surface on the card before collapsing the rest
// into a "+N more" footnote. Three keeps the card height predictable across a
// row of cards regardless of how many tokens any single Safe holds.
const TOP_TOKENS_PREVIEW = 3

function SafeCard({
  safe,
  isActive,
  showActiveBadge,
  agentCount,
  showDefaultBadge,
  currency,
  staggerIndex,
  onClick,
  onSetActive,
  onSetDefault,
}: SafeCardProps) {
  const {
    totalUsd,
    totalEur,
    breakdown,
    loading: portfolioLoading,
  } = usePortfolio(safe.safe_address, { chainId: safe.chain_id })
  const fiatTotal = currency === 'USD' ? totalUsd : totalEur

  // The breakdown comes back sorted by value, but make it explicit so we never
  // accidentally show dust above a meaningful holding.
  const sortedBreakdown = [...breakdown].sort((a, b) => {
    const aValue = currency === 'USD' ? a.usdValue : a.eurValue
    const bValue = currency === 'USD' ? b.usdValue : b.eurValue
    return bValue - aValue
  })
  const visibleTokens = sortedBreakdown.slice(0, TOP_TOKENS_PREVIEW)
  const hiddenTokenCount = Math.max(0, sortedBreakdown.length - TOP_TOKENS_PREVIEW)

  return (
    <Link
      href={`/accounts/${safe.id}`}
      onClick={onClick}
      aria-label={safe.name}
      className={`v2-animate-stagger block ${entityCardClassName({ selected: isActive })} p-5 sm:p-6`}
      style={{
        ['--v2-stagger-delay' as string]: `${staggerIndex * 60}ms`,
      }}
    >
      {/* Active + default actions — stop link navigation for nested buttons. */}
      <div className="absolute top-3 right-3 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        {!isActive && (
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onSetActive() }}
            className="rounded-md px-2 py-1 text-xs font-medium text-[var(--v2-brand)] hover:bg-[var(--v2-brand-soft)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
            aria-label={`Set ${safe.name} as active`}
          >
            Set active
          </button>
        )}
        {!safe.is_default && (
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onSetDefault() }}
            className="p-1.5 rounded-md text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)] hover:bg-[var(--v2-surface-2)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
            aria-label={`Set ${safe.name} as default`}
          >
            <Icon icon={Star} className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Header — name + active / default chips */}
      <div className="mb-2 flex items-center gap-2 pr-12">
        <h3 className="truncate text-base font-semibold text-[var(--v2-ink)]">{safe.name}</h3>
        {showActiveBadge && (
          <span className="inline-flex flex-shrink-0 items-center gap-1 rounded bg-[var(--v2-success-soft)] px-1.5 py-0.5 text-xs font-medium text-[var(--v2-success)]">
            <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--v2-success)]" />
            Active
          </span>
        )}
        {showDefaultBadge && (
          <span className="flex-shrink-0 rounded bg-[var(--v2-brand-soft)] px-1.5 py-0.5 text-xs font-medium text-[var(--v2-brand)]">
            default
          </span>
        )}
      </div>

      {/* Caption — network + age. Replaces the raw 0x address that was too
          technical for an at-a-glance overview. */}
      <div className="mb-5 flex items-center gap-2 text-xs text-[var(--v2-ink-3)]">
        <NetworkPill chainId={safe.chain_id ?? DEFAULT_CHAIN_ID} />
        <span aria-hidden="true">{'·'}</span>
        <span>Added {timeAgo(safe.created_at)}</span>
      </div>

      {/* Fiat total */}
      <div className="mb-4" role="status" aria-busy={portfolioLoading} aria-live="polite">
        {portfolioLoading ? (
          <Skeleton className="h-7 w-28" />
        ) : (
          <p className="v2-tabular text-2xl font-semibold tracking-tight text-[var(--v2-ink)]">
            {formatFiat(fiatTotal, currency)}
          </p>
        )}
      </div>

      {/* Token breakdown preview — up to 3 top holdings plus a "+N more"
          overflow. Reserves a small minimum height so cards in the same row
          stay aligned even when one Safe is empty. */}
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
              const fiatValue = currency === 'USD' ? item.usdValue : item.eurValue
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
                    {formatFiat(fiatValue, currency)}
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
    </Link>
  )
}

// ── Main Component ──────────────────────────────────────────────────

export default function AccountsOverviewClient() {
  const { activeSafe, setActiveSafe } = useAuth()
  const { safes, setDefault } = useUserSafes()
  const { agents } = useAgents()
  const { currency } = usePreferences()

  // Count agents per Safe
  const agentCountBySafe = new Map<string, number>()
  for (const agent of agents) {
    if (agent.safe_id) {
      agentCountBySafe.set(agent.safe_id, (agentCountBySafe.get(agent.safe_id) ?? 0) + 1)
    }
  }

  // Count orphaned agents (no safe_id)
  const orphanedAgents = agents.filter((a) => !a.safe_id && a.status === 'active')

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Accounts"
        subtitle={
          safes.length > 0 ? (
            <>
              <span className="v2-tabular">{safes.length}</span> {safes.length === 1 ? 'account' : 'accounts'} linked
            </>
          ) : undefined
        }
      />

      {/* Orphaned agents warning */}
      {orphanedAgents.length > 0 && (
        <div className="flex items-center gap-2 px-4 py-3 mb-6 rounded-lg bg-[var(--v2-warning-soft)] border border-warning/20">
          <Icon icon={CircleAlert} className="h-4 w-4 text-[var(--v2-warning)] flex-shrink-0" />
          <span className="text-sm text-[var(--v2-warning)]">
            {orphanedAgents.length} agent{orphanedAgents.length !== 1 ? 's have' : ' has'} no linked account. Reassign them in the Agents page.
          </span>
        </div>
      )}

      {/* Safe cards grid */}
      {safes.length === 0 ? (
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
          body="Your account is created when you sign in, so you shouldn't normally see this. Reload the page, and get in touch if it stays empty."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {safes.map((safe, index) => (
            <SafeCard
              key={safe.id}
              safe={safe}
              isActive={activeSafe?.id === safe.id}
              showActiveBadge={activeSafe?.id === safe.id && safes.length > 1}
              agentCount={agentCountBySafe.get(safe.id) ?? 0}
              showDefaultBadge={!!safe.is_default && safes.length > 1}
              currency={currency}
              staggerIndex={index}
              onClick={() => setActiveSafe(safe)}
              onSetActive={() => setActiveSafe(safe)}
              onSetDefault={() => setDefault(safe.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
