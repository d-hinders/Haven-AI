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
import { OffersTable } from '@/components/marketplace/OffersTable'
import { PayWithHavenBlock } from '@/components/marketplace/PayWithHavenBlock'
import FundMerchantModal, { eligibleFundingAgents } from '@/components/marketplace/FundMerchantModal'
import { MerchantBudgetsList } from '@/components/marketplace/MerchantBudgetsList'
import CatalogSubmitModal from '@/components/CatalogSubmitModal'
import { useAgents } from '@/hooks/useAgents'
import { chainName } from '@/lib/marketplace'
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
  const [submitOpen, setSubmitOpen] = useState(false)
  const [fundOpen, setFundOpen] = useState(false)
  const comingSoonForBudgets = merchant?.listing_status === 'coming_soon'
  const {
    budgets: merchantBudgets,
    error: merchantBudgetsError,
    refetch: refetchMerchantBudgets,
  } = useMerchantBudgets(slug, {
    enabled: !comingSoonForBudgets,
  })

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
  const showOpenBudgetNote = !comingSoon && pinnableFunding.length === 0 && verifiedFunding.length > 0
  // Round 2 review finding R2-5 (design 3): the merchant CAN be pinned to, but
  // none of the owner's own agents qualify (wrong chain, revoked, archived) —
  // the page used to show nothing at all where the action would be. Gated on
  // `!agentsLoading` so the note never flashes on then off again once agents
  // resolves and `hasEligibleAgent` flips true (or the plain Fund button
  // takes over) — before that resolves, this slot renders nothing, exactly
  // like `showFundAction` already does with an empty `agents` array.
  // Design review round 3, finding C (code F5): `agents` reads `[]` on a
  // failed `useAgents` fetch, which is indistinguishable from "no eligible
  // agent" here — that used to claim "Connect an agent" for a read that
  // simply failed. `agentsError` splits the two: the note below only fires
  // once the read actually succeeded and came up empty.
  const showConnectAgentNote =
    !comingSoon && !agentsLoading && !agentsError && pinnableFunding.length > 0 && !hasEligibleAgent
  const showAgentsErrorNote =
    !comingSoon && !agentsLoading && agentsError && pinnableFunding.length > 0 && !hasEligibleAgent
  // Design review round 3, finding C: name every pinnable chain rather than
  // always reading the first — a merchant qualifying on two chains used to
  // silently drop the second from this sentence.
  const pinnableChainIds = Array.from(new Set(pinnableFunding.map((f) => f.chain_id)))
  const pinnableChainLabel =
    pinnableChainIds.length === 1
      ? chainName(pinnableChainIds[0]!)
      : pinnableChainIds.length > 1
        ? pinnableChainIds.map(chainName).join(' or ')
        : 'a supported network'

  return (
    <div className="max-w-5xl space-y-6" data-testid="merchant-page">
      <BackToMarketplace />
      {/* The merchant header IS the page header — one h1 (a second `PageHeader`
          made the name two headings, which the visual spec's anchor refused). */}
      <MerchantHeader merchant={merchant} />

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
          <section>
            <h2 className="mb-2 text-sm font-semibold text-[var(--v2-ink)]">Pay this with Haven</h2>
            <PayWithHavenBlock offers={offers} />
          </section>

          {showFundAction ? (
            <div>
              <Button size="sm" onClick={() => setFundOpen(true)}>
                Fund this merchant
              </Button>
              <p className="mt-1 text-xs text-[var(--v2-ink-3)]">
                Give one of your agents a budget that pays only {merchant.name}.
              </p>
            </div>
          ) : showAgentsErrorNote ? (
            // Design review round 3, finding C: a failed agents read must not
            // claim "Connect an agent" — that would tell an owner who already
            // has an eligible agent to connect a new one, over a read that
            // simply failed.
            <p className="text-xs leading-relaxed text-[var(--v2-ink-2)]">
              Haven could not load your agents just now, so funding is unavailable. Reload the page to try again.
            </p>
          ) : showConnectAgentNote ? (
            <p className="text-xs leading-relaxed text-[var(--v2-ink-2)]">
              Connect an agent on {pinnableChainLabel} to give it a budget for {merchant.name}.{' '}
              <Link href="/agents" className="font-medium text-[var(--v2-brand)] hover:underline">
                Go to Agents
              </Link>
            </p>
          ) : showOpenBudgetNote ? (
            // #3331 review finding design-12: plain wording, no "pinning it to
            // a recipient", and its own small heading rather than a bare line.
            <div className="rounded-lg border border-[var(--v2-border)] bg-[var(--v2-surface)] p-3">
              <p className="text-xs font-medium text-[var(--v2-ink-3)]">How this merchant is paid</p>
              <p className="mt-1 text-xs leading-relaxed text-[var(--v2-ink-2)]">
                Payments to {merchant.name} use an agent's open budget, not a merchant-only one — keep that budget
                open on the agent's page.
              </p>
            </div>
          ) : null}

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
            <OffersTable offers={offers} agents={agents} />
          </section>
        </>
      )}

      <div>
        <Button variant="ghost" size="sm" onClick={() => setSubmitOpen(true)}>
          List your payable service
        </Button>
      </div>

      <CatalogSubmitModal
        open={submitOpen}
        onClose={() => setSubmitOpen(false)}
        onVerifiedPayable={() => void refetch()}
      />

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
