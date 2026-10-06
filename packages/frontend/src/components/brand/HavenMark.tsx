'use client'

interface HavenMarkProps {
  /**
   * - `brand`: the brand tile with a white H, on the page's own ground.
   * - `onNavy`: a solid white tile with a navy H, the redesigned site's header over a
   *   navy band (#3586, the mockup's `site.css:53`, kept at
   *   `git show caed1ffb:docs/product/site-mockup/site.css`).
   */
  tone?: 'brand' | 'onNavy'
  className?: string
}

const TILE_CLASS: Record<NonNullable<HavenMarkProps['tone']>, string> = {
  brand: 'fill-[var(--v2-brand)]',
  onNavy: 'fill-white',
}

// The site's fixed navy ground (`SITE_NAVY` in `marketing/site/SiteSection.tsx`),
// restated rather than imported so `components/brand` does not depend on the
// marketing components.
const NAVY_INK = '#0e1230'

export function HavenMark({ tone = 'brand', className = 'h-5 w-5' }: HavenMarkProps) {
  return (
    <svg
      aria-hidden="true"
      focusable={false}
      viewBox="0 0 24 24"
      className={className}
      fill="none"
    >
      <rect
        x="2"
        y="2"
        width="20"
        height="20"
        rx="6"
        className={TILE_CLASS[tone]}
        strokeWidth={0}
      />
      <path
        d="M8 7.5v9M16 7.5v9M8 12h8"
        stroke={tone === 'onNavy' ? NAVY_INK : 'white'}
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}
