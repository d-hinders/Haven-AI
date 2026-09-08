import { BRAND_COLOURS } from '@/lib/brand-colours'
import { installedAppIdentity } from '@/lib/installed-app'

/**
 * The home-screen icon, drawn for Next's `ImageResponse` (#2729).
 *
 * Renders through satori, which understands a flexbox subset and neither CSS
 * custom properties nor `<svg>` `className` — so the colours come in as the
 * test-pinned strings from `lib/brand-colours.ts` and the mark is boxes, not
 * paths. The H is `HavenMark`'s — two uprights and a crossbar, the same
 * proportions — on a full-bleed brand field rather than its rounded inset
 * square: iOS masks the touch icon's corners itself, so a radius drawn here
 * would show as a second, smaller rounding inside Apple's.
 *
 * A non-production environment gets a badge band across the bottom in the
 * warning tone `EnvBadge` uses, carrying the environment's name, so the dev
 * and prod installs are told apart on the home screen at a glance and the
 * presenter never opens the wrong one (owner decision 2026-09-07). Not a
 * `'use client'` module: `ImageResponse` needs the element tree itself, and a
 * client reference would hand it an opaque placeholder.
 */
/**
 * The drawing's measurements, in pixels, for one canvas size. Exported so the
 * pixel test can assert the render against the same numbers the render used.
 *
 * `HavenMark` puts its H at 10 × 11 of a 20-unit inset tile — 50% × 55% —
 * counting the round caps that a `strokeLinecap="round"` path grows by a full
 * stroke width in each axis. This field is full-bleed (24 units, no inset), so
 * the same H is 10 × 11 of 24: the fractions below. The first cut kept the
 * path's 8 × 9 as hard box sizes with no cap overhang on a 24-unit field and
 * came out a third too small — `haven-design-reviewer` measured it at 33% of
 * the tile against `HavenMark`'s 50%.
 *
 * With a badge across the bottom band, a flex-centred child with
 * `marginBottom: m` moves up by `m / 2`, and the centre of the field that
 * remains above the band sits `badgeHeight / 2` above the canvas centre — so
 * the lift is the whole band height, not a fraction of it.
 */
export function appIconGeometry(size: number, badged: boolean) {
  const badgeHeight = Math.round(size * 0.24)
  return {
    stroke: Math.round(size * 0.092),
    crossbarWidth: Math.round(size * 0.42),
    uprightHeight: Math.round(size * 0.47),
    badgeHeight,
    markLift: badged ? badgeHeight : 0,
  }
}

export function AppIconArtwork({ size, environment }: { size: number; environment: string }) {
  const { badge } = installedAppIdentity(environment)
  const { stroke, uprightHeight, crossbarWidth, badgeHeight, markLift } = appIconGeometry(size, badge !== null)

  return (
    <div
      style={{
        width: size,
        height: size,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: BRAND_COLOURS.brand,
        position: 'relative',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: crossbarWidth,
          height: uprightHeight,
          position: 'relative',
          // Lift the mark when a badge takes the bottom band, so it stays
          // centred in what remains — see `appIconGeometry` for the arithmetic.
          marginBottom: markLift,
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: stroke,
            height: uprightHeight,
            borderRadius: stroke / 2,
            background: BRAND_COLOURS.background,
          }}
        />
        <div
          style={{
            position: 'absolute',
            right: 0,
            top: 0,
            width: stroke,
            height: uprightHeight,
            borderRadius: stroke / 2,
            background: BRAND_COLOURS.background,
          }}
        />
        <div
          style={{
            width: crossbarWidth,
            height: stroke,
            borderRadius: stroke / 2,
            background: BRAND_COLOURS.background,
          }}
        />
      </div>
      {badge ? (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: badgeHeight,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: BRAND_COLOURS.warning,
            color: BRAND_COLOURS.background,
            // Bounded by the band's width as well as its height, so a long
            // environment name ("preview-42") shrinks rather than overflows.
            fontSize: Math.round(Math.min(badgeHeight * 0.62, (size * 0.9) / (badge.length * 0.7))),
            fontWeight: 700,
            letterSpacing: Math.round(size * 0.0125),
          }}
        >
          {badge}
        </div>
      ) : null}
    </div>
  )
}
