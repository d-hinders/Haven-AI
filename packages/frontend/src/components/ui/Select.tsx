import type { SelectHTMLAttributes } from 'react'

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
 */
export function Select({
  className = '',
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`w-full rounded-md border border-[var(--v2-border)] bg-[var(--v2-bg)] px-3 py-2 text-sm text-[var(--v2-ink)] transition-colors focus-visible:border-[var(--v2-brand)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/80 disabled:cursor-not-allowed disabled:bg-[var(--v2-surface)] disabled:text-[var(--v2-ink-3)] ${className}`}
      {...props}
    >
      {children}
    </select>
  )
}
