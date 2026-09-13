'use client'

/**
 * Segmented control — the canonical "choose one of two or three options"
 * toggle (#2927). Promoted here from Settings on its third occurrence: the
 * Settings currency and theme controls and connect-agent's credential-format
 * switch all shipped private copies (the pattern-absorption rule's second-
 * occurrence clause kept the first two local; the theme control made three).
 *
 * Semantics are RADIO, not buttons-with-`aria-pressed`: the options are a
 * mutually exclusive choice over one value, so the wrapper is
 * `role="radiogroup"` and each option `role="radio"` + `aria-checked`. The
 * group carries `aria-label` (required) so a screen reader names the question
 * before reading the options. Keyboard works for free — the options are real
 * `<button>`s, so Tab reaches the group and Enter/Space activates.
 *
 * One tinted track (`--v2-surface`) with a raised, shadowed thumb on the
 * active option; the track is a control surface, not a grouping card, so it
 * does not violate the no-nested-filled-cards surface rule. The thumb reads
 * `--v2-surface-2` rather than raw white so both palettes render it (white is
 * legal to `design:lint` and wrong in dark — #2927 moved the primitives off
 * `white`/`black`).
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  disabled = false,
  ariaLabel,
}: {
  options: ReadonlyArray<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
  disabled?: boolean
  /** Accessible group name — read by screen readers as "Label, option A…". */
  ariaLabel: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="flex rounded-md border border-[var(--v2-border)] bg-[var(--v2-surface)] p-1"
    >
      {options.map((option) => {
        const active = value === option.value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            disabled={disabled}
            className={`rounded px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 ${
              active
                ? 'bg-[var(--v2-surface-2)] text-[var(--v2-ink)] shadow-sm'
                : 'text-[var(--v2-ink-3)] hover:text-[var(--v2-ink)]'
            } disabled:cursor-not-allowed disabled:opacity-50`}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
