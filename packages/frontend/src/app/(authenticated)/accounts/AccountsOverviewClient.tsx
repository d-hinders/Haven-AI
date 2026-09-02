'use client'

import { ArrowRight, CircleAlert, CreditCard, FlaskConical } from 'lucide-react'
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
// drill in. Setting the default account lives on `/accounts/<id>` only, since
// #2374 dropped the card's unlabelled star. Shared legacy Safe COMPONENTS
// elsewhere are deletion slice #1989's scope, not this one's.
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
      {/*
        Header — the account's identity, and the two actions that act on it.

        TWO COLUMNS, and the split is the fix for #2236. The actions used to be
        `absolute top-3 right-3` over the card, with the title row buying them
        room via a hand-picked `pr-12`. Measured on the two-account fixture at
        1280: the actions block was **102.6px** ("Set active" 72.6 + gap 4 +
        the star 26) and overhung the card's content box by 10.9px, so an
        honest reservation was ~92px against the 48px actually written — and
        on hover the buttons painted a **42.7 x 14px** region of the account
        name's own box (46.6 x 18px at 390). Widening `pr-12` to ~92px was the
        obvious fix and the wrong one: it takes that width back from the name
        on EVERY line and on EVERY card, which is what #2223 exists to stop.

        So the reservation is DERIVED instead of guessed: the actions live in
        normal flow as this row's second column, `flex-shrink-0`, and reserve
        exactly what they measure. Nothing can drift when a label changes, and
        the reservation is now CONDITIONAL — `pr-12` was paid on every card,
        including the active one where no button renders at all, so that card
        was losing 48px of name to a button that did not exist.

        SINCE #2374 THE BLOCK HOLDS ONE CONTROL, so its width IS "Set active"'s
        painted width — 72.6px on macOS, 75px on the Linux CI runner — with no
        gap term at all. Every figure below that reads 102.6 or 108.6 is the
        pre-#2374 PAIR and is kept as the history it explains, not as a current
        measurement. The trade the rest of this comment describes gets cheaper
        by exactly the star plus its gap; it is not re-measured here, because
        `e2e/accounts-name-measure.spec.ts` derives the reservation at run time
        rather than pinning a number, which is the whole point of #2236's fix.

        The name still gets the wrapping row from #2223 — `flex-wrap` around a
        `min-w-0 truncate` `h3` — inside the first column, so a name too long
        for the row still truncates against the CONTAINER rather than against
        the chrome. `min-w-0 flex-1` is what lets that column shrink at all.

        What this trade COSTS, stated rather than buried: on a card that DID
        render both actions the title row's content dropped from a nominal 217px
        to 154.4px at 1280. That nominal 217 was never honest — 42.7px of it
        was painted over whenever the pointer was on the card — but 62.6px is
        a real give, and it is the price of the name never being occluded. It
        is paid only on cards that are neither active nor default.

        On the card both issues photograph — active AND default, so no button
        renders — the same change hands the row all 265px instead of 217, which
        is what lets #2235's badge pair sit beside the name at all. #2223's
        126.9px full-name render there is preserved, not regressed. Since #2374
        that card is no longer the only quiet one: ANY active card renders no
        action, default or not.
      */}
      <div className="mb-2 flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <h3
            title={safe.name}
            className="min-w-0 truncate text-base font-semibold text-[var(--v2-ink)]"
          >
            {safe.name}
          </h3>
          {/*
            ONE badge group, not two siblings — this is #2235's fix.

            #2223 made this row wrap so the name stops paying for its chrome.
            With two independent `flex-shrink-0` badges the row then broke
            BETWEEN them, so `Active` stayed beside the name and `default`
            landed alone on a line of its own, immediately above the caption.
            `haven-design-reviewer`, verbatim: "a single small pill stranded on
            its own line … doesn't read as intentional hierarchy — it reads
            like whatever didn't fit fell down."

            Grouping them makes the badges one wrappable item, so the row can
            only break in front of the PAIR. Either both sit beside the name or
            both move under it as a badge row — there is no arrangement left in
            which one pill is orphaned.

            WHY NOT THE CAPTION LINE, which is what #2235 proposed. It was
            rendered rather than reasoned about, and it does not fit: on the
            standing capture fixture the caption already measures ~255px of a
            265px card at 1280 (`● Base Sepolia` is 145px, not the 54px a
            mainnet `Base` label would be), so adding `default · ` overflowed
            it and left a dangling `·` at the end of line one with "Added 4mo
            ago" alone below. That is the same defect the issue is about, moved
            down one row. The measurement is in the PR body; the arrangement
            below is what the card can actually hold.
          */}
          {(showActiveBadge || showDefaultBadge) && (
            <span className="inline-flex flex-shrink-0 items-center gap-2">
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
            </span>
          )}
        </div>

        {/*
          The card's ONE action, and the reason it is one — #2374.

          THE "SET AS DEFAULT" STAR IS GONE FROM THIS CARD, BY OWNER DECISION.
          It was a bare outline glyph whose meaning lived only in `aria-label`:
          invisible to a sighted touch user, and — after #2241 made the pair
          permanently visible on touch — unexplained in the top-right corner of
          every non-default card. `haven-design-reviewer` raised that on #2241's
          rendered evidence and it was split out rather than patched, because
          every available answer changed what the card SAYS: labelling it costs
          the title row ~72px it does not have (#2223 / #2235 / #2236), and a
          tooltip inside a composite interactive control is hover-only by design
          (#2038, `docs/product/design-system.md` § 3 *Tooltips*), so it explains
          nothing on exactly the device the finding was about.

          WHAT IT COSTS, stated rather than buried: setting a default is now two
          taps instead of one, through `/accounts/<id>`'s kebab menu, which has
          offered it all along. That is the trade — a low-frequency action moves
          one level down rather than sitting permanently on every card.

          AND IT REMOVES A REAL ASYMMETRY, which is the part that was not a
          matter of taste. The detail page gates the same action on
          `!safe.is_default && (user?.safes?.length ?? 0) > 1`
          (`AccountDetailClient.tsx`), and BOTH of this card's badges carry the
          same `safes.length > 1` term (see the call site below). The star was
          gated on `!safe.is_default` alone, so it was the one place that would
          render a set-default control on a page holding a single account —
          where the word `default` appears nowhere, because both badges are
          suppressed at one account, and where the action cannot do anything.
          Latent while a lone account is always the default (the backend inserts
          `is_default = isFirst` and promotes the oldest survivor on unlink);
          reachable as soon as a rendered account set is filtered. Dropping the
          control deletes that call site rather than aligning it.

          WHAT SURVIVES UNCHANGED, because it was never the star's alone:

          THE REVEAL IS GATED ON `(hover: hover)`, NOT ON `:hover` ALONE — #2241.

          It used to be a bare `opacity-0 group-hover:opacity-100`. Measured on
          `chromium-mobile` (Pixel 5, 393x727, `(hover: none)` and
          `(pointer: coarse)` both true), that produced a defect worse than the
          one #2241 named: the wrapper read `opacity: 0`, and `elementFromPoint`
          at the button's centre STILL RETURNED THE BUTTON. `opacity: 0` paints
          nothing and hit-tests normally, so the card carried an invisible live
          control exactly where a finger lands to open the account. A tap there
          did not navigate (the handler calls `preventDefault()` and
          `stopPropagation()`) — it silently performed a server write. So the
          control was not "unreachable on touch": it was INVISIBLE AND STILL
          LIVE. Gating the whole hover treatment on `(hover: hover)` fixes both
          ends at once, and is written this way rather than as a
          `[@media(hover:none)]:opacity-100` override because the override form
          is two `opacity` utilities of equal specificity racing on source
          order. This form has nothing to race.

          THE RESERVATION IS DERIVED, NOT GUESSED — #2236. The wrapper is this
          row's second column in normal flow with `flex-shrink-0`, so it
          reserves exactly what it measures and reserves NOTHING on a card that
          renders no action at all. `opacity-0` is not `hidden`: the width was
          always reserved, hover or no hover.

          NO `gap-*` HERE ANY MORE, and that is a deletion with a reason rather
          than a tidy-up. `gap-2.5` (10px) existed solely to hold the star's
          44px tap target off "Set active"'s box — the square overhangs 9px per
          edge, which at the old `gap-1` reached 5px INTO its neighbour. One
          child means no gap is painted at all, so keeping the utility would
          leave a number nobody could re-derive. The clearance rule it came from
          is general and still documented; it simply has nothing to separate
          here.
        */}
        {!isActive && (
          <div className="flex flex-shrink-0 items-center transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:focus-within:opacity-100 [@media(hover:hover)]:group-hover:opacity-100">
            {/*
              Tap target: the documented `Button` mechanism, borrowed verbatim
              and VERTICAL-ONLY (`docs/product/design-system.md` § Buttons
              *Tap targets*, #1726). Painted 72.6 x 24px on macOS (75px on the
              Linux CI runner — a text measurement, never pinned absolutely),
              so only the height was under the 44px floor; growing it sideways
              is what the design system explicitly forbids, because a labelled
              control already clears 44px on its long axis and a sideways
              overlay swallows its neighbour's taps. `relative` is required —
              this button is statically positioned, so without it the overlay
              resolves against some ancestor (#1766's note).
            */}
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onSetActive() }}
              className="relative rounded-md px-2 py-1 text-xs font-medium text-[var(--v2-brand)] hover:bg-[var(--v2-brand-soft)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2 after:content-['']"
              aria-label={`Set ${safe.name} as active`}
            >
              Set active
            </button>
          </div>
        )}
      </div>

      {/* Caption — network + age. Replaces the raw 0x address that was too
          technical for an at-a-glance overview. `flex-wrap` because this line
          is already close to full at the 3-up breakpoint: `● Base Sepolia · Added
          4mo ago` measures ~255px in a 265px card, which is exactly why
          #2235's `default` could not join it. */}
      <div className="mb-5 flex flex-wrap items-center gap-2 text-xs text-[var(--v2-ink-3)]">
        <NetworkPill chainId={safe.chain_id ?? DEFAULT_CHAIN_ID} />
        <span aria-hidden="true">{'\u00b7'}</span>
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
  const { safes } = useUserSafes()
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
            {orphanedAgents.length} agent{orphanedAgents.length !== 1 ? 's have' : ' has'} no linked account. Review them in the Agents page.
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
          body="Your Haven account is created when you sign in, so you shouldn't normally see this. Try reloading the page."
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
            />
          ))}
        </div>
      )}
    </div>
  )
}
