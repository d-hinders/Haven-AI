'use client'

import { useState } from 'react'
import { Bot, CircleAlert, CreditCard, Plus } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import Link from 'next/link'
import type { SmartAccount } from '@/context/AuthContext'
import { useAccounts } from '@/hooks/useAccounts'
import { useAgents } from '@/hooks/useAgents'
import { usePortfolio } from '@/hooks/usePortfolio'
import { usePreferences } from '@/hooks/usePreferences'
import { DEFAULT_CHAIN_ID } from '@/lib/chains'
import { formatFiat, timeAgo } from '@/lib/format'
import { isTestnetChain } from '@/lib/marketplace'
import { hasNonZeroBalance } from '@/lib/portfolio-breakdown'
import { BalanceFreshnessIndicator } from '@/components/haven'
import { entityCardClassName } from '@/components/ui/entityCardStyles'
import { PageHeader } from '@/components/ui/PageHeader'
import { Skeleton } from '@/components/ui/Skeleton'
import { EmptyState } from '@/components/ui/EmptyState'
import { Button } from '@/components/ui/Button'
import ReceiveDialog from '@/components/ReceiveDialog'
import NewAccountDialog from '@/components/NewAccountDialog'

// The Safe-rail INFLOW IS CLOSED (#1984, epic #1440). `AddSafeModal` lived
// here and was the dashboard's only Safe entry point: a three-mode modal
// (choose / deploy / import) that POSTed /user/safes/deploy and then
// /user/safes. Both routes now answer 410, so the modal was removed with its
// trigger rather than left as a door into a wall. Shared legacy Safe
// COMPONENTS elsewhere are deletion slice #1989's scope, not this one's.
//
// The create action that exists now is a different thing (#4024, epic #4022):
// "New account" in the header opens `NewAccountDialog`, which creates an
// ADDITIONAL delegation-rail account from a passkey one of the user's
// accounts already has (#4023's create-additional request). It never touches
// a Safe route and never creates the default account. Setting the default
// account lives on `/accounts/<id>` only, since #2374 dropped the card's
// unlabelled star. The overview layout around it is #4021's.

// ── Per-account card (handles its own portfolio fetch) ────────────────

interface AccountCardProps {
  account: SmartAccount
  agentCount: number
  showDefaultBadge: boolean
  currency: 'USD' | 'EUR' | 'SEK'
  staggerIndex: number
}

