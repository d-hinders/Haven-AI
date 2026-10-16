'use client'

/**
 * "How to buy" (#4005) — the merchant page's three-step panel between the
 * header and the offers, reflecting the signed-in user's real state.
 *
 * Every step is CLAIMED from data, not asserted: step 1 reads `useAgents`,
 * step 2 is the merchant-level reduction of #4004's per-offer answers
 * (`howToBuy` in `lib/marketplace.ts` — the panel and the offers give the
 * same answer by construction) over the two budget wires the page already
 * loads, and step 3 only points at the offers below. The panel never claims
 * a step is done that the data cannot support: a failed agents read says
 * Haven couldn't load them (never "Connect an agent"), a failed budget read
 * is a retryable "couldn't check", and while anything is loading the steps
 * are skeletons that claim nothing.
 *
 * One unpadded Card: the title is a `Card.Header` band (#4015 — the house
 * title row, as on the dashboard's list cards), and one `Card.Section
 * divided` holds the three rows, each owning its padding — the shared
 * row-list pattern, so the dividers meet the card's edges and never
 * overshoot them (#4014). The section drops its own top border, so ONE
 * hairline (the header's) sits between the title and step 1. No nested filled cards
 * (CLAUDE.md § UI Surface Hierarchy). Coming-soon and no-offer merchants
 * never mount it — the page renders it inside its offers branch only.
 */

import type { ReactNode } from 'react'
import Link from 'next/link'
import { formatUnits } from 'viem'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import {
  anyRecipientRule,
  chainName,
  howToBuy,
  offersOnChain,
  offersOnUserNetwork,
  type BudgetAgent,
  type SelectedBudget,
} from '@/lib/marketplace'
import type { CatalogEntry, MerchantFundingTarget } from '@/hooks/useCatalog'
import type { DashboardBudgetRemainingEntry } from '@/hooks/useBudgetRemaining'
import type { MerchantBudget } from '@/hooks/useMerchantBudgets'

type StepState = 'done' | 'open' | 'later'

/**
 * The numbered dot, in StepProgress's visual language: a success-tinted ✓
 * for a claimed step, the brand dot for the step to act on now, and a muted
 * number for a later step that claims nothing.
 */
function StepDot({ state, n }: { state: StepState; n: number }) {
  return (
    <div
      aria-hidden
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium ${
        state === 'done'
          ? 'border-success/30 bg-[var(--v2-success-soft)] text-[var(--v2-success)]'
          : state === 'open'
            ? 'border-[var(--v2-brand)] bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]'
            : 'border-[var(--v2-border)] text-[var(--v2-ink-3)]'
      }`}
    >
      {state === 'done' ? '✓' : n}
    </div>
  )
}

function StepRow({
  n,
  state,
  title,
  children,
}: {
  n: number
  state: StepState
  title: string
  children: ReactNode
}) {
  return (
    <div className="flex gap-3 px-5 py-3 md:px-6" data-testid={`how-to-buy-step-${n}`}>
      <StepDot state={state} n={n} />
      <div className="min-w-0">
        <p className="text-sm font-medium text-[var(--v2-ink)]">{title}</p>
        <div className="mt-0.5 text-xs leading-relaxed text-[var(--v2-ink-2)]">{children}</div>
      </div>
    </div>
  )
}

/**
 * The any-recipient requirement (#3981's note, moved here in plain words):
 * in a mixed merchant the tagged offers need it; when EVERY offer does,
 * there are no tags to point at, so the sentence carries the whole rule.
 * #4015: the done line with an open budget already says "can pay anyone",
 * so there it renders only for the mixed case; the budget-fix line keeps
 * both forms.
 */
function AnyRecipientLine({ merchantName, mixed }: { merchantName: string; mixed: boolean }) {
  return (
    <>
      {' '}
      {mixed
        ? 'The offers marked "any-recipient budget" need a budget that can pay anyone.'
        : `A budget limited to one recipient can't pay ${merchantName} — keep the budget that can pay anyone open.`}
    </>
  )
}

/**
 * "{remaining} {symbol} left of {cap} {symbol}" — the same `formatUnits`
 * read `MerchantBudgetsList` renders, so one budget reads the same in both
 * places. The period word, when the budget carries one, trails the cap.
 */
function amountLine(selected: SelectedBudget): string {
  const remaining = formatUnits(BigInt(selected.remainingAtomic), selected.tokenDecimals)
  const cap =
    selected.budgetAtomic != null ? formatUnits(BigInt(selected.budgetAtomic), selected.tokenDecimals) : null
  return `${remaining} ${selected.tokenSymbol} left of ${cap ?? 'its cap'} ${selected.tokenSymbol}${
    selected.periodPhrase ? ` ${selected.periodPhrase}` : ''
  }`
}

