import type { SelectHTMLAttributes } from 'react'

/**
 * Unlike `Input` and `Textarea`, moving this to `focus-visible:` (#1746) is a
 * real behavioural change: `<select>` is not a text-entry field, so the
 * Selectors-4 heuristic does NOT force a match on mouse focus, and a clicked
 * select no longer keeps a ring after its dropdown closes. That is the intended
 * outcome — it now behaves like every other clicked control in the product, and
 * a native select's open list is its own affordance.
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
