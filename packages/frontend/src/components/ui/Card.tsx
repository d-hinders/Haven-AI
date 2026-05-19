import type { ReactNode } from 'react'

type Elevation = 'flat' | 'raised' | 'anchor'

interface CardProps {
  children: ReactNode
  className?: string
  as?: 'div' | 'article'
  hover?: boolean
  /**
   * Surface elevation tier.
   * - `flat` (default): standard card. One elevation per page is plenty.
   * - `raised`: the single most prominent surface on a page (e.g. balance hero,
   *   the dashboard total). Hover lift is suppressed — it's already prominent.
   * - `anchor`: secondary focal point. Cooler off-white background + brand-tinted
   *   hairline border. Use for the second-most-important surface on a page
   *   (pending approvals callout, agent status banner). Don't sprinkle.
   */
  elevation?: Elevation
}

function CardRoot({
  children,
  className = '',
  as: Tag = 'div',
  hover = true,
  elevation = 'flat',
}: CardProps) {
  const surfaceClass =
    elevation === 'anchor'
      ? 'bg-[var(--v2-surface-anchor)] border border-[var(--v2-border-anchor)]'
      : 'bg-white border border-[var(--v2-border)]'
  const shadowClass =
    elevation === 'raised'
      ? 'shadow-[var(--v2-shadow-card-raised)]'
      : elevation === 'anchor'
        ? 'shadow-[var(--v2-shadow-card-raised)]'
        : 'shadow-[var(--v2-shadow-card)]'
  // Raised + anchor surfaces don't need a second hover lift — they're already prominent.
  const hoverClass =
    elevation !== 'flat' || !hover
      ? ''
      : 'hover:shadow-[0_8px_24px_-12px_rgba(16,24,40,0.12)] transition-shadow duration-200'
  return (
    <Tag
      className={`rounded-[10px] ${surfaceClass} ${shadowClass} ${hoverClass} ${className}`}
    >
      {children}
    </Tag>
  )
}

/**
 * A subsection inside a <Card>. Renders white-on-white with a hairline top
 * border that bleeds to the card's inner edge — the canonical way to group
 * content inside a card. Avoids the grey-on-white nested-card pattern.
 *
 * Pass `inset` if the section should be visually recessed (rare; reserve for
 * code blocks or quote-style content). Default is the hairline style.
 */
function CardSection({
  children,
  className = '',
  inset = false,
}: {
  children: ReactNode
  className?: string
  inset?: boolean
}) {
  // Negative horizontal margin matches the standard Card padding (p-5/p-6) so the
  // border bleeds edge-to-edge. Callers control vertical padding via className.
  const base = inset
    ? 'bg-[var(--v2-surface)] -mx-5 md:-mx-6 px-5 md:px-6 border-y border-[var(--v2-border)]'
    : '-mx-5 md:-mx-6 px-5 md:px-6 border-t border-[var(--v2-border)]'
  return <div className={`${base} ${className}`}>{children}</div>
}

export const Card = Object.assign(CardRoot, { Section: CardSection })
