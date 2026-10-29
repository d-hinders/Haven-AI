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
  /**
   * A mark drawn before the title and centred on it (#4210, epic #4207) —
   * built for an agent's `Monogram` (#4208), so the detail header can carry
   * the same mark as the agent's row. The title prints beside it, so pass a
   * decorative mark.
   * Optional and additive: without it the header renders exactly as before.
   */
  leading?: ReactNode
}

export function PageHeader({
  title,
  subtitle,
  meta,
  eyebrow,
  actions,
  inlineActions = false,
  back,
  leading,
}: PageHeaderProps) {
  const rowClass = `flex gap-4 sm:flex-row sm:items-center sm:justify-between ${
    inlineActions ? 'flex-row items-start justify-between' : 'flex-col'
  }`
  const row = (
    <>
      {/* `min-w-min`, not `min-w-0` (#3963): the column may shrink, but never
          below its own longest word. With `min-w-0` a fat actions row could
          flex the title column under the title's own text width — at 640 the
          Analytics header left it 59px for a 124px word, and the subtitle
          wrapped one word per line. The floor makes the SHRINK land on the
          actions row instead, whose own wrap then absorbs it. */}
      <div className="min-w-min">
        {eyebrow && (
          <p className="v2-text-meta text-[var(--v2-ink-3)] uppercase tracking-wider mb-1">{eyebrow}</p>
        )}
        {leading ? (
          <div className="flex items-center gap-3">
            <span className="flex flex-shrink-0">{leading}</span>
            <h1 className="v2-text-h1 min-w-0 text-[var(--v2-ink)]">{title}</h1>
          </div>
        ) : (
          <h1 className="v2-text-h1 text-[var(--v2-ink)]">{title}</h1>
        )}
        {subtitle && (
          <p className="mt-2 v2-text-body text-[var(--v2-ink-2)] max-w-2xl">{subtitle}</p>
        )}
        {meta && <p className="mt-2 v2-text-meta text-[var(--v2-ink-3)] max-w-2xl">{meta}</p>}
      </div>
      {actions && (
        // No `flex-shrink-0` (#3963): a rigid max-content row and a
        // shrinkable title column meant the title ALWAYS lost — from `sm` up
        // to where the row fit, the title column was squeezed to the
        // remainder (59px at 640 on Linux metrics). The row already wraps;
        // allowed to shrink, it drops its own children to a second line
        // while it fits (`min-content` is its widest child), and keeps
        // max-content wherever it did fit. Below `sm` the header is a
        // column, so shrink never applies there.
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
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
