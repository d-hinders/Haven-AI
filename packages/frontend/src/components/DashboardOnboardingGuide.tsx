'use client'

import { getChainConfig } from '@/lib/chains'
import { Button } from '@/components/ui/Button'
import type { UserSafe } from '@/context/AuthContext'

type Stage = 'fund' | 'add-agent'
type StepState = 'done' | 'active' | 'next' | 'todo'

interface Props {
  stage: Stage
  safes: UserSafe[]
  onReceiveFunds: () => void
  onAddAgent: () => void
  onDismiss: () => void
}

function getDefaultSafe(safes: UserSafe[]): UserSafe | null {
  return safes.find((entry) => entry.is_default) ?? safes[0] ?? null
}

function setupSteps(stage: Stage): Array<{
  label: string
  description: string
  state: StepState
}> {
  return [
    {
      label: 'Create account',
      description: 'Your Haven account is ready.',
      state: 'done',
    },
    {
      label: 'Receive funds',
      description: 'Copy the wallet address and network before sending.',
      state: stage === 'fund' ? 'active' : 'done',
    },
    {
      label: 'Connect agent',
      description: 'Create a Haven credential for your agent.',
      state: stage === 'add-agent' ? 'active' : 'todo',
    },
    {
      label: 'Set budget',
      description: 'Choose token, amount, and reset period.',
      state: stage === 'add-agent' ? 'next' : 'todo',
    },
  ]
}

function stepClasses(state: StepState): {
  dot: string
  line: string
  title: string
  body: string
} {
  if (state === 'done') {
    return {
      dot: 'border-[var(--v2-success)]/25 bg-[var(--v2-success-soft)] text-[var(--v2-success)]',
      line: 'bg-[var(--v2-success)]/30',
      title: 'text-[var(--v2-ink)]',
      body: 'text-[var(--v2-ink-3)]',
    }
  }

  if (state === 'active') {
    return {
      dot: 'border-[var(--v2-brand)] bg-[var(--v2-brand)] text-white shadow-[var(--v2-shadow-button)]',
      line: 'bg-[var(--v2-border)]',
      title: 'text-[var(--v2-ink)]',
      body: 'text-[var(--v2-ink-2)]',
    }
  }

  if (state === 'next') {
    return {
      dot: 'border-[var(--v2-brand)]/25 bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]',
      line: 'bg-[var(--v2-border)]',
      title: 'text-[var(--v2-ink-2)]',
      body: 'text-[var(--v2-ink-3)]',
    }
  }

  return {
    dot: 'border-[var(--v2-border)] bg-white text-[var(--v2-ink-3)]',
    line: 'bg-[var(--v2-border)]',
    title: 'text-[var(--v2-ink-3)]',
    body: 'text-[var(--v2-ink-3)]',
  }
}

function SetupStep({
  index,
  isLast,
  label,
  description,
  state,
}: {
  index: number
  isLast: boolean
  label: string
  description: string
  state: StepState
}) {
  const classes = stepClasses(state)

  return (
    <li className="relative flex gap-3">
      <div className="flex flex-col items-center">
        <span className={`flex h-7 w-7 items-center justify-center rounded-full border text-[11px] font-semibold ${classes.dot}`}>
          {state === 'done' ? (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          ) : (
            index + 1
          )}
        </span>
        {!isLast ? <span className={`mt-2 h-8 w-px ${classes.line}`} aria-hidden /> : null}
      </div>
      <div className="min-w-0 pb-4">
        <p className={`text-sm font-medium ${classes.title}`}>{label}</p>
        <p className={`mt-0.5 text-xs leading-relaxed ${classes.body}`}>{description}</p>
      </div>
    </li>
  )
}

function DetailRow({
  label,
  value,
}: {
  label: string
  value: string
}) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] font-medium text-[var(--v2-ink-3)]">{label}</p>
      <p className="mt-1 truncate text-sm font-medium text-[var(--v2-ink)]">{value}</p>
    </div>
  )
}

export default function DashboardOnboardingGuide({
  stage,
  safes,
  onReceiveFunds,
  onAddAgent,
  onDismiss,
}: Props) {
  const safe = getDefaultSafe(safes)
  const chainConfig = safe ? getChainConfig(safe.chain_id) : null
  const isFundingStep = stage === 'fund'
  const title = isFundingStep ? 'Receive funds in your Haven wallet' : 'Connect your first agent'
  const body = isFundingStep
    ? 'Use Receive to copy the exact wallet address and network before sending funds.'
    : 'Set an agent budget, then add the Haven credential to the agent you want to use.'
  const primaryAction = isFundingStep ? 'Receive funds' : 'Connect first agent'
  const stepCount = isFundingStep ? 'Step 2 of 4' : 'Step 3 of 4'

  return (
    <aside className="xl:sticky xl:top-6">
      <div className="rounded-[14px] border border-[var(--v2-border)] bg-white shadow-[var(--v2-shadow-card)]">
        <div className="border-b border-[var(--v2-border)] bg-[var(--v2-surface)] px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--v2-brand)]">
                First setup
              </p>
              <h2 className="mt-1 text-base font-semibold tracking-tight text-[var(--v2-ink)]">
                {title}
              </h2>
              <p className="mt-1 text-sm leading-relaxed text-[var(--v2-ink-2)]">
                {body}
              </p>
            </div>
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss first setup guide"
              className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-md text-[var(--v2-ink-3)] transition-colors hover:bg-white hover:text-[var(--v2-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--v2-brand)]/30"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="space-y-5 p-5">
          <div className="rounded-[10px] border border-[var(--v2-border)] bg-[var(--v2-surface)] p-4">
            <p className="text-xs font-medium text-[var(--v2-ink-3)]">{stepCount}</p>
            <ol className="mt-4" aria-label="First setup progress">
              {setupSteps(stage).map((step, index, steps) => (
                <SetupStep
                  key={step.label}
                  index={index}
                  isLast={index === steps.length - 1}
                  label={step.label}
                  description={step.description}
                  state={step.state}
                />
              ))}
            </ol>
          </div>

          {safe && chainConfig ? (
            <div className="grid grid-cols-2 gap-3 rounded-[10px] border border-[var(--v2-border)] p-4">
              <DetailRow label="Haven wallet" value={safe.name} />
              <DetailRow label="Network" value={chainConfig.name} />
            </div>
          ) : null}

          <div className="rounded-[10px] border border-[var(--v2-border)] bg-white p-4">
            <p className="text-sm font-medium text-[var(--v2-ink)]">
              {isFundingStep ? 'Before you send' : 'What happens next'}
            </p>
            <p className="mt-1 text-sm leading-relaxed text-[var(--v2-ink-2)]">
              {isFundingStep
                ? 'Send only supported tokens on the network shown here. Funds appear after the transfer confirms.'
                : 'The agent can make payments within the budget. Anything above it waits for your approval.'}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Button
              onClick={isFundingStep ? onReceiveFunds : onAddAgent}
              size="lg"
              className="w-full"
            >
              {primaryAction}
            </Button>
            <Button
              onClick={onDismiss}
              variant="tertiary"
              size="sm"
              className="w-full"
            >
              Hide for now
            </Button>
          </div>
        </div>
      </div>
    </aside>
  )
}
