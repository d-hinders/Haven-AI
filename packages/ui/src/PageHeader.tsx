import type { ReactNode } from 'react'
import { BackLink } from './BackLink'

export type PageHeaderProps = {
  title: string
  subtitle?: ReactNode
  /**
   * A quiet metadata line under the subtitle, in `v2-text-meta` / ink-3 —
   * the "My account · Base · Created … · Last activity …" register (#3692).
   * Optional and additive: callers that pass no `meta` render exactly as
   * before. Wraps alongside the header actions at phone width — the #2821
   * 390 px header regression is the case this slot is designed against.
   */
  meta?: ReactNode
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
  /**
   * The way back to the parent page, drawn above the title (#4028, epic
   * #4027). Name the parent only: `{ href: '/agents', label: 'Agents' }`.
   * Optional and additive: without it the header renders exactly as before.
   * A branch of the same page that renders no `PageHeader` (a loading
   * skeleton, a not-found card) uses `BackLink` directly with the same values.
   */
  back?: { href: string; label: string }
}

export function PageHeader({
  title,
  subtitle,
  meta,
  eyebrow,
  actions,
  inlineActions = false,
  back,
}: PageHeaderProps) {
  const rowClass = `flex gap-4 sm:flex-row sm:items-center sm:justify-between ${
    inlineActions ? 'flex-row items-start justify-between' : 'flex-col'
  }`
  const row = (
    <>
      <div className="min-w-0">
        {eyebrow && (
          <p className="v2-text-meta text-[var(--v2-ink-3)] uppercase tracking-wider mb-1">{eyebrow}</p>
        )}
        <h1 className="v2-text-h1 text-[var(--v2-ink)]">{title}</h1>
        {subtitle && (
          <p className="mt-2 v2-text-body text-[var(--v2-ink-2)] max-w-2xl">{subtitle}</p>
        )}
        {meta && <p className="mt-2 v2-text-meta text-[var(--v2-ink-3)] max-w-2xl">{meta}</p>}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2 flex-shrink-0">{actions}</div>
      )}
    </>
  )

  // Without `back` the markup is exactly what it was before #4028: one
  // `<header>` that is itself the flex row. With it, the link sits ABOVE the
  // row rather than inside the title column, so the actions stay centred
  // against the title instead of being pushed down by the link's line.
  if (!back) {
    return <header className={`mb-6 ${rowClass}`}>{row}</header>
  }

  return (
    <header className="mb-6">
      <BackLink href={back.href} label={back.label} className="mb-2" />
      <div className={rowClass}>{row}</div>
    </header>
  )
}

export default PageHeader
