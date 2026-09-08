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
export function AppIconArtwork({ size, environment }: { size: number; environment: string }) {
  const { badge } = installedAppIdentity(environment)
  // Everything scales off the canvas so 180, 192 and 512 share one drawing.
  const unit = size / 24
  const stroke = Math.round(unit * 2.2)
  const uprightHeight = Math.round(unit * 9)
  const crossbarWidth = Math.round(unit * 8)
  const badgeHeight = Math.round(size * 0.24)

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
          // optically centred in what remains.
          marginBottom: badge ? Math.round(badgeHeight * 0.55) : 0,
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
            fontSize: Math.round(badgeHeight * 0.62),
            fontWeight: 700,
            letterSpacing: Math.round(unit * 0.3),
          }}
        >
          {badge}
        </div>
      ) : null}
    </div>
  )
}
