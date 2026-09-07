'use client'

/**
 * Two-format switch for the manual credential payload — the .env block vs the
 * prose prompt (#2482).
 *
 * Deliberately local to connect-agent/. Per the pattern-absorption preflight
 * (#901), a primitive moves into components/ui/ (and onto /design-system)
 * only on its SECOND occurrence; this is the product's first segmented
 * control.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: ReadonlyArray<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
  /** Accessible group name — read by screen readers as "Label, option A…". */
  label: string
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex gap-0.5 rounded-md border border-[var(--v2-border)] bg-[var(--v2-surface)] p-0.5"
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={`min-h-9 rounded-[4px] px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--v2-surface)] ${
              active
                ? 'bg-white text-[var(--v2-ink)] shadow-sm'
                : 'text-[var(--v2-ink-2)] hover:text-[var(--v2-ink)]'
            }`}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
