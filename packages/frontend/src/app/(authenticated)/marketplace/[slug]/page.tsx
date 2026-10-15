'use client'

import { useState } from 'react'
import { AlertTriangle, ChevronLeft } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { notFound as nextNotFound, useParams } from 'next/navigation'
import { EmptyState } from '@/components/ui/EmptyState'
import { Skeleton } from '@/components/ui/Skeleton'
import { Button } from '@/components/ui/Button'
import Link from 'next/link'
import { MerchantHeader } from '@/components/marketplace/MerchantHeader'
import { HowToBuyPanel } from '@/components/marketplace/HowToBuyPanel'
import { OffersTable } from '@/components/marketplace/OffersTable'
import FundMerchantModal, { eligibleFundingAgents } from '@/components/marketplace/FundMerchantModal'
import { MerchantBudgetsList } from '@/components/marketplace/MerchantBudgetsList'
import { useAgents } from '@/hooks/useAgents'
import { chainName } from '@/lib/marketplace'
import { useAuth } from '@/context/AuthContext'
import { resolveDefaultAccount } from '@/lib/default-account'
import { useBudgetRemaining } from '@/hooks/useBudgetRemaining'
import { useMerchant } from '@/hooks/useCatalog'
import { useMerchantBudgets } from '@/hooks/useMerchantBudgets'

/**
 * The way back on a phone, where Marketplace lives in the More drawer —
 * rendered by EVERY branch of the page (loading, error, merchant-less,
 * success), the `Button` primitive (44 px hit area, focus ring), the same
 * shape as the sweep page's "Back to agent".
 */
function BackToMarketplace() {
  return (
    <div className="mb-4">
      <Button href="/marketplace" variant="tertiary" size="sm" className="-ml-3">
        <Icon icon={ChevronLeft} className="h-3.5 w-3.5" />
        Back to Marketplace
      </Button>
    </div>
  )
}

