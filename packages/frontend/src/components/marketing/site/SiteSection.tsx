import type { CSSProperties, ReactNode } from 'react'
import { SITE_FONT_VARIABLES } from './fonts'

/**
 * The public site's section grounds and type roles (#3573, epic #3572).
 *
 * The mockup paints four grounds (`docs/product/site-mockup/site.css`):
 *
 * - `white` and `tint` resolve through theme tokens (`--v2-bg`,
 *   `--v2-surface`, `--v2-border`), so they take their dark forms with the
 *   rest of the palette (epic decision 7).
 * - `navy` and `indigo` are FIXED in both themes and carry fixed ink — the
 *   #1867 band doctrine: a theme token on a fixed band flips with the theme
 *   and vanishes on one of them. Both are `data-v2-dark-section`, which is
 *   what the header's probe reads to switch to its on-dark treatment.
 *
 * A section declares its ink as three local properties (`--site-ink`,
 * `--site-ink-2`, `--site-eyebrow`) and the type roles below read them, so a
 * heading is legible on whichever ground it lands on without a per-ground
 * class at the call site. They are local custom properties, not theme
 * tokens: on a themed ground they point AT theme tokens, on a fixed ground
 * they are fixed. Outside any section the roles fall back to the theme ink.
 */
export type SiteGround = 'white' | 'tint' | 'navy' | 'indigo'

/** The mockup's `--navy`. Fixed in both themes. */
export const SITE_NAVY = '#0e1230'

const GROUND_CLASS: Record<SiteGround, string> = {
  white:
    'bg-[var(--v2-bg)] [--site-ink:var(--v2-ink)] [--site-ink-2:var(--v2-ink-2)] [--site-eyebrow:var(--v2-brand)]',
  tint:
    'bg-[var(--v2-surface)] border-y border-[var(--v2-border)] [--site-ink:var(--v2-ink)] [--site-ink-2:var(--v2-ink-2)] [--site-eyebrow:var(--v2-brand)]',
  navy: 'bg-[#0e1230] [--site-ink:#ffffff] [--site-ink-2:rgba(255,255,255,0.72)] [--site-eyebrow:#a5b4fc]',
  indigo: '[--site-ink:#ffffff] [--site-ink-2:rgba(255,255,255,0.82)] [--site-eyebrow:#e0e7ff]',
}

// The closing band's gradient (mockup `.close`). Inline because a Tailwind
// arbitrary background cannot carry a multi-stop gradient legibly.
const GROUND_STYLE: Partial<Record<SiteGround, CSSProperties>> = {
  indigo: {
    background:
      'radial-gradient(70% 90% at 50% 0%, rgba(139, 92, 246, 0.5) 0%, transparent 60%), linear-gradient(180deg, #4f46e5 0%, #4338ca 100%)',
  },
}

/** True for the grounds that stay dark in both themes. */
export function isFixedDarkGround(ground: SiteGround): boolean {
  return ground === 'navy' || ground === 'indigo'
}

/** The content column every new-site band uses: the mockup's `.wrap`. */
export const SITE_WRAP = 'mx-auto w-full max-w-[1120px] px-6'

/**
 * Type roles (mockup `h1`/`h2`/`h3`/`.eyebrow`/`.lede`/`.mono`). Display roles
 * set Inter Tight; `mono` sets JetBrains Mono. Both faces exist only below a
 * new-site root (see `fonts.ts`), so these classes are inert anywhere else.
 */
export const SITE_TYPE = {
  h1: '[font-family:var(--font-site-display)] text-[length:clamp(40px,6vw,64px)] font-semibold tracking-[-0.035em] leading-[1.02] [text-wrap:balance] text-[color:var(--site-ink,var(--v2-ink))]',
  h2: '[font-family:var(--font-site-display)] text-[length:clamp(28px,3.6vw,40px)] font-semibold tracking-[-0.025em] leading-[1.1] [text-wrap:balance] text-[color:var(--site-ink,var(--v2-ink))]',
  h3: '[font-family:var(--font-site-display)] text-[17px] font-semibold tracking-[-0.01em] leading-[1.3] text-[color:var(--site-ink,var(--v2-ink))]',
  eyebrow:
    'mb-3.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-[color:var(--site-eyebrow,var(--v2-brand))]',
  lede: 'max-w-[56ch] text-[18px] leading-[1.6] text-[color:var(--site-ink-2,var(--v2-ink-2))]',
  mono: '[font-family:var(--font-site-mono)] tabular-nums',
} as const

export function SiteSection({
  ground = 'white',
  id,
  className = '',
  children,
  'aria-labelledby': labelledBy,
}: {
  ground?: SiteGround
  id?: string
  className?: string
  children: ReactNode
  'aria-labelledby'?: string
}) {
  return (
    <section
      id={id}
      aria-labelledby={labelledBy}
      data-site-ground={ground}
      data-v2-dark-section={isFixedDarkGround(ground) ? '' : undefined}
      className={`${SITE_FONT_VARIABLES} ${GROUND_CLASS[ground]} py-16 md:py-24 ${className}`}
      style={GROUND_STYLE[ground]}
    >
      <div className={SITE_WRAP}>{children}</div>
    </section>
  )
}
