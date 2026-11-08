'use client'

import { useId, useRef, type ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { Check } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import { Milestone } from '@/components/ui/Milestone'
import { ACTIVE_STEP_RING_CLASS, DONE_STEP_DISC_CLASS, PENDING_STEP_DISC_CLASS } from '@/components/ui/StepProgress'
import type { AccountFunding } from '@/hooks/useAccountFunding'

/**
 * `available` (#3818): a step that can be done now but is not the next one —
 * connecting an agent before funding (owner decision 2026-10-09). Not
 * highlighted, not dimmed; its action carries secondary weight.
 *
 * `unknown` (#3818): the USDC read is unavailable, so step 1 can say neither
 * "done" nor "add funds" — it says it could not read the balance and offers no
 * funding action until the read recovers. Never a silent "not funded".
 */
type StepStatus = 'complete' | 'active' | 'available' | 'locked' | 'unknown'

interface StepCta {
  label: string
  onClick?: () => void
  href?: string
  /** Secondary weight: the step can be done now but is not the next one. */
  secondary?: boolean
}

interface StepProps {
  status: StepStatus
  number: number
  title: string
  body: string
  completedBody: string
  cta?: StepCta
  /**
   * #4704: play Milestone Step when this step completes while it is watched.
   * Steps 1 and 2 only: the guide is replaced as soon as step 3 completes, and
   * the first agent payment is #4707's card.
   */
  popOnComplete?: boolean
}

/** The most recently connected agent still waiting for setup, and how many more are. */
export interface PendingSetupAgent {
  id: string
  name: string
  moreCount: number
  /** Which half is missing: a `pending_approval` agent's approval, or an active agent's budget. */
  awaiting: 'approval' | 'budget'
}

interface Props {
  /**
   * #3818: any USDC above zero on one of the user's delegation accounts
   * (owner decision 2026-10-09), from the overview's per-account USDC (#3803).
   * `null` when that read is unavailable — the guide stays and says so, it
   * never reads an unknown balance as unfunded. Other tokens never count:
   * agents spend USDC, so ETH dust does not complete this step.
   */
  usdcFunded: boolean | null
  /**
   * An agent that can actually pay: active or paused, holding a usable budget
   * (`agentIsSetUp` in `lib/dashboard-attention.ts`, the one definition shared
   * with the "Needs attention" rules). A `pending_approval` or revoked agent never
   * completes step 2.
   */
  hasSetUpAgent: boolean
  /**
   * An agent waiting for setup, named by step 2's heading WHILE THE STEP IS
   * OPEN. The caller only passes it while step 2 is incomplete
   * (`DashboardClient`'s `stepTwoAgent`), but the title branches on
   * `hasSetUpAgent` too (#3976): a completed step keeps the imperative
   * "Connect your first agent" and names nobody, whatever this prop holds —
   * a ticked step must not carry a "Finish setting up" for an agent whose
   * row already renders below.
   */
  pendingAgent?: PendingSetupAgent | null
  hasFirstAgentPayment: boolean
  /**
   * #2534: the funding facts from `GET /user/accounts/:accountId/funding`. Only
   * `minimum_useful_human` is read here — the SUGGESTED amount (owner decision
   * 2026-10-09: suggested, not required). The deposit address belongs to the
   * Add-funds dialog, never this card (#3818). Optional: the card keeps its
   * general copy while the read is in flight or failed.
   */
  funding?: AccountFunding | null
  /** Opens Add funds — the dialog that carries the test-network faucet (#3478). */
  onAddFunds: () => void
  onAddAgent: () => void
  onShowAgentUsage: () => void
}

/**
 * The first-run steps (#3818). Rendered INSIDE the "Needs attention" card while
 * setup is in progress (the guide is that card), so it draws no card of its
 * own; `NeedsYou` lists the rule items that still apply below it.
 *
 * The finished state is NOT a branch of this component: since #4707 the first
 * agent payment gets its own card (`components/FirstAgentPaymentCard`), and
 * "Needs attention" goes back to meaning what it says.
 */
export default function DashboardOnboardingGuide({
  usdcFunded,
  hasSetUpAgent,
  pendingAgent = null,
  hasFirstAgentPayment,
  funding = null,
  onAddFunds,
  onAddAgent,
  onShowAgentUsage,
}: Props) {
  // Per instance: the /design-system page renders several guides at once.
  const labelId = useId()
  const funded = usdcFunded === true
  const activeStep = !funded ? 1 : !hasSetUpAgent ? 2 : !hasFirstAgentPayment ? 3 : null
  // Unlocked but not next (an agent set up before funding) is `available`:
  // one highlighted step at a time.
  const step3Status: StepStatus = hasFirstAgentPayment
    ? 'complete'
    : !hasSetUpAgent
      ? 'locked'
      : activeStep === 3
        ? 'active'
        : 'available'

  const fundingToken = funding?.tokens.find((t) => t.minimum_useful_human !== null) ?? null
  const fundingBody = fundingToken
    ? `We suggest ${fundingToken.minimum_useful_human} ${fundingToken.symbol}. Haven pays the network fees, and any amount gets you started.`
    : 'Your agents spend from this balance. Any amount gets you started.'

  const step1: StepProps = {
    status: funded ? 'complete' : usdcFunded === null ? 'unknown' : 'active',
    number: 1,
    title: 'Add USDC to your account',
    body:
      usdcFunded === null
        ? 'Haven could not read your USDC balance just now. This step updates when it can.'
        : fundingBody,
    // Funding alone gives no agent spend authority — that is step 2's budget —
    // so the done line states the fact, not a capability (#3818 design review).
    completedBody: 'Your account holds USDC.',
    cta: usdcFunded === false ? { label: 'Add funds', onClick: onAddFunds } : undefined,
    popOnComplete: true,
  }

  // Connecting before funding stays allowed (owner decision 2026-10-09): the
  // action shows from the start, at secondary weight until step 1 is done.
  const step2Cta: StepCta | undefined = hasSetUpAgent
    ? undefined
    : pendingAgent
      ? { label: 'Finish setup', href: `/agents/${pendingAgent.id}`, secondary: activeStep !== 2 }
      : { label: 'Connect agent', onClick: onAddAgent, secondary: activeStep !== 2 }
  const step2: StepProps = {
    status: hasSetUpAgent ? 'complete' : activeStep === 2 ? 'active' : 'available',
    number: 2,
    // A connected agent waiting for its budget is named in the heading, not
    // buried mid-sentence; the body keeps only the action (#3818 design
    // review). #3976: only while the step is OPEN — a completed step keeps
    // the imperative default and names nobody, whatever the caller passes.
    title: pendingAgent && !hasSetUpAgent
      ? `Finish setting up ${pendingAgent.name}${pendingAgent.moreCount > 0 ? ` and ${pendingAgent.moreCount} more` : ''}`
      : 'Connect your first agent',
    body: pendingAgent && !hasSetUpAgent
      ? pendingAgent.awaiting === 'approval'
        ? 'Approve its budget so it can pay.'
        : 'Set a budget so it can pay.'
      : 'Connect an agent and approve a budget it can spend from.',
    completedBody: 'An agent is connected with a budget.',
    cta: step2Cta,
    popOnComplete: true,
  }

  const step3: StepProps = {
    status: step3Status,
    number: 3,
    title: 'Make your first agent payment',
    body:
      step3Status === 'locked'
        ? 'Set up an agent first to unlock this step.'
        : 'Ask your agent to buy something within its budget.',
    completedBody: 'Your first agent payment went through.',
    cta: activeStep === 3 ? { label: 'Show me how', onClick: onShowAgentUsage } : undefined,
  }

  return (
    <div className="v2-animate-fade-in">
      {/* #3897: the card's heading already says "Get started", and "Hide
          for now" sits in that header (NeedsYou's `titleAction`). The list's
          own label is for assistive tech only, so the card is labelled once. */}
      <p id={labelId} className="sr-only">
        Your first 3 steps
      </p>

      <ol className="space-y-2" aria-labelledby={labelId}>
        <ChecklistRow {...step1} />
        <ChecklistRow {...step2} />
        <ChecklistRow {...step3} />
      </ol>
    </div>
  )
}

function ChecklistRow({ status, number, title, body, completedBody, cta, popOnComplete = false }: StepProps) {
  // #4704: Milestone Step plays only on a completion this row WATCHED — the
  // status changing to `complete` while mounted. The first render records the
  // status it found, so a step that is already complete on load (a reload, a
  // return to the dashboard, the /design-system specimens) just shows its
  // check. Kept in refs and decided during render, so the check is never drawn
  // once statically before it pops; a StrictMode double render sees the
  // status already recorded and decides the same way.
  const seenStatusRef = useRef<StepStatus>(status)
  const poppedRef = useRef(false)
  if (seenStatusRef.current !== status) {
    // Only a step the owner could still do — `active` or `available` — pops
    // when it completes. `unknown → complete` is a balance read recovering
    // for an account that was already funded, not something that just
    // happened, so it shows the check without a pop (the funds toast's
    // null → true rule, #4704 design review).
    const wasOpen = seenStatusRef.current === 'active' || seenStatusRef.current === 'available'
    poppedRef.current = popOnComplete && wasOpen && status === 'complete'
    seenStatusRef.current = status
  }
  const isActive = status === 'active'
  const isComplete = status === 'complete'
  const isLocked = status === 'locked'

  // `unknown` is not dimmed like `locked`: it is a state the owner should read.
  const rowClass = isLocked
      ? 'rounded-[10px] opacity-60'
      : 'rounded-[10px]'

  return (
    // #3818: always stacked. The guide lived in the narrow aside column on
    // desktop then, where a side-by-side action squeezed the step text into a
    // column of single words; the card is full width since #3897, and the
    // stacked row keeps one shape at every width.
    <li
      data-status={status}
      aria-current={isActive ? 'step' : undefined}
      className={`flex flex-col gap-3 px-4 py-3 ${rowClass}`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <StatusCircle status={status} number={number} pop={poppedRef.current} />
        <div className="min-w-0">
          <p
            className={`text-sm font-medium ${
              isLocked ? 'text-[var(--v2-ink-3)]' : 'text-[var(--v2-ink)]'
            }`}
          >
            {title}
          </p>
          <p
            className={`mt-0.5 text-xs leading-relaxed ${
              isLocked ? 'text-[var(--v2-ink-3)]' : 'text-[var(--v2-ink-2)]'
            }`}
          >
            {isComplete ? completedBody : body}
          </p>
        </div>
      </div>
      {cta ? (
        <div className="pl-10">
          <Button
            {...(cta.href ? { href: cta.href } : { onClick: cta.onClick })}
            variant={cta.secondary ? 'ghost' : 'primary'}
            size="sm"
            className="w-full sm:w-auto"
          >
            {cta.label}
          </Button>
        </div>
      ) : null}
    </li>
  )
}

function StatusCircle({ status, number, pop = false }: { status: StepStatus; number: number; pop?: boolean }) {
  if (status === 'complete') {
    return (
      <Milestone strength="step" play={pop} className="flex-shrink-0">
        <span
          aria-hidden="true"
          className={`inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full ${DONE_STEP_DISC_CLASS}`}
        >
          <CheckIcon />
        </span>
      </Milestone>
    )
  }
  if (status === 'active') {
    return (
      <span
        aria-hidden="true"
        className={`inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full ${ACTIVE_STEP_RING_CLASS} text-xs font-medium text-[var(--v2-ink-2)] v2-tabular`}
      >
        {number}
      </span>
    )
  }
  return (
    <span
      aria-hidden="true"
      className={`inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full ${PENDING_STEP_DISC_CLASS} text-xs font-medium v2-tabular`}
    >
      {number}
    </span>
  )
}

function CheckIcon(): ReactNode {
  return (
    <Icon icon={Check} className="h-3.5 w-3.5" strokeWidth={2} />
  )
}
