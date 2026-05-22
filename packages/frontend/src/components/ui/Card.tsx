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
 * content inside a card.
 *
 * **Design-system invariant:** never use a tinted background to "group" content
 * inside a Card (e.g. `bg-[var(--v2-surface)]` on a wrapper). Reach for
 * `Card.Section` for white-on-white grouping, `Card.Section divided` for a
 * row list, or `Row` for individual list items. Tinted surfaces are reserved
 * for callouts, table headers, anchor cards, chips, code blocks, and overlay
 * surfaces — not generic grouping.
 *
 * Modes:
 * - **default** — hairline `border-t` above, white background, standard
 *   horizontal padding matching the parent Card. Use for a single content
 *   block under a section heading inside a Card with `p-5`/`p-6` padding.
 *   Negative margins bleed the border edge-to-edge.
 * - **divided** — hairline `border-t` above, row dividers between each child.
 *   Assumes the parent Card has **no inner padding** (the dividers bleed
 *   naturally to the card edges) and children supply their own horizontal
 *   padding (via `Row` or equivalent). Use for a list inside a Card.
 * - **inset** — recessed tinted background. Reserve for code blocks or
 *   quote-style content. Don't use for generic grouping.
 */
function CardSection({
  children,
  className = '',
  inset = false,
  divided = false,
}: {
  children: ReactNode
  className?: string
  inset?: boolean
  divided?: boolean
}) {
  if (inset) {
    // Negative horizontal margin negates the parent Card's p-5/p-6 so the
    // tinted background bleeds edge-to-edge.
    return (
      <div
        className={`bg-[var(--v2-surface)] -mx-5 md:-mx-6 px-5 md:px-6 border-y border-[var(--v2-border)] ${className}`}
      >
        {children}
      </div>
    )
  }
  if (divided) {
    // Divided mode is for row-list use inside a padding-0 Card. No negative
    // margins — the wrapper sits flush with the card edges, dividers extend
    // full-width, and child rows own their own horizontal padding.
    return (
      <div
        className={`border-t border-[var(--v2-border)] divide-y divide-[var(--v2-table-row-border)] ${className}`}
      >
        {children}
      </div>
    )
  }
  // Default: subsection inside a Card with p-5/p-6 padding. Negative margins
  // bleed the hairline top border to the card's inner edges.
  return (
    <div
      className={`-mx-5 md:-mx-6 px-5 md:px-6 border-t border-[var(--v2-border)] ${className}`}
    >
      {children}
    </div>
  )
}

export const Card = Object.assign(CardRoot, { Section: CardSection })
