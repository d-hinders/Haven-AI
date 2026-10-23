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
 * One tinted track (`--v2-surface`); the track is a control surface, not a
 * grouping card, so it does not violate the no-nested-filled-cards surface
 * rule.
 *
 * ## The selected option uses the app's "active" idiom (#4056)
 *
 * Brand ink on `--v2-brand-soft`, bounded by a 1px inset brand outline — the
 * same pairing the nav uses for "you are here". It replaced a `--v2-surface-2`
 * thumb whose only boundary against the track was 1.06:1 (light) / 1.10:1
 * (dark), and which read as SUNKEN in light because `--v2-surface-2` is
 * darker than `--v2-surface`. Measured from the tokens: the brand boundary against
 * the track is 5.95:1 (light) / 7.99:1 (dark), clearing WCAG 1.4.11's 3:1 for
 * a component boundary, and brand text on brand-soft is 5.62:1 / 6.63:1. The
 * boundary is an OUTLINE at `-outline-offset-1`, so the painted size does not
 * move — and deliberately not an inset ring: `ring-inset` would leak into the
 * focus ring (`--tw-ring-inset` is never reset), shrinking focus on the
 * selected option to a 1px thickening of the same hue. Under `:focus-visible`
 * the outline is cleared and the option takes the same outset
 * `ring-2 ring-brand/80` every other option does.
 *
 * ## 44px hit area, painted size unchanged (#4056)
 *
 * An option paints 32px tall (`py-1.5` + `text-sm`). Like `Button`'s `sm` /
 * `md` (#1726), each option carries a transparent `::after` that extends the
 * HIT area to 44px vertically — never sideways, because the options abut. The
 * overhang is 6px per edge from the option, 1px past the track's `p-1` +
 * border, so the "8px between stacked controls" rule in design-system.md
 * § Tap targets applies to whatever sits above or below the control.
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
            className={`relative rounded px-3 py-1.5 text-sm font-medium transition-colors after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2 after:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 ${
              active
                ? 'bg-[var(--v2-brand-soft)] text-[var(--v2-brand)] outline outline-1 -outline-offset-1 outline-brand'
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
