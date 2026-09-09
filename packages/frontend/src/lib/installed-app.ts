import type { Metadata, MetadataRoute, Viewport } from 'next'
import { BRAND_COLOURS } from './brand-colours'
import { PRODUCTION_ENVIRONMENT } from './env'

/**
 * The installed-app shell (#2729, epic #2736): everything a phone needs to put
 * Haven on its home screen as a standalone app, built from ONE environment
 * reading so prod and dev install side by side as two distinct apps.
 *
 * Pure functions of the environment name — `manifest.ts`, the root layout and
 * the generated icon routes all call these with `havenEnvironment()`, and the
 * unit test calls them with literal names. Nothing here touches `process.env`.
 *
 * ── Why the environment is in the manifest at all ────────────────────────────
 * iOS keys a home-screen app on its origin plus the manifest `id`/`scope`, and
 * labels it from `apple-mobile-web-app-title`. Two installs whose only
 * difference is the origin get the same name and the same icon, and on a demo
 * phone that is exactly the wrong state to be in when the room is watching:
 * the presenter cannot tell which one they opened. So the name, the id and
 * the icon all carry the environment (owner decision 2026-09-07). The dev
 * install must also target the STABLE branch alias, never a per-deploy preview
 * URL — a different origin is a different app — but that is a runbook fact
 * (#2735), not something the manifest can express.
 *
 * ── Deliberately no service worker ───────────────────────────────────────────
 * iOS and Chrome both install without one, and an app-cache worker is the one
 * way to show a stale build mid-demo. `installed-app-shell.test.ts` asserts
 * nothing in the app registers one.
 */

export const INSTALLED_APP_START_URL = '/dashboard'
export const INSTALLED_APP_SCOPE = '/'

/** The brand name as it appears in the manifest and the iOS title. */
const PRODUCT_NAME = 'Haven'

/**
 * Icon routes the manifest and the `<link>` tags point at. Each is a Next
 * generated-image route (`src/app/<file>.tsx`) that imports its `size` from
 * here, so the manifest cannot advertise a size the route does not render.
 * PNG rather than SVG throughout: iOS ignores SVG touch icons.
 */
export const APP_ICONS = {
  /** `src/app/icon1.tsx` — also the browser favicon. */
  small: { path: '/icon1', size: 192 },
  /** `src/app/icon2.tsx` — the Chrome / Android install-prompt floor is 512. */
  large: { path: '/icon2', size: 512 },
  /** `src/app/apple-icon.tsx` — `apple-touch-icon`, the only icon iOS reads. */
  apple: { path: '/apple-icon', size: 180 },
} as const

export interface InstalledAppIdentity {
  /** Manifest `id`: stable per environment, distinct between environments. */
  id: string
  /** Manifest `name`, `short_name` and the iOS home-screen label. */
  name: string
  /** Text painted on the icon badge for a non-production install, else null. */
  badge: string | null
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/**
 * `production` → "Haven"; any other environment name → "Haven Dev" (etc.),
 * with a matching id and an icon badge. The suffix is derived from the name
 * `lib/env.ts` already normalised, so a third deployment gets its own app
 * without a code change here.
 */
export function installedAppIdentity(environment: string): InstalledAppIdentity {
  if (environment === PRODUCTION_ENVIRONMENT) {
    return { id: 'haven', name: PRODUCT_NAME, badge: null }
  }
  return {
    id: `haven-${environment}`,
    name: `${PRODUCT_NAME} ${titleCase(environment)}`,
    badge: environment.toUpperCase(),
  }
}

/** The body of `/manifest.webmanifest` for one environment. */
export function buildWebManifest(environment: string): MetadataRoute.Manifest {
  const identity = installedAppIdentity(environment)
  return {
    id: identity.id,
    name: identity.name,
    short_name: identity.name,
    description: 'Agent payments within your rules.',
    start_url: INSTALLED_APP_START_URL,
    scope: INSTALLED_APP_SCOPE,
    display: 'standalone',
    background_color: BRAND_COLOURS.background,
    theme_color: BRAND_COLOURS.brand,
    // `any`, never `maskable`: a maskable icon is cropped to the launcher's
    // shape, and the dev badge lives in the bottom 24% — the part a circular
    // mask eats first. Letterboxing on Android is the cheaper failure.
    icons: [APP_ICONS.small, APP_ICONS.large].map((icon) => ({
      src: icon.path,
      sizes: `${icon.size}x${icon.size}`,
      type: 'image/png',
      purpose: 'any',
    })),
  }
}

/**
 * The root layout's share of the shell: the iOS meta tags. The manifest link
 * and the icon links are emitted by Next from the file conventions
 * (`manifest.ts`, `icon1.tsx`, `apple-icon.tsx`), not from here.
 */
export function installedAppMetadata(
  environment: string,
): Pick<Metadata, 'applicationName' | 'appleWebApp' | 'other'> {
  const identity = installedAppIdentity(environment)
  return {
    applicationName: identity.name,
    appleWebApp: {
      capable: true,
      title: identity.name,
      // `default` keeps the status bar opaque and readable over the app's own
      // top bar. `viewport-fit: cover` (#2730) belongs to the viewport export
      // below, not to this metadata block.
      statusBarStyle: 'default',
    },
    // Next 15 renders `capable` as the standard `mobile-web-app-capable` only.
    // iOS goes standalone from the manifest's `display` regardless, but the
    // Apple-prefixed tag is still the documented one, costs nothing, and is
    // what an older iOS reads — so it is emitted alongside, not instead.
    other: { 'apple-mobile-web-app-capable': 'yes' },
  }
}

/**
 * The root layout's `viewport` export. `width` and `initialScale` restate
 * exactly what Next injects by default — the product already lays out at
 * device width on a phone, verified on the deployed dev app — so this moves
 * no baseline; it exists to carry `themeColor` without a hand-written tag.
 *
 * `viewportFit: 'cover'` (#2730) is the half that is NOT inert: it extends the
 * page under the notch and the home indicator, which is what makes the status
 * bar read as part of the app rather than as a letterbox above it — and it is
 * also what makes `env(safe-area-inset-*)` report anything but 0. The two ship
 * together on purpose. Every rule that consumes those insets goes through
 * `--v2-safe-*` in `globals.css`; `cover` without them would put controls under
 * the notch, which is the defect #2730 exists to prevent rather than cause.
 *
 * Inert in every gate this repository runs — headless Chromium has no notch,
 * so all four insets resolve to 0 and every rule computes what it computed
 * before. NOT inert in a normal Safari tab on a notched phone: with `cover`,
 * Safari reports a real bottom inset in portrait and real left/right insets in
 * landscape, and the rules apply there too. That is correct and wanted; the
 * point is only that no gate in this repository can see it.
 */
export const INSTALLED_APP_VIEWPORT: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: BRAND_COLOURS.brand,
}
