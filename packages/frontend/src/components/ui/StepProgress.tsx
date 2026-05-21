type StepProgressProps = {
  totalSteps: number
  /** 0-indexed active step. Pass `totalSteps` to render all steps as completed. */
  currentStep: number
  className?: string
}

export function StepProgress({ totalSteps, currentStep, className = '' }: StepProgressProps) {
  return (
    <div className={`flex items-center gap-3 ${className}`}>
      {Array.from({ length: totalSteps }).map((_, index) => {
        const isCompleted = index < currentStep
        const isActive = index === currentStep
        return (
          <div key={index} className="flex items-center gap-3">
            <div
              aria-label={`Step ${index + 1} of ${totalSteps}`}
              className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium border transition-colors duration-300 v2-tabular ${
                isActive
                  ? 'border-[var(--v2-brand)] bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]'
                  : isCompleted
                    ? 'border-[var(--v2-success)]/30 bg-[var(--v2-success-soft)] text-[var(--v2-success)]'
                    : 'border-[var(--v2-border)] text-[var(--v2-ink-3)]'
              }`}
            >
              {isCompleted ? '✓' : index + 1}
            </div>
            {index < totalSteps - 1 && (
              <div
                data-filled={index < currentStep}
                className="v2-progress-line h-px w-12 shrink-0 bg-[var(--v2-border)]"
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
