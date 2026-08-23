import Link from 'next/link'
import type { ReactNode } from 'react'

/**
 * The call-to-action pair inside a dark brand band (#1867).
 *
 * ── Why this is a primitive rather than three agreeing hand-copies ───────────
 *
 * The White-on-brand treatment was hand-rolled markup that copied `Button`'s
 * base class string, at three call sites: `app/page.tsx`'s two closing CTAs and
 * `investor-briefing/page.tsx`'s "Contact the team". Only the investor-briefing
 * one declared a focus ring; the other two carried **no `focus-visible:`
 * classes at all** and fell back to the UA outline — an indicator, so not a
 * WCAG 2.4.7 failure, but not this system's ring either.
 *
 * The repo's pattern-absorption preflight (#901) says extract on the SECOND
 * occurrence. This is the third, and the divergence is the argument: three
 * copies of a class string is three chances to omit a clause, and #1867 is
 * what that looks like once it has happened twice. Patching the two omissions
 * would have restored agreement without removing the mechanism, and the next
 * band CTA would have been a fourth copy starting from whichever of the three
 * the author happened to read.
 *
 * ── Why `marketing/`, not `ui/` and not a `Button` variant ───────────────────
 *
 * Both alternatives were considered and rejected on what they would drag in,
 * not on taste:
 *
 *  - **A `Button` variant** would need a fourth SIZE as well as a fifth
 *    variant. All three instances are `h-12 px-6 text-[15px]`, which
 *    `SIZE_CLASS` does not have and which no product surface wants; adding it
 *    puts an off-scale band size on the primitive that 128 in-product call
 *    sites reach for. The variant would also be unusable anywhere except on a
 *    brand band, because its ring offset is hardcoded to `--v2-brand` — a
 *    variant whose correctness depends on its parent's background is not a
 *    variant, it is a context.
 *  - **`components/ui/`** is where the shared product primitives live, and
 *    exports there are on the `/design-system` showcase contract (#898). This
 *    control cannot be shown honestly on that page: `/design-system` is a light
 *    product surface, and rendered outside a brand band the ring's whole
 *    premise (`ring-white/80` offset onto `--v2-brand`) is wrong.
 *
 * `components/marketing/` is where the design system already puts exactly this
 * class of component (`Section`, `StepList`, `HeroBackdrop`, `FlowCard`), and
 * those surfaces are deliberately bespoke and design-lint-exempt (#874).
 *
 * ── The focus ring ───────────────────────────────────────────────────────────
 *
 * Declared ONCE, in the base string, for both variants — because unlike
 * `Button`'s, its tone does NOT follow the fill. `Button` co-locates ring
 * colour with fill (#1817) precisely because its variants sit on different
 * backgrounds; here both variants sit on the SAME dark brand band, so the tone
 * follows the band and there is nothing for a per-variant ring to disagree
 * with. Putting it in the base string is what makes "both variants ring the
 * same" structural rather than a coincidence two strings happen to share.
 *
 * The tone is `white` and not `brand` for an arithmetic reason, not a stylistic
 * one: brand indigo reaches ~2.6–3.0:1 on dark surfaces at FULL opacity, so no
 * alpha rescues it. `focus-ring.test.ts` registers `white` against `--v2-brand`
 * in `BACKGROUNDS` and measures it. The offset is `--v2-brand` rather than
 * `--v2-bg` because the band, not the page, is what the ring lands on.
 */
type Variant = 'solid' | 'translucent'

/**
 * Ring GEOMETRY and TONE both live here; see the header for why the tone does
 * not travel with the fill on this control the way it does on `Button`.
 *
 * `h-12 px-6 text-[15px]` is the band size — off `Button`'s `sm`/`md`/`lg`
 * scale, deliberately, and stated in one place now rather than three. At 48px
 * it needs none of `Button`'s tap-target overlay.
 */
const BASE =
  'inline-flex items-center justify-center gap-1.5 rounded-md font-medium tracking-tight transition-colors h-12 px-6 text-[15px] ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--v2-brand)]'

const VARIANT_CLASS: Record<Variant, string> = {
  solid: 'bg-white text-[var(--v2-ink)] hover:bg-white/95 shadow-[0_1px_2px_rgba(16,24,40,0.06)]',
  translucent: 'bg-white/10 hover:bg-white/15 text-white border border-white/20 backdrop-blur',
}

/**
 * The trailing arrow, pixel-identical to the two hand-rolled copies it replaces
 * (`app/page.tsx` inline, `investor-briefing/page.tsx`'s `ArrowIcon`). It is a
 * raw `<svg>` rather than `Icon` + a lucide glyph on purpose: this extraction
 * changes the focus treatment and nothing else about the painted pixels, and
 * swapping the glyph would move every one of them. Marketing surfaces are
 * exempt from the inline-`<svg>` structural lint rule (#874).
 *
 * ── Why it is `aria-hidden` (#1940) ──────────────────────────────────────────
 *
 * Decorative, at every call site: the arrow only ever trails a link whose own
 * text already says where it goes ("Get early access", "Contact the team"). It
 * is never the sole indication of what the control does, and it never
 * distinguishes two otherwise identically-labelled controls — the three
 * "Contact the team" links on `/investor-briefing` all carry the SAME arrow, so
 * it separates nothing. A screen reader announcing a glyph after the label
 * would add noise, not information.
 *
 * This is not a live WCAG failure being fixed. An `<svg>` with no `<title>` and
 * no `role` contributes nothing to the accessible name today, so the name is
 * already correct — the attribute makes that *structural* instead of incidental
 * on the markup staying exactly as it is. `BrandBandButton.test.tsx` proves the
 * difference by adding a `<title>` to the rendered arrow and re-computing the
 * link's accessible name: with `aria-hidden` the name is the label alone,
 * without it the glyph's text lands in the announcement.
 *
 * `aria-hidden` + `focusable={false}` is the pair `components/ui/Icon.tsx`
 * applies to every decorative glyph in the product app; this is the same
 * decision spelled by hand because the marketing arrow is not a lucide glyph.
 */
function TrailingArrow() {
  return (
    <svg
      className="w-3.5 h-3.5"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      aria-hidden="true"
      focusable={false}
    >
      <path d="M3.5 8h9M9 4.5L12.5 8 9 11.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

type BrandBandButtonProps = {
  children: ReactNode
  href: string
  variant?: Variant
  trailingArrow?: boolean
  className?: string
}

export function BrandBandButton({
  children,
  href,
  variant = 'solid',
  trailingArrow,
  className = '',
}: BrandBandButtonProps) {
  const classes = `${BASE} ${VARIANT_CLASS[variant]} ${className}`
  const content = (
    <>
      {children}
      {trailingArrow && <TrailingArrow />}
    </>
  )

  // An external/mailto target cannot go through `next/link`'s router, and
  // `investor-briefing`'s "Contact the team" is exactly that — so the element
  // follows the href rather than being fixed, and both spellings carry the
  // identical class string.
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) {
    return (
      <a href={href} className={classes}>
        {content}
      </a>
    )
  }

  return (
    <Link href={href} className={classes}>
      {content}
    </Link>
  )
}
