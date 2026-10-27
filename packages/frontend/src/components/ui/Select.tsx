import type { SelectHTMLAttributes } from 'react'
import { ChevronDown } from 'lucide-react'
import { Icon } from './Icon'

/**
 * Moved from `focus:` to `focus-visible:` with the rest of the form family
 * (#1746). This was expected to be the one place the switch changed behaviour —
 * `<select>` is not a text-entry field, so the Selectors-4 heuristic looked
 * like it should decline to match on a mouse click.
 *
 * Measured in Chromium, that is **wrong**: a mouse-clicked `<select>` matches
 * `:focus-visible` and keeps its ring, exactly like `<input>` and `<textarea>`.
 * The heuristic covers controls that accept keyboard input once focused, and a
 * select does (arrow keys, typeahead) — it is not restricted to text entry. A
 * mouse-clicked `<button>` in the same page, same click mechanism, measured
 * `:focus-visible = false` with no ring, which is what rules out the result
 * being a stuck keyboard modality.
 *
 * So the variant switch is behaviour-preserving here too. The heuristic is
 * UA-defined rather than spec-pinned, so a browser that declined to match would
 * simply drop the ring on mouse click — cosmetic, and never a keyboard
 * accessibility regression, since keyboard focus always matches.
 *
 * ## The chevron (#4492)
 *
 * The browser's own arrow is drawn by the UA hard against the right border and
 * cannot be padded, so the field opts out of it (`appearance-none`) and draws
 * the design system's disclosure marker instead: lucide `ChevronDown` through
 * `Icon`, at 14 px beside `text-sm` (§ 5 → Size), inside the right edge at
 * `right-3` with `pr-9` reserving the room. It is `pointer-events-none` so a
 * click on the glyph still opens the native picker, and `aria-hidden` (the
 * `Icon` default) because the `<select>` already announces itself.
 *
 * The icon is a sibling of the `<select>`, not a child — a `<select>` cannot
 * contain arbitrary markup — so the wrapper is `relative` and the icon is
 * absolutely positioned against it. The disabled colour rides `peer` on the
 * select plus `peer-disabled:` on the icon, which keeps the two in step without
 * a second source of truth for `disabled`.
 *
 * ## `className` lands on the WRAPPER, not the `<select>`
 *
 * This deliberately differs from `Input` (`packages/ui/src/Input.tsx`), whose
 * `className` goes on the `<input>`. The wrapper is the flex item a caller
 * lays out, so a width pin or `shrink-0` has to sit there: on the inner select
 * `shrink-0` would stop working the moment the wrapper became the flex item,
 * and a pinned width on the select itself overflows a narrower wrapper and
 * paints over its neighbour (measured in `haven/BudgetAmountRow.tsx`, a 160 px
 * input in a 128 px wrapper overlapped the select by 24 px). The wrapper stays
 * a block element, so `mt-1`/`mt-2` margins behave as they did when they were
 * on the select.
 *
 * Consumers must not add padding, `appearance-*`, a background-image arrow or
 * their own chevron — the primitive owns all of it.
 */
export function Select({
  className = '',
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={`relative ${className}`}>
      <select
        className="peer w-full appearance-none rounded-md border border-[var(--v2-border)] bg-[var(--v2-bg)] py-2 pl-3 pr-9 text-sm text-[var(--v2-ink)] transition-colors focus-visible:border-[var(--v2-brand)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 disabled:cursor-not-allowed disabled:bg-[var(--v2-surface)] disabled:text-[var(--v2-ink-3)]"
        {...props}
      >
        {children}
      </select>
      <Icon
        icon={ChevronDown}
        className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--v2-ink-2)] peer-disabled:text-[var(--v2-ink-3)]"
      />
    </div>
  )
}