/**
 * #4021: a row hides on its RAW `balance`, never its fiat value — a held but
 * unpriced token has fiat 0 and must still render. The exact test is the
 * shared `hasNonZeroBalance` (lib/portfolio-breakdown.ts), the same predicate
 * the account detail page's token list filters on.
 */

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
    lastOutgoingAt,
    loading: portfolioLoading,
  } = usePortfolio(account.account_address, { chainId: account.chain_id })
  const [receiveOpen, setReceiveOpen] = useState(false)
  // #3295: the freshest — actually, the oldest — degraded marker among the
  // card's tokens. Any stale/unavailable token means the card's total is
  // computed partly from last-known values, so the whole total gets the
  // indicator; "Unavailable" only when some token has never been read. This
  // deliberately reads the FULL breakdown (#4021): hiding an unavailable
  // filler ROW must not drop the total's "Unavailable" marker.
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
  // #4021: rows exist only to BREAK DOWN a total — a single non-zero token IS
  // the headline, so it renders no rows (the old card repeated the balance as
  // a USDC row). Two or more holdings get one row each, valued in the user's
  // currency; a token with a zero RAW balance never renders at all.
  const tokensWithFunds = sortedBreakdown.filter(hasNonZeroBalance)
  const showTokenRows = tokensWithFunds.length >= 2

  return (
    <div
      data-testid="account-card"
      className={`v2-animate-stagger ${entityCardClassName({ linked: true })} flex flex-col p-5 sm:p-6`}
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
            Beside the name, never on a caption line (#4021 removed the
            "Added {timeAgo}" caption): the "Test network" chip takes the
            badge slot on testnets only, and mainnet renders no network marker
            at all — no chain jargon on a primary surface (epic #3801).
          */}
          {isTestnetChain(account.chain_id ?? DEFAULT_CHAIN_ID) && (
            <span className="flex-shrink-0 rounded bg-[var(--v2-surface-2)] px-1.5 py-0.5 text-xs font-medium text-[var(--v2-ink-2)]">
              Test network
            </span>
          )}
          {showDefaultBadge && (
            <span className="flex-shrink-0 rounded bg-[var(--v2-brand-soft)] px-1.5 py-0.5 text-xs font-medium text-[var(--v2-brand)]">
              default
            </span>
          )}
        </div>
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

      {/* Token breakdown — #4021: no reserved height, no "+N more" (the
          two-token registry can never overflow), and the footer pins to the
          bottom via `mt-auto` so cards in a row still align. */}
      <div className="space-y-1.5">
        {portfolioLoading ? (
          <>
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
          </>
        ) : tokensWithFunds.length === 0 ? (
          <>
            <p className="text-xs text-[var(--v2-ink-3)]">No funds yet.</p>
            {/*
              A sibling ABOVE the stretched-link overlay (design-system §
              stretched links): its own `relative z-*` puts it over the
              overlay, the vertical padding carries the 44px hit area, and
              there are no propagation guards — a click opens the modal and
              nothing else is swallowed. It is a LINK, not a button, so the
              card keeps holding no buttons (#3719). Focusing it rings the
              card through `entityCardClassName`'s `has-[a:focus-visible]`,
              which is the SAME ring the name link's overlay already paints
              for the whole card — consistent, not a defect. The hash starts
              with a non-hex letter: a hex-looking fragment here would read
              as a hardcoded colour in the design-lint scan, comment
              included.
            */}
            {account.account_address && (
              <a
                href="#get-funds"
                onClick={(event) => {
                  event.preventDefault()
                  setReceiveOpen(true)
                }}
                className="relative z-[var(--v2-z-content)] -mx-1 flex min-h-[44px] items-center px-1 text-xs font-medium text-[var(--v2-brand)] hover:underline focus-visible:outline-none focus-visible:underline"
              >
                Add funds
              </a>
            )}
            {/*
              #4094: the one Receive dialog. The link stays "Add funds" — it
              names a task, not a button (owner decision 2026-10-19, same
              rule the first-run guide and the attention items follow) — and
              the chain id passes through UNFALLBACKED (#1844): an account
              that arrived without a chain gets the dialog's refusal, not a
              silent default to Base mainnet.
            */}
            <ReceiveDialog
              open={receiveOpen}
              onClose={() => setReceiveOpen(false)}
              account={account}
            />
          </>
        ) : (
          showTokenRows && (
            <>
              {tokensWithFunds.map((item) => {
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
            </>
          )
        )}
      </div>

      {/* Footer chip row — agent count + the account's most recent outgoing
          transfer (#4021, owner ruling 2026-10-16): ANY outgoing transfer,
          owner sends included; incoming never counts. A failed send moved
          nothing, so the backend never counts it either. */}
      <div className="mt-auto flex items-center justify-between gap-3 border-t border-[var(--v2-border)] pt-3 text-xs text-[var(--v2-ink-3)]">
        <span className="flex items-center gap-1.5">
          <Icon icon={Bot} className="h-3.5 w-3.5" />
          {agentCount} agent{agentCount !== 1 ? 's' : ''}
        </span>
        <span>
          {lastOutgoingAt ? (
            <>
              Last payment {timeAgo(lastOutgoingAt)}
            </>
          ) : (
            'No payments yet'
          )}
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
  const [newAccountOpen, setNewAccountOpen] = useState(false)

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
          // #4021: the Safe-era "linked" is gone. One account needs no count;
          // two or more read "{n} accounts".
          accounts.length > 1 ? (
            <>
              <span className="v2-tabular">{accounts.length}</span> accounts
            </>
          ) : undefined
        }
        actions={
          // Hidden with no accounts: a new account copies its passkey from an
          // existing one, so there is no source — and ProtectedRoute sends a
          // user with no accounts to /onboarding, which creates the first.
          accounts.length > 0 ? (
            <Button onClick={() => setNewAccountOpen(true)}>New account</Button>
          ) : undefined
        }
      />
      <NewAccountDialog open={newAccountOpen} onClose={() => setNewAccountOpen(false)} />

      {/* Orphaned agents warning */}
      {orphanedAgents.length > 0 && (
        <div className="flex items-center gap-2 px-4 py-3 mb-6 rounded-lg bg-[var(--v2-warning-soft)] border border-warning/20">
          <Icon icon={CircleAlert} className="h-4 w-4 text-[var(--v2-warning)] flex-shrink-0" />
          <span className="text-sm text-[var(--v2-warning)]">
            {orphanedAgents.length} agent{orphanedAgents.length !== 1 ? 's have' : ' has'} no linked account. Review them in the Agents page.
          </span>
        </div>
      )}

      {accounts.length === 0 ? (
        // An empty state with no next step would be a dead end, which the
        // design system forbids — so this one explains itself instead. The
        // header's "New account" action is hidden here (#4024): it copies a
        // passkey from an existing account, and with none there is no source.
        // The first account is created at sign-in, and ProtectedRoute
        // redirects a user with no accounts to /onboarding, so this should be
        // unreachable in practice; the copy says so rather than leaving a
        // blank card that reads as broken. (The Safe-era "Add account" button
        // that used to sit here went with #1984.)
        <EmptyState
          icon={<Icon icon={CreditCard} className="h-5 w-5" />}
          tone="neutral"
          title="No Haven accounts yet"
          body="Your Haven account is created when you sign in, so you shouldn't normally see this. Try reloading the page."
        />
      ) : accounts.length === 1 ? (
        // #4021, one account: a deliberate wide card (about two thirds of the
        // row) beside a dashed "Create another account" tile — the tile opens
        // the SAME dialog as the header action. They stack at phone width.
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <AccountCard
              account={accounts[0]}
              agentCount={agentCountByAccount.get(accounts[0].id) ?? 0}
              showDefaultBadge={false}
              currency={currency}
              staggerIndex={0}
            />
          </div>
          <button
            type="button"
            onClick={() => setNewAccountOpen(true)}
            className="flex min-h-[160px] flex-col items-start justify-center gap-2 rounded-lg border border-dashed border-[var(--v2-border)] p-6 text-left transition-colors hover:border-brand/40 hover:bg-[var(--v2-surface)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80"
          >
            <span className="flex items-center gap-2 text-sm font-semibold text-[var(--v2-ink)]">
              <Icon icon={Plus} className="h-4 w-4" />
              Create another account
            </span>
            <span className="text-sm leading-relaxed text-[var(--v2-ink-3)]">
              Separate balances and agent budgets. Keep work and personal money apart, for example.
            </span>
          </button>
        </div>
      ) : (
        // Two or more: a responsive grid of the slimmed cards, no tile.
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
