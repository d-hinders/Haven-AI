'use client'

import type { ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { Check } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
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
   * with the "Needs you" rules). A `pending_approval` or revoked agent never
   * completes step 2.
   */
  hasSetUpAgent: boolean
  /** When step 2 is open and an agent is waiting for setup, it names that agent. */
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
  /** "Hide for now" — the caller persists it per user until a step completes. */
  onHide: () => void
}

/**
 * The first-run steps (#3818). Rendered INSIDE the "Needs you" card while
 * setup is in progress (the guide is that card), so it draws no card of its
 * own; `NeedsYou` lists the rule items that still apply below it. The
 * finished state is `SetupCompleteLine`, not a branch of this component.
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
  onHide,
}: Props) {
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
    ? `We suggest ${fundingToken.minimum_useful_human} ${fundingToken.symbol} — no gas token needed: Haven sponsors it. Any amount gets you started.`
    : 'Add USDC so your agents have money to spend. Any amount gets you started.'

  const step1: StepProps = {
    status: funded ? 'complete' : usdcFunded === null ? 'unknown' : 'active',
    number: 1,
    title: 'Add USDC to your account',
    body:
      usdcFunded === null
        ? 'Haven could not read your USDC balance just now. This step updates when it can.'
        : fundingBody,
    completedBody: 'Funded — your agents can spend.',
    cta: usdcFunded === false ? { label: 'Add funds', onClick: onAddFunds } : undefined,
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
    title: 'Connect your first agent',
    body: pendingAgent
      ? `Finish setting up ${pendingAgent.name}${pendingAgent.moreCount > 0 ? ` and ${pendingAgent.moreCount} more` : ''}: ${
          pendingAgent.awaiting === 'approval' ? 'approve its budget' : 'set a budget'
        } so it can pay.`
      : 'Connect an agent and approve a budget it can spend from.',
    completedBody: 'An agent is connected with a budget.',
    cta: step2Cta,
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
      <div className="flex items-center justify-between gap-3">
        <p id="first-run-steps-label" className="text-sm text-[var(--v2-ink-2)]">
          Your first 3 steps
        </p>
        <Button variant="tertiary" size="sm" onClick={onHide}>
          Hide for now
        </Button>
      </div>

      <ol className="mt-3 space-y-2" aria-labelledby="first-run-steps-label">
        <ChecklistRow {...step1} />
        <ChecklistRow {...step2} />
        <ChecklistRow {...step3} />
      </ol>
    </div>
  )
}

/**
 * The finished state (#3818): one line, not a banner. Dismissal is the
 * caller's (`haven-onboarding-complete-dismissed:<userId>`, read as before so
 * an owner who dismissed the old banner does not see this again).
 */
export function SetupCompleteLine({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 v2-animate-fade-in">
      <p className="flex items-center gap-2 text-sm text-[var(--v2-ink)]">
        <span
          aria-hidden="true"
          className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-[var(--v2-success)] text-[var(--v2-ink-on-brand)]"
        >
          <Icon icon={Check} className="h-3 w-3" />
        </span>
        You&rsquo;re set up — your agents can pay within the budgets you approved.
      </p>
      <Button variant="tertiary" size="sm" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  )
}

function ChecklistRow({ status, number, title, body, completedBody, cta }: StepProps) {
  const isActive = status === 'active'
  const isComplete = status === 'complete'
  const isLocked = status === 'locked'

  // `unknown` is not dimmed like `locked`: it is a state the owner should read.
  const rowClass = isActive
    ? 'rounded-[10px] border border-brand/15 bg-brand-soft/40'
    : isLocked
      ? 'rounded-[10px] opacity-60'
      : 'rounded-[10px]'

  return (
    // #3818: always stacked — the guide lives in the Needs you card, which is
    // the narrow aside column on desktop, so a side-by-side action squeezed
    // the step text into a column of single words.
    <li
      data-status={status}
      aria-current={isActive ? 'step' : undefined}
      className={`flex flex-col gap-3 px-4 py-3 ${rowClass}`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <StatusCircle status={status} number={number} />
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

function StatusCircle({ status, number }: { status: StepStatus; number: number }) {
  if (status === 'complete') {
    return (
      <span
        aria-hidden="true"
        className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[var(--v2-success)] text-[var(--v2-ink-on-brand)]"
      >
        <CheckIcon />
      </span>
    )
  }
  if (status === 'active') {
    return (
      <span
        aria-hidden="true"
        className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[var(--v2-brand)] text-xs font-semibold text-[var(--v2-ink-on-brand)] v2-tabular"
      >
        {number}
      </span>
    )
  }
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border border-[var(--v2-border-strong)] text-xs font-semibold text-[var(--v2-ink-3)] v2-tabular"
    >
      {number}
    </span>
  )
}

function CheckIcon(): ReactNode {
  return (
    <Icon icon={Check} className="h-4 w-4" />
  )
}
