type StepProgressProps = {
  totalSteps: number
  /** 0-indexed active step. Pass `totalSteps` to render all steps as completed. */
  currentStep: number
  className?: string
}

export function StepProgress({ totalSteps, currentStep, className = '' }: StepProgressProps) {
  return (
    <div className={`flex items-center gap-2 sm:gap-3 ${className}`}>
      {Array.from({ length: totalSteps }).map((_, index) => {
        const isCompleted = index < currentStep
        const isActive = index === currentStep
        return (
          <div key={index} className="flex items-center gap-2 sm:gap-3">
            <div
              aria-label={`Step ${index + 1} of ${totalSteps}`}
              className={`h-7 w-7 shrink-0 rounded-full border text-xs font-medium flex items-center justify-center transition-colors duration-300 v2-tabular sm:h-8 sm:w-8 ${
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
                className="v2-progress-line h-px w-8 shrink-0 bg-[var(--v2-border)] sm:w-12"
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
