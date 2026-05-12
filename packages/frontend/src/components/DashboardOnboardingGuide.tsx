'use client'

import { Button } from '@/components/ui/Button'

type Stage = 'fund' | 'add-agent'

interface Props {
  stage: Stage
  onReceiveFunds: () => void
  onAddAgent: () => void
  onDismiss: () => void
}

export default function DashboardOnboardingGuide({
  stage,
  onReceiveFunds,
  onAddAgent,
  onDismiss,
}: Props) {
  const isFundingStep = stage === 'fund'
  const title = isFundingStep ? 'Receive funds' : 'Connect your first agent'
  const body = isFundingStep
    ? 'Copy your Haven wallet address and network before sending funds.'
    : 'Set a budget, then add the Haven credential to the agent you want to use.'
  const primaryAction = isFundingStep ? 'Receive funds' : 'Connect first agent'

  return (
    <section className="rounded-[14px] border border-[var(--v2-border)] bg-white p-5 shadow-[var(--v2-shadow-card)]">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--v2-brand)]">
            Next setup step
          </p>
          <h2 className="mt-1 text-lg font-semibold tracking-tight text-[var(--v2-ink)]">
            {title}
          </h2>
          <p className="mt-1 max-w-xl text-sm leading-relaxed text-[var(--v2-ink-2)]">
            {body}
          </p>
        </div>

        <div className="flex flex-col gap-2 sm:w-auto sm:min-w-44">
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
    </section>
  )
}