export default function MerchantPage() {
  const params = useParams<{ slug: string }>()
  const slug = params.slug
  const { merchant, offers, funding = [], loading, error, notFound, refetch } = useMerchant(slug)
  const { agents, loading: agentsLoading, error: agentsError } = useAgents()
  const [fundOpen, setFundOpen] = useState(false)
  // #3981: the offers on the user's own network come first — the chain of the
  // account a surface falls back to when it needs one (`resolveDefaultAccount`),
  // the same read the marketplace grid's network filter starts from.
  const { user } = useAuth()
  const defaultChainId = resolveDefaultAccount(user?.accounts)?.chain_id ?? null
  const comingSoonForBudgets = merchant?.listing_status === 'coming_soon'
  const {
    budgets: merchantBudgets,
    loading: merchantBudgetsLoading,
    error: merchantBudgetsError,
    refetch: refetchMerchantBudgets,
  } = useMerchantBudgets(slug, {
    enabled: !comingSoonForBudgets,
  })
  // #4004: the per-offer budget answer reads what is LEFT on each budget (the
  // cached, 60 s-polled enforcer read) — not just the cap `GET /agents`
  // projects, which could answer yes when no agent could actually pay.
  // #4005: the "How to buy" panel reads the same two wires, so its step 2
  // and the offers' per-row answers come from one set of verdicts.
  const { data: budgetRemaining, loading: budgetRemainingLoading, error: budgetRemainingError, refetch: refetchBudgetRemaining } = useBudgetRemaining()

  if (loading) {
    return (
      // `aria-busy` + `role="status"`: the skeletons are aria-hidden, so the
      // capture harness's content floor must not certify this frame (and a
      // screen reader must hear that the merchant is still loading).
      <div className="max-w-5xl space-y-4" role="status" aria-busy="true" aria-label="Loading merchant">
        <BackToMarketplace />
        <Skeleton className="h-16 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    )
  }

  if (notFound) {
    // A merchant page 404s the same way an unknown route would — nextNotFound()
    // renders the app's not-found boundary rather than a bespoke empty state,
    // so an unknown slug and an unknown URL read identically to the user.
    nextNotFound()
  }

  if (error) {
    return (
      <div className="max-w-5xl">
        <BackToMarketplace />
        <EmptyState
          icon={<Icon icon={AlertTriangle} className="h-5 w-5" />}
          tone="danger"
          title="Could not load this merchant"
          body={error}
          action={
            <Button variant="ghost" size="sm" onClick={() => void refetch()}>
              Try again
            </Button>
          }
        />
      </div>
    )
  }

  if (!merchant) {
    // A 200 without a merchant body is neither a 404 nor a transport error;
    // it is still a state a user can land on, so it is designed, not blank.
    return (
      <div className="max-w-5xl">
        <BackToMarketplace />
        <EmptyState
          icon={<Icon icon={AlertTriangle} className="h-5 w-5" />}
          tone="danger"
          title="Could not load this merchant"
          body="The merchant answered without a listing."
          action={
            <Button variant="ghost" size="sm" onClick={() => void refetch()}>
              Try again
            </Button>
          }
        />
      </div>
    )
  }

  const comingSoon = merchant.listing_status === 'coming_soon'

  // #3331: a merchant-locked budget can only be pinned to a VERIFIED payTo
  // that every offer there advertises ERC-7710 through. When a chain has a
  // verified payTo but not every offer is ERC-7710, the action is withheld
  // and the page says why — payments there use the agent's open budget
  // instead, and that budget must stay open (`docs/product/marketplace.md`).
  // #3331 review finding F6: withheld ALSO when the merchant qualifies but
  // none of the owner's OWN agents do — a disabled Review behind a modal that
  // can only ever show "no eligible agent" is worse than not showing the
  // entry point at all.
  const verifiedFunding = funding.filter((f) => f.pay_to_status === 'verified')
  const pinnableFunding = verifiedFunding.filter((f) => f.erc7710)
  const hasEligibleAgent = eligibleFundingAgents(agents, funding).length > 0
  const showFundAction = !comingSoon && pinnableFunding.length > 0 && hasEligibleAgent
  // #4005: the panel's step 2 may offer the same action, but only when an
  // agent it could name is ACTIVE — `eligibleFundingAgents` admits paused and
  // pending agents (the modal's own shape), and the panel must not point a
  // paused agent at an action it cannot complete.
  const hasActiveEligibleAgent = eligibleFundingAgents(agents, funding).some((a) => a.status === 'active')

  return (
    <div className="max-w-5xl space-y-6" data-testid="merchant-page">
      <BackToMarketplace />
      {/* The merchant header IS the page header — one h1 (a second `PageHeader`
          made the name two headings, which the visual spec's anchor refused).
          #3981: "Set a budget for this merchant" (#4003 wording) sits in its
          right-hand actions slot, the way `PageHeader` places actions. */}
      <MerchantHeader
        merchant={merchant}
        actions={
          showFundAction ? (
            <div className="flex flex-col items-start gap-1 sm:items-end">
              <Button size="sm" onClick={() => setFundOpen(true)}>
                Set a budget for this merchant
              </Button>
              <p className="text-xs text-[var(--v2-ink-3)]">
                Give one of your agents a budget that pays only {merchant.name}.
              </p>
            </div>
          ) : undefined
        }
      />

      {comingSoon ? (
        <EmptyState
          title="Coming soon — not payable yet"
          body="This merchant is not listed for payment yet."
        />
      ) : offers.length === 0 ? (
        <EmptyState
          title="No offers listed yet"
          body="This merchant has no payable offers on the networks you can reach right now."
        />
      ) : (
        <>
          {/* #4005: the "How to buy" panel sits between the header and the
              offers, and owns what the old connect-agent / agents-error
              paragraphs above the table used to say — its step 1 names the
              user's real agents (or the failed read), its step 2 names the
              budget fix. Coming-soon and no-offer merchants show no panel. */}
          <HowToBuyPanel
            merchantName={merchant.name}
            offers={offers}
            agents={agents}
            agentsLoading={agentsLoading}
            agentsError={agentsError}
            budgets={budgetRemaining?.budgets ?? []}
            budgetsPending={merchantBudgetsLoading || budgetRemainingLoading}
            budgetsError={merchantBudgetsError ?? budgetRemainingError}
            merchantBudgets={merchantBudgets ?? []}
            funding={funding}
            fundActionAvailable={showFundAction && hasActiveEligibleAgent}
            onSetBudget={() => setFundOpen(true)}
            onRetryBudgets={() => {
              void refetchMerchantBudgets()
              void refetchBudgetRemaining()
            }}
          />

          {merchantBudgetsError ? (
            // #3331 review finding design-8: `useMerchantBudgets().error` was
            // read by nothing — a failed read looked identical to "no
            // merchant-locked budgets exist" instead of a retryable failure.
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)] px-3 py-2">
              <p className="text-xs text-[var(--v2-ink-2)]">Haven could not load this merchant's budgets.</p>
              <Button size="sm" variant="ghost" onClick={() => void refetchMerchantBudgets()}>
                Try again
              </Button>
            </div>
          ) : merchantBudgets && merchantBudgets.length > 0 ? (
            <MerchantBudgetsList budgets={merchantBudgets} />
          ) : null}

          <section>
            <h2 className="mb-2 text-sm font-semibold text-[var(--v2-ink)]">Offers</h2>
            <OffersTable
              offers={offers}
              agents={agents}
              budgets={budgetRemaining?.budgets ?? []}
              merchantBudgets={merchantBudgets ?? []}
              funding={funding}
              defaultChainId={defaultChainId}
            />
          </section>
        </>
      )}

      {fundOpen ? (
        <FundMerchantModal
          open={fundOpen}
          onClose={() => setFundOpen(false)}
          merchant={merchant}
          funding={funding}
          offers={offers}
          agents={agents}
          onGranted={() => {
            void refetchMerchantBudgets()
          }}
        />
      ) : null}
    </div>
  )
}
