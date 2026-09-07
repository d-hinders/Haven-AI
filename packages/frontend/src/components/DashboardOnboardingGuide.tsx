'use client'

import type { ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import { Check } from 'lucide-react'
import { Icon } from '@/components/ui/Icon'
import type { SafeFunding } from '@/hooks/useSafeFunding'

type StepStatus = 'complete' | 'active' | 'locked'

interface StepProps {
  status: StepStatus
  number: number
  title: string
  body: string
  completedBody: string
  /** A second line under the body — the paste-ready facts (address, explorer). */
  detail?: string
  cta?: { label: string; onClick: () => void }
}

interface Props {
  hasFunds: boolean
  hasAgents: boolean
  hasFirstAgentPayment: boolean
  canConnectAgents?: boolean
  /**
   * #2534: the funding facts from `GET /user/safes/:safeId/funding` — the same
   * object `haven wallets funding` prints. The instruction text, the address
   * and the minimum are rendered FROM this payload, so the card and the CLI
   * cannot disagree: `@haven_ai/core` owns the minimum, the endpoint owns the
   * sentence's inputs, this card owns only the layout. Optional so the card
   * still renders (with the old general copy) while the read is in flight or
   * failed — the checklist must not go blank because one GET did.
   */
  funding?: SafeFunding | null
  onReceiveFunds: () => void
  onAddAgent: () => void
  onShowAgentUsage: () => void
  onDismiss: () => void
  onDismissComplete: () => void
  /** When true the in-progress checklist is hidden (user clicked "Hide for now"). */
  inProgressDismissed: boolean
  /** When true the setup-complete banner is hidden (user has dismissed the celebration). */
  completeDismissed: boolean
}

export default function DashboardOnboardingGuide({
  hasFunds,
  hasAgents,
  hasFirstAgentPayment,
  canConnectAgents = true,
  funding = null,
  onReceiveFunds,
  onAddAgent,
  onShowAgentUsage,
  onDismiss,
  onDismissComplete,
  inProgressDismissed,
  completeDismissed,
}: Props) {
  if (!canConnectAgents) return null

  const allComplete = hasFunds && hasAgents && hasFirstAgentPayment

  // Setup-complete banner — celebrate, then get out of the way.
  if (allComplete) {
    if (completeDismissed) return null
    return (
      <section className="v2-animate-slide-in flex flex-col gap-3 rounded-[14px] border border-success/20 bg-[var(--v2-success-soft)] px-5 py-4 shadow-card sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[var(--v2-success)] text-white"
          >
            <CheckIcon />
          </span>
          <div>
            <p className="text-sm font-semibold text-[var(--v2-ink)]">Setup complete</p>
            <p className="text-xs text-[var(--v2-ink-2)]">
              Your agents are live. Keep an eye on their recent activity below.
            </p>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onDismissComplete}>
          Dismiss
        </Button>
      </section>
    )
  }

  // User chose "Hide for now" — respect it until a step changes.
  if (inProgressDismissed) return null

  // Step 3 is locked until an agent exists — it can't be acted on otherwise.
  const step3Status: StepStatus = hasFirstAgentPayment
    ? 'complete'
    : !hasAgents
      ? 'locked'
      : 'active'

  // Active step is the first incomplete one in canonical order.
  const activeStep = !hasFunds ? 1 : !hasAgents ? 2 : !hasFirstAgentPayment ? 3 : null

  // #2534: the funding instruction is rendered from the endpoint payload — the
  // same object the CLI prints — so the card holds no second copy of the
  // minimum-useful constant (`@haven_ai/core` owns it; the endpoint reads it).
  // While the read is in flight or failed, the step keeps the general copy and
  // stays actionable: the "Receive funds" CTA below does not depend on it.
  const fundingToken = funding?.tokens.find((t) => t.minimum_useful_human !== null)
  const fundingBody = funding
    ? fundingToken
      ? `Add ${fundingToken.minimum_useful_human} ${fundingToken.symbol} — ${
          funding.native.needed
            ? `plus ${funding.native.symbol} for gas`
            : 'no gas token needed: Haven sponsors it'
        }. Even a little less lets you start.`
      : `Add USDC so your agents have money to spend.`
    : 'Add USDC so your agents have money to spend. Even $5 lets you try x402 micropayments.'
  const fundingDetail = funding
    ? `Send to ${funding.account_address} — see it on ${funding.chain.explorer_url.replace(/^https?:\/\//, '')}`
    : undefined

  const step1: StepProps = {
    status: hasFunds ? 'complete' : 'active',
    number: 1,
    title: 'Fund your Haven account',
    body: fundingBody,
    detail: hasFunds ? undefined : fundingDetail,
    completedBody: 'Funded — your agents can spend.',
    cta:
      activeStep === 1 ? { label: 'Receive funds', onClick: onReceiveFunds } : undefined,
  }

  const step2: StepProps = {
    status: hasAgents ? 'complete' : 'active',
    number: 2,
    title: 'Connect your first agent',
    body:
      'Set a budget and give your agent a Haven credential. It can pay for APIs and services within your rules.',
    completedBody: 'Agent connected.',
    cta:
      activeStep === 2 ? { label: 'Connect agent', onClick: onAddAgent } : undefined,
  }

  const step3: StepProps = {
    status: step3Status,
    number: 3,
    title: 'Make your first agent payment',
    body:
      step3Status === 'locked'
        ? 'Connect an agent first to unlock this step.'
        : 'Wire up your Haven credential in your agent code and let it pay an x402-enabled service.',
    completedBody: 'First agent payment made.',
    cta:
      activeStep === 3 && step3Status !== 'locked'
        ? { label: 'Show me how', onClick: onShowAgentUsage }
        : undefined,
  }

  return (
    <section className="v2-animate-fade-in rounded-[14px] border border-[var(--v2-border)] bg-white p-5 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--v2-brand)]">
            Get started
          </p>
          <h2 className="mt-1 text-lg font-semibold tracking-tight text-[var(--v2-ink)]">
            Your first 3 steps
          </h2>
        </div>
        <Button variant="tertiary" size="sm" onClick={onDismiss}>
          Hide for now
        </Button>
      </div>

      <ol className="mt-5 space-y-2" aria-label="Onboarding checklist">
        <ChecklistRow {...step1} />
        <ChecklistRow {...step2} />
        <ChecklistRow {...step3} />
      </ol>
    </section>
  )
}

function ChecklistRow({ status, number, title, body, detail, completedBody, cta }: StepProps) {
  const isActive = status === 'active'
  const isComplete = status === 'complete'
  const isLocked = status === 'locked'

  const rowClass = isActive
    ? 'rounded-[10px] border border-brand/15 bg-brand-soft/40'
    : isComplete
      ? 'rounded-[10px]'
      : 'rounded-[10px] opacity-60'

  return (
    <li
      className={`flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between ${rowClass}`}
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
          {detail && !isComplete ? (
            <p className="mt-1 break-all font-mono text-xs leading-relaxed text-[var(--v2-ink-2)]">
              {detail}
            </p>
          ) : null}
        </div>
      </div>
      {cta ? (
        <div className="flex-shrink-0 sm:pl-4">
          <Button onClick={cta.onClick} size="sm" className="w-full sm:w-auto">
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
        className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[var(--v2-success)] text-white"
      >
        <CheckIcon />
      </span>
    )
  }
  if (status === 'active') {
    return (
      <span
        aria-hidden="true"
        className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[var(--v2-brand)] text-xs font-semibold text-white v2-tabular"
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
