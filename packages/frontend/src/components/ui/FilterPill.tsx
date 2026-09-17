import type { ReactNode } from 'react'

/**
 * Segment pill for a filter row — active/inactive toggle button, shared
 * across every list surface that filters by a small set of options
 * (category, verification source, network). Moved here from
 * `CatalogPanel.tsx` (#3079, epic #3077) on its second surface — the
 * marketplace grid needed the exact same pill the old catalog page had, and
 * a second hand-rolled copy is the pattern-absorption trigger (epic #904).
 */
export function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? 'bg-[var(--v2-brand)] text-[var(--v2-ink-on-brand)]'
          : 'bg-[var(--v2-surface-2)] text-[var(--v2-ink-2)] hover:bg-[var(--v2-border)]'
      }`}
    >
      {children}
    </button>
  )
}
