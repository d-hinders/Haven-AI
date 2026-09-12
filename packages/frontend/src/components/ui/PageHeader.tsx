import type { ReactNode } from 'react'

export type PageHeaderProps = {
  title: string
  subtitle?: ReactNode
  eyebrow?: string
  actions?: ReactNode
  /**
   * Keep `actions` on the title's row at every width (#2821).
   *
   * The default stacks below `sm`, which is right for a ROW OF LABELLED
   * BUTTONS — they need the width and they read as a group. It is wrong for a
   * single icon-only control: on agent detail the slot usually holds just the
   * kebab, because the `StatusBadge` beside it renders `null` while the agent
   * is active, so the stacked row contained one 44px icon, left-aligned,
   * belonging visually to nothing.
   *
   * A prop rather than a `Children.count`: counting tells you how many nodes
   * there are, not whether they are icon-only, and a caller that wraps its
   * actions in a fragment or a `<div>` counts as one either way. The caller
   * knows which shape it has; the primitive owns what to do about it.
   */
  inlineActions?: boolean
}

export function PageHeader({
  title,
  subtitle,
  eyebrow,
  actions,
  inlineActions = false,
}: PageHeaderProps) {
  return (
    <header
      className={`mb-6 flex gap-4 sm:flex-row sm:items-center sm:justify-between ${
        inlineActions ? 'flex-row items-start justify-between' : 'flex-col'
      }`}
    >
      <div className="min-w-0">
        {eyebrow && (
          <p className="v2-text-meta text-[var(--v2-ink-3)] uppercase tracking-wider mb-1">{eyebrow}</p>
        )}
        <h1 className="v2-text-h1 text-[var(--v2-ink)]">{title}</h1>
        {subtitle && (
          <p className="mt-2 v2-text-body text-[var(--v2-ink-2)] max-w-2xl">{subtitle}</p>
        )}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2 flex-shrink-0">{actions}</div>
      )}
    </header>
  )
}

export default PageHeader
