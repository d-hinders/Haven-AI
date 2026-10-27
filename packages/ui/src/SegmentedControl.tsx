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
 * ## The outlined, divided look (owner decision 2026-10-27, #4496)
 *
 * The group is a 1px `--v2-border` outline around content-width segments,
 * divided by hairline `--v2-border` rules — no tinted track, no padding. The
 * selected segment is `--v2-brand-soft` fill + `--v2-brand` ink + semibold,
 * with NO outline. That deliberately relaxes #4056's selected outline (added
 * for WCAG 1.4.11 non-text contrast) the same way the mobile tab bar's was
 * relaxed (#4237): selection is carried by the fill, the ink, the
 * semibold-vs-medium weight step and `aria-checked`. The weight step is the
 * load-bearing non-colour cue (WCAG 1.4.1), because brand vs ink-2 is hue
 * only — 1.01:1 light / 1.11:1 dark. Measured from the tokens: brand on
 * brand-soft 5.62:1 light / 6.63:1 dark (text, ≥ 4.5:1); ink-2 on `--v2-bg`
 * 6.36 / 9.63 and on `--v2-surface` 6.02 / 8.90 (unselected text, ≥ 4.5:1);
 * brand-soft vs bg 1.12 / 1.30 and vs surface 1.06 / 1.20 (supplementary);
 * the group border vs bg 1.20 / 1.41 and vs surface 1.13 / 1.30
 * (supplementary — the labels identify the control). The full record lives in
 * design-system.md § Tap targets.
 *
 * The group is `inline-flex`, so it is content-width: a block parent (e.g.
 * connect-agent's `space-y-3`) would otherwise stretch it, and once divided
 * the trailing space would read as an empty fourth segment. It carries NO
 * `overflow-hidden` — that would clip each option's `::after` hit-area
 * overhang in paint AND hit-testing. The outer segments are rounded instead
 * (`first:rounded-l-[5px] last:rounded-r-[5px]` — `rounded-md` minus the 1px
 * border); inner segments stay square.
 *
 * ## Focus
 *
 * Every option keeps the outset `focus-visible:ring-2 focus-visible:ring-brand/80`
 * and adds `focus-visible:z-10`: the options are `relative` and abut, so
 * without the stacking bump the next segment's fill would paint over the ring.
 * No option uses `ring-inset` — `--tw-ring-inset` is never reset, so an inset
 * ring would leak into the focus ring and shrink it to a 1px thickening of the
 * same hue.
 *
 * ## 44px hit area, painted size unchanged (#4056)
 *
 * An option paints 32px tall (`py-1.5` + `text-sm`). Like `Button`'s `sm` /
 * `md` (#1726), each option carries a transparent `::after` that extends the
 * HIT area to 44px vertically — never sideways, because the options abut. The
 * overhang is 6px per edge from the option; without the old `p-1` track the
 * group is 34px, so it sits 5px past the group's border. The "8px between
 * stacked controls" rule in design-system.md § Tap targets assumes ≤ 4px
 * overhangs, so this control needs ≥ 12px to a stacked neighbour.
 *
 * ## No width shift on selection
 *
 * Semibold is wider than medium, so each option reserves the bold width with a
 * `::before` (`::after` is the hit area) carrying `content: attr(data-label)`
 * at `font-semibold`, `invisible`, `h-0 overflow-hidden block`. It adds no
 * text node — `textContent` stays the bare label, which `Sidebar.test.tsx` and
 * `navigation.mobile.spec.ts` assert.
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
      className="inline-flex divide-x divide-[var(--v2-border)] rounded-md border border-[var(--v2-border)]"
    >
      {options.map((option) => {
        const active = value === option.value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            data-label={option.label}
            onClick={() => onChange(option.value)}
            disabled={disabled}
            className={`relative px-3 py-1.5 text-sm transition-colors before:block before:h-0 before:overflow-hidden before:font-semibold before:invisible before:content-[attr(data-label)] after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2 after:content-[''] first:rounded-l-[5px] last:rounded-r-[5px] focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 ${
              active
                ? 'bg-[var(--v2-brand-soft)] font-semibold text-[var(--v2-brand)]'
                : 'font-medium text-[var(--v2-ink-2)] hover:text-[var(--v2-ink)]'
            } disabled:cursor-not-allowed disabled:opacity-50`}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
