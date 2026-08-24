/**
 * The decorative trailing arrow every marketing CTA wears (#1954).
 *
 * ── Why this is one component now, when #1867 deliberately left it copied ────
 * #1867 absorbed three hand-copies into `BrandBandButton` and kept the glyph
 * byte-identical rather than route it through `Icon` + a lucide arrow, because
 * unifying it would have moved rendered pixels. #1940 then added
 * `aria-hidden`/`focusable` to the two named definitions that existed
 * (`BrandBandButton`'s `TrailingArrow`, `investor-briefing`'s `ArrowIcon`) and
 * #1954 found three MORE raw copies inline in `app/page.tsx` that its inventory
 * had missed — which is precisely the failure mode a copied glyph has: the fix
 * lands on the copies someone happened to enumerate.
 *
 * #1954 asks for this to be decided rather than defaulted, and records the case
 * against as "they live on different backgrounds and at different sizes". That
 * turns out to be **false**, and it was checked rather than assumed. All six
 * instances — two in `BrandBandButton`, three in `investor-briefing`'s
 * `InvestorButton`, three inline in `app/page.tsx` — render the identical
 * markup: `w-3.5 h-3.5`, `viewBox="0 0 16 16"`, `strokeWidth={1.75}`, and the
 * byte-identical path `M3.5 8h9M9 4.5L12.5 8 9 11.5`. Background is irrelevant
 * because the stroke is `currentColor`, which is why the same glyph already
 * sits on a dark brand band and on a white card without a variant. There is no
 * size difference to preserve.
 *
 * So the extraction costs **zero rendered pixels** — the emitted SVG is the
 * same string it was — and buys the thing the last two issues were both about:
 * `aria-hidden` becomes structural. A seventh call site cannot forget it,
 * because there is nowhere left to forget it.
 *
 * The one real variation across the six is `app/page.tsx`'s hover nudge
 * (`group-hover:translate-x-0.5`), which is a call-site concern and arrives as
 * `className` rather than as a variant here.
 *
 * ── Why `aria-hidden` at all ────────────────────────────────────────────────
 * Not a live WCAG failure, and #1940 was careful not to claim it was: an `<svg>`
 * with no `<title>` and no `role` contributes nothing to a name computation, so
 * every one of these links was already announced correctly. The attribute makes
 * that STRUCTURAL instead of contingent on the markup never gaining nameable
 * content — which is exactly the risk the tests reproduce, by injecting a
 * `<title>` and re-computing the accessible name. See
 * `__tests__/TrailingArrow.test.tsx`.
 *
 * Every call site is a control that carries its own text and renders this glyph
 * AFTER that text. There is no icon-only control in the marketing surface, so
 * hiding the glyph removes no meaning anywhere — verified per instance, not
 * inferred from the pattern.
 */
export function TrailingArrow({ className = '' }: { className?: string }) {
  return (
    <svg
      className={`w-3.5 h-3.5 ${className}`.trimEnd()}
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
