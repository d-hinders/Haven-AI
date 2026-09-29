import { readFileSync } from 'node:fs'
import {
  PUBLISHED_CLIENT_PACKAGES,
  buildReleaseCompat,
  type ClientCompatEntry,
  type ClientRelease,
  type PublishedClientPackage,
} from '@haven_ai/core'
import type { ManifestPackageEntry } from '@/lib/capability-manifest'

/**
 * Fixture release data for `/releases`, for the visual spec only (#3393).
 *
 * The page renders the live release data, which every release bump rewrites,
 * so a baseline taken from it went stale on every release (#3382 → #3383).
 * When this SERVER-ONLY variable names a file, the page renders that file's
 * release data instead. Only this page reads it: `buildManifest` and
 * `/.well-known/haven.json` never do, so no fixture can reach a
 * machine-readable document. A process environment variable, not a request
 * input and not `NEXT_PUBLIC_*` (which the build would inline), so nothing a
 * visitor sends can switch it. `playwright.config.ts` sets it for every e2e
 * run; the spec asserts a fixture-only value is on screen, so a server started
 * without it fails loudly instead of capturing live data.
 */
export const RELEASES_FIXTURE_ENV = 'HAVEN_RELEASES_FIXTURE'

export interface ReleasesFixture {
  releases: Record<PublishedClientPackage, ClientRelease>
  compat: Record<PublishedClientPackage, ClientCompatEntry>
}

/** The fixture the variable names, or null when it is unset. Throws on a set but unusable file. */
export function releasesFixtureFrom(env: Readonly<Record<string, string | undefined>> = process.env): ReleasesFixture | null {
  const path = env[RELEASES_FIXTURE_ENV]
  if (!path) return null
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ReleasesFixture>
  for (const pkg of PUBLISHED_CLIENT_PACKAGES) {
    if (!parsed.releases?.[pkg] || !parsed.compat?.[pkg]) {
      throw new Error(`${RELEASES_FIXTURE_ENV} (${path}) has no release or compat entry for ${pkg}`)
    }
  }
  return parsed as ReleasesFixture
}

/**
 * The manifest's package entries with their release fields taken from the
 * fixture. Names, channels and one-liners stay the manifest's; the update
 * command is null, as it is when the backend's channel is unknown.
 */
export function withFixtureReleases(
  packages: Record<string, ManifestPackageEntry>,
  fixture: ReleasesFixture,
): Record<string, ManifestPackageEntry> {
  const releases = buildReleaseCompat(null, fixture)
  const out: Record<string, ManifestPackageEntry> = {}
  for (const [key, entry] of Object.entries(packages)) {
    const fromFixture = releases[entry.name as PublishedClientPackage]
    out[key] = fromFixture ? { ...entry, ...fromFixture } : entry
  }
  return out
}
