type StepProgressProps = {
  totalSteps: number
  /** 0-indexed active step. Pass `totalSteps` to render all steps as completed. */
  currentStep: number
  /**
   * One short label per step (a word or two), rendered under its disc. Optional
   * so a caller can still show bare numbers, but a stepper that spans the full
   * width reads better when each stop says what it is.
   */
  labels?: readonly string[]
  className?: string
}

/**
 * Step indicator that spans its container: the connectors stretch between the
 * discs, so the band reads as one track across the content width instead of a
 * cluster at the left. A label wider than its disc widens that column, which
 * insets the end discs by a few pixels — accepted over absolutely-positioned
 * labels that could clip at the modal edge.
 *
 * Semantics: an ordered list whose items carry the meaning — `aria-current` on
 * the active item, an `sr-only` "Step N of M" (plus "completed") prefix, and
 * the visible label as real text. The disc glyph (number or ✓) and the
 * connectors are decorative and hidden from assistive tech (#3832's
 * ConnectSteps is the same pattern).
 */
export function StepProgress({ totalSteps, currentStep, labels, className = '' }: StepProgressProps) {
  return (
    <ol className={`flex w-full items-start gap-2 sm:gap-3 ${className}`}>
      {Array.from({ length: totalSteps }).map((_, index) => {
        const isCompleted = index < currentStep
        const isActive = index === currentStep
        const isLast = index === totalSteps - 1
        const label = labels?.[index]
        return (
          <li
            key={index}
            aria-current={isActive ? 'step' : undefined}
            className={`flex items-start gap-2 sm:gap-3 ${isLast ? '' : 'flex-1'}`}
          >
            <div className="flex shrink-0 flex-col items-center gap-1.5">
              <span className="sr-only">
                {`Step ${index + 1} of ${totalSteps}${isCompleted ? ', completed' : ''}${label ? ': ' : ''}`}
              </span>
              <div
                aria-hidden="true"
                className={`h-7 w-7 shrink-0 rounded-full border text-xs font-medium flex items-center justify-center transition-colors duration-300 v2-tabular sm:h-8 sm:w-8 ${
                  isActive
                    ? 'border-[var(--v2-brand)] bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]'
                    : isCompleted
                      ? 'border-success/30 bg-[var(--v2-success-soft)] text-[var(--v2-success)]'
                      : 'border-[var(--v2-border)] text-[var(--v2-ink-3)]'
                }`}
              >
                {isCompleted ? '✓' : index + 1}
              </div>
              {label && (
                <span
                  className={`whitespace-nowrap text-xs transition-colors duration-300 ${
                    isActive ? 'font-medium text-[var(--v2-ink)]' : 'text-[var(--v2-ink-3)]'
                  }`}
                >
                  {label}
                </span>
              )}
            </div>
            {!isLast && (
              // Centred on the disc: half of h-7 (14px), half of sm:h-8 (16px).
              <div
                aria-hidden="true"
                data-filled={index < currentStep}
                className="v2-progress-line mt-3.5 h-px min-w-4 flex-1 bg-[var(--v2-border)] sm:mt-4"
              />
            )}
          </li>
        )
      })}
    </ol>
  )
}
