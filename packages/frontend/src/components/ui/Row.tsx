import Link from 'next/link'
import type { ReactNode } from 'react'

type Density = 'comfortable' | 'compact'
type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'brand'

interface BaseRowProps {
  /** Leading slot — typically a 16px icon. Pairs with `leadingTone` for a soft tinted circle. */
  leading?: ReactNode
  /** Optional tone for the leading icon background — renders the icon inside a 32px soft circle. */
  leadingTone?: Tone
  /** Primary label. Rendered as 14px medium ink. */
  title: ReactNode
  /** Secondary line below the title (12px ink-3). */
  subtitle?: ReactNode
  /** Right-hand slot — value, badge, chevron, action button. */
  trailing?: ReactNode
  /** Visual density. `comfortable` (default) is for top-level lists; `compact` for dense panels. */
  density?: Density
  /** If true, renders a 2px left accent bar in `--v2-brand` (e.g. active state). */
  accent?: boolean
  /** Extra classes — applied to the row root. */
  className?: string
}

interface StaticRowProps extends BaseRowProps {
  href?: undefined
  onClick?: undefined
}

interface LinkRowProps extends BaseRowProps {
  href: string
  onClick?: () => void
}

interface ButtonRowProps extends BaseRowProps {
  href?: undefined
  onClick: () => void
}

type RowProps = StaticRowProps | LinkRowProps | ButtonRowProps

const TONE_BG: Record<Tone, string> = {
  neutral: 'bg-[var(--v2-surface-2)] text-[var(--v2-ink-2)]',
  success: 'bg-[var(--v2-success-soft)] text-[var(--v2-success)]',
  warning: 'bg-[var(--v2-warning-soft)] text-[var(--v2-warning)]',
  danger: 'bg-[var(--v2-danger-soft)] text-[var(--v2-danger)]',
  brand: 'bg-[var(--v2-brand-soft)] text-[var(--v2-brand)]',
}

/**
 * Single-row primitive for lists, list-like sections, and clickable cards.
 *
 * Standardizes the icon + title + subtitle + trailing layout so every list in
 * the app shares the same rhythm, hover behaviour, and tap target.
 *
 * Interactive variants (`href` or `onClick`) get hover + focus styles for free.
 * Static variants (no `href`/`onClick`) render as a plain div.
 */
export function Row(props: RowProps) {
  const {
    leading,
    leadingTone,
    title,
    subtitle,
    trailing,
    density = 'comfortable',
    accent = false,
    className = '',
    href,
    onClick,
  } = props

  const isInteractive = Boolean(href || onClick)

  // Comfortable: 56px-ish tall, normal padding. Compact: 44px-ish, tighter.
  const paddingClass = density === 'compact' ? 'px-3 py-2.5' : 'px-4 py-3'
  const gapClass = density === 'compact' ? 'gap-2.5' : 'gap-3'

  const hoverClass = isInteractive
    ? 'hover:bg-[var(--v2-surface-hover)] focus-visible:bg-[var(--v2-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--v2-brand)]/30'
    : ''

  const rootClass = `relative flex items-center ${gapClass} ${paddingClass} transition-colors duration-150 ${hoverClass} ${className}`

  const leadingNode = leading
    ? leadingTone
      ? (
          <span
            aria-hidden="true"
            className={`inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full ${TONE_BG[leadingTone]}`}
          >
            <span className="inline-flex h-4 w-4 items-center justify-center">{leading}</span>
          </span>
        )
      : (
          <span
            aria-hidden="true"
            className="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center text-[var(--v2-ink-3)]"
          >
            {leading}
          </span>
        )
    : null

  const body = (
    <>
      {accent && (
        <span
          aria-hidden="true"
          className="absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-r-full bg-[var(--v2-brand)]"
        />
      )}
      {leadingNode}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-[var(--v2-ink)]">{title}</p>
        {subtitle ? (
          <p className="mt-0.5 truncate text-xs text-[var(--v2-ink-3)]">{subtitle}</p>
        ) : null}
      </div>
      {trailing ? <div className="flex-shrink-0">{trailing}</div> : null}
    </>
  )

  if (href) {
    return (
      <Link href={href} onClick={onClick} className={rootClass}>
        {body}
      </Link>
    )
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={`${rootClass} w-full text-left`}>
        {body}
      </button>
    )
  }
  return <div className={rootClass}>{body}</div>
}

export default Row