/** A step that is still reading its data: skeletons, and no claim. */
function StepSkeleton() {
  return (
    <>
      <Skeleton className="mt-1.5 h-3.5 w-56 max-w-full" variant="text" />
      <Skeleton className="mt-1.5 h-3.5 w-40 max-w-full" variant="text" />
    </>
  )
}

export function HowToBuyPanel({
  merchantName,
  offers,
  agents,
  agentsLoading,
  agentsError,
  budgets,
  budgetsPending,
  budgetsError,
  merchantBudgets,
  funding,
  defaultChainId = null,
  fundActionAvailable,
  onSetBudget,
  onRetryBudgets,
}: {
  merchantName: string
  offers: CatalogEntry[]
  /** The spec-derived agent shape `howToBuy` reads (#4004). */
  agents: BudgetAgent[]
  agentsLoading: boolean
  /** `useAgents`' error — a failed read never renders "Connect an agent". */
  agentsError: string | null
  /** `GET /dashboard/budget-remaining` rows — what is LEFT, per agent and budget. */
  budgets: DashboardBudgetRemainingEntry[]
  /** True while either budget wire is still loading — the steps claim nothing. */
  budgetsPending: boolean
  /** Set when either budget wire failed — step 2 becomes a retryable line. */
  budgetsError: string | null
  merchantBudgets: MerchantBudget[]
  funding: MerchantFundingTarget[]
  /**
   * The default account's chain — the offers table's split (#4015). Step 2
   * names the network when the agent it names sits on another chain.
   */
  defaultChainId?: number | null
  /** `showFundAction` AND at least one ACTIVE eligible agent (the page computes both). */
  fundActionAvailable: boolean
  onSetBudget: () => void
  onRetryBudgets: () => void
}) {
  const activeAgents = agents.filter((a) => a.status === 'active')
  const firstActive = activeAgents[0] ?? null
  const activeCount = activeAgents.length

  // ── Step 1 — Connect an agent ─────────────────────────────────────────────
  // Done when the user has at least one ACTIVE agent — paused, pending,
  // revoked and archived ones do not claim the step. A failed read says so
  // instead of ever reading as "connect an agent".
  const step1State: StepState = agentsLoading ? 'later' : agentsError != null ? 'later' : activeCount > 0 ? 'done' : 'open'
  const step1Body = agentsLoading ? (
    <StepSkeleton />
  ) : agentsError != null ? (
    <p>Haven couldn't load your agents.</p>
  ) : activeCount === 0 ? (
    <p>
      Connect an agent to buy from {merchantName}.{' '}
      <Link href="/agents" className="font-medium text-[var(--v2-brand)] hover:underline">
        Go to Agents
      </Link>
    </p>
  ) : (
    <p>
      {firstActive!.name} is connected{firstActive!.account_chain_id != null ? ` on ${chainName(firstActive!.account_chain_id)}` : ''}
      {activeCount > 1 ? `, along with ${activeCount - 1} more agent${activeCount - 1 === 1 ? '' : 's'}` : ''}.
    </p>
  )

  // ── Step 2 — Give it a budget it can spend here ───────────────────────────
  // The merchant-level reduction of the per-offer answers. Computed only
  // once every input it reads has actually arrived; while anything is
  // loading (or the read failed) the step claims nothing.
  const answerReady = !agentsLoading && agentsError == null && activeCount > 0 && !budgetsPending && budgetsError == null
  const answer = answerReady
    ? howToBuy({ merchantName, offers, agents, budgets, merchantBudgets, funding, preferChainId: defaultChainId })
    : null
  const pasteTargetName =
    answer?.kind === 'done' ? answer.agentName : activeCount === 1 ? firstActive!.name : null
  // #4015: `partial`, `mixed` and `needsAnyRecipient` all read ONE offer set —
  // the offers on the named agent's chain (the offers table tags per chain
  // through the same `anyRecipientRule`). Before an agent is named, the
  // set is the offers on the user's network, the table's visible rows.
  const ruleOffers =
    answer?.kind === 'done' || answer?.kind === 'budget-fix'
      ? offersOnChain(offers, answer.agentChainId)
      : offersOnUserNetwork(offers, defaultChainId)
  const { needsAnyRecipient, mixed } = anyRecipientRule(ruleOffers)

  let step2State: StepState = 'open'
  let step2Body: ReactNode
  if (budgetsPending) {
    step2Body = <StepSkeleton />
  } else if (budgetsError != null) {
    step2Body = (
      <p>
        Haven couldn't check budgets — try again.{' '}
        <Button size="sm" variant="ghost" onClick={onRetryBudgets}>
          Try again
        </Button>
      </p>
    )
  } else if (activeCount === 0) {
    // No active agent: step 1 owns the fix, this step claims nothing.
    step2State = 'later'
    step2Body = <p>Once an agent is connected, it needs a budget it can spend here.</p>
  } else if (answer?.kind === 'done') {
    step2State = 'done'
    const { selected, partial, agentChainId } = answer
    const openBudget = selected.recipientAddress == null
    // #4015: an agent on another network than the user's default pays only
    // the offers on its own chain — the line says which network, so it is
    // never read against the unpayable rows the table puts first.
    const onNetwork = agentChainId !== defaultChainId ? ` on ${chainName(agentChainId)}` : ''
    step2Body = (
      <p>
        {answer.agentName} has {amountLine(selected)}, and can pay{' '}
        {openBudget ? (
          <>
            anyone — so it can pay {merchantName}
            {onNetwork}
            {partial ? ' for some offers' : ''}
          </>
        ) : (
          <>
            only {merchantName}
            {onNetwork}
            {partial ? ' — for some offers' : ''}
          </>
        )}
        .
        {/* An open budget already reads "can pay anyone": the line adds
            something only when some offers are tagged (#4015). A locked
            budget that pays here implies erc7710 offers, so any bridge-only
            offer beside them makes the set mixed. */}
        {mixed ? <AnyRecipientLine merchantName={merchantName} mixed /> : null}
      </p>
    )
  } else if (answer?.kind === 'budget-fix') {
    step2Body = (
      <p>
        {answer.selected != null ? (
          <>
            {answer.agentName} has {amountLine(answer.selected)} — not enough for any offer here.
          </>
        ) : (
          <>{answer.agentName} has no budget that can pay {merchantName} yet.</>
        )}
        {needsAnyRecipient ? <AnyRecipientLine merchantName={merchantName} mixed={mixed} /> : null}{' '}
        {fundActionAvailable ? (
          <Button size="sm" onClick={onSetBudget}>
            Set a budget for this merchant
          </Button>
        ) : (
          <>
            Set one on{' '}
            <Link href={`/agents/${answer.agentId}`} className="font-medium text-[var(--v2-brand)] hover:underline">
              {answer.agentName}'s page
            </Link>
            .
          </>
        )}
      </p>
    )
  } else if (answer?.kind === 'wrong-network') {
    // "Haven can't add a second account from here" stays after #4024's New
    // account action: an agent spends only from the account it is linked to,
    // so a new account on the offers' chain would not let THIS agent buy.
    // Decision and reasoning: docs/product/marketplace.md, How to buy, step 2.
    const offerChains =
      answer.offerChainIds.length === 1
        ? chainName(answer.offerChainIds[0]!)
        : answer.offerChainIds.map(chainName).join(' or ')
    step2Body = (
      <p>
        {answer.agentName}'s Haven wallet is on {chainName(answer.agentChainId)} — this merchant's offers are on{' '}
        {offerChains}. Haven can't add a second account from here.
      </p>
    )
  } else {
    // 'uncertain' — unknowns everywhere; the per-offer rows carry what IS known.
    step2Body = <p>Haven couldn't confirm what your agent can spend here just now.</p>
  }

  return (
    <div data-testid="how-to-buy-panel">
      <Card hover={false} className="overflow-hidden">
        {/* #4015: the house title row — the tinted band with its own
            hairline below. `md:px-6` keeps the title on the rows' inset. */}
        <Card.Header as="h2" title="How to buy" className="md:px-6" />
        {/* `border-t-0`: the header's `border-b` is the one hairline under
            it; the section's own top border would double it. */}
        <Card.Section divided className="border-t-0">
          <StepRow n={1} state={step1State} title="Connect an agent">
            {step1Body}
          </StepRow>
          <StepRow n={2} state={step2State} title="Give it a budget it can spend here">
            {step2Body}
          </StepRow>
          <StepRow n={3} state={activeCount > 0 ? 'open' : 'later'} title="Ask your agent to buy">
            <p>
              Copy an offer's prompt below and paste it into {pasteTargetName ? `${pasteTargetName}'s` : "your agent's"} chat. It
              pays from its budget and brings back the result. The payment shows up in{' '}
              <Link href="/transactions" className="font-medium text-[var(--v2-brand)] hover:underline">
                Transactions
              </Link>
              .
            </p>
          </StepRow>
        </Card.Section>
      </Card>
    </div>
  )
}
