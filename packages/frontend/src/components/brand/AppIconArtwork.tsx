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
 * `--v2-warning` tone, carrying the environment's name, so the dev and prod
 * installs are told apart on the home screen at a glance and the presenter
 * never opens the wrong one (owner decision 2026-09-07). The band is the
 * INVERSE of `EnvBadge`'s pairing on purpose — solid warning fill with white
 * ink, where the chip is soft fill with warning ink: white on `#b54708` is
 * 5.4 : 1 and still reads at 40 px, and a soft fill would not carry the word
 * at home-screen size (`haven-design-reviewer`, #2729, measured and declined
 * as a nit). Not a `'use client'` module: `ImageResponse` needs the element
 * tree itself, and a client reference would hand it an opaque placeholder.
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
 * Two deliberate departures from that arithmetic, so nobody "corrects" them:
 * the height is `0.47` rather than the exact `11 / 24 = 0.458` — the design
 * pass's own target, a hair taller, measured at 0.469–0.472 across the three
 * sizes — and the stroke is `0.092` of the canvas against `HavenMark`'s
 * `2 / 24 = 0.083`, thickened ~10% because a hairline vanishes at 40 px.
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
  // Height-bound normally; width-bound for a long environment name
  // ("pull-request-preview"): ~0.7 em per glyph plus 0.08 em of tracking,
  // which at twenty characters is a tenth of the line, held inside 90% of
  // the width. Pixel-identical to a plain height bound for "DEV" at all
  // three sizes; the pixel test renders the long case.
  const badgeFontSize = badge
    ? Math.round(Math.min(badgeHeight * 0.62, (size * 0.9) / (badge.length * 0.78)))
    : 0

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
            background: BRAND_COLOURS.onBrand,
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
            background: BRAND_COLOURS.onBrand,
          }}
        />
        <div
          style={{
            width: crossbarWidth,
            height: stroke,
            borderRadius: stroke / 2,
            background: BRAND_COLOURS.onBrand,
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
            color: BRAND_COLOURS.onBrand,
            fontSize: badgeFontSize,
            fontWeight: 700,
            letterSpacing: Math.round(badgeFontSize * 0.08),
          }}
        >
          {badge}
        </div>
      ) : null}
    </div>
  )
}
