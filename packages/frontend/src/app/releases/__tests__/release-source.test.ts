import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PUBLISHED_CLIENT_PACKAGES } from '@haven_ai/core'
import { buildManifestFrom } from '@/lib/capability-manifest'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs at the repository root; the release generator itself.
import { clientReleasesFrom } from '../../../../../../scripts/release-client-data.mjs'
import { RELEASES_FIXTURE_ENV, releasesFixtureFrom, withFixtureReleases } from '../release-source'

/**
 * #3393: `/releases` renders fixture release data in the visual spec. These
 * pin the fixture to what the product can produce, and the seam to reading
 * only the variable it names.
 */
const FIXTURE_PATH = path.resolve(__dirname, '../../../../e2e/fixtures/releases-fixture.json')
const fixtureFile = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))

describe('releases fixture (#3393)', () => {
  it('is exactly what the release generator produces from its fixture CHANGELOGs', () => {
    expect(fixtureFile.releases).toEqual(clientReleasesFrom(fixtureFile.changelogs))
  })

  it('reaches the states the live data does not: an update-required note and a set minimum', () => {
    const notes = PUBLISHED_CLIENT_PACKAGES.flatMap((pkg) => fixtureFile.releases[pkg].notes)
    expect(notes.some((n: { action_required: boolean }) => n.action_required)).toBe(true)
    expect(PUBLISHED_CLIENT_PACKAGES.some((pkg) => fixtureFile.compat[pkg].min_version !== null)).toBe(true)
  })
})

describe('releasesFixtureFrom', () => {
  it('is null when the variable is unset, so a deployment renders live data', () => {
    expect(releasesFixtureFrom({})).toBeNull()
  })

  it('reads the file the variable names', () => {
    const fixture = releasesFixtureFrom({ [RELEASES_FIXTURE_ENV]: FIXTURE_PATH })
    expect(fixture?.releases['@haven_ai/signer'].released_version).toBe('9.4.0-alpha.0')
  })

  it('refuses a file that is missing a package, rather than rendering a partial page', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'releases-fixture-'))
    const partial = path.join(dir, 'partial.json')
    const { ['@haven_ai/cli']: _dropped, ...releases } = fixtureFile.releases
    writeFileSync(partial, JSON.stringify({ releases, compat: fixtureFile.compat }))
    expect(() => releasesFixtureFrom({ [RELEASES_FIXTURE_ENV]: partial })).toThrow(/@haven_ai\/cli/)
  })
})

describe('withFixtureReleases', () => {
  it('replaces every release field with the fixture, keeping the manifest name', () => {
    const live = buildManifestFrom('', null).packages
    const fixture = releasesFixtureFrom({ [RELEASES_FIXTURE_ENV]: FIXTURE_PATH })!
    const out = withFixtureReleases(live, fixture)
    expect(Object.keys(out).sort()).toEqual(Object.keys(live).sort())
    for (const entry of Object.values(out)) {
      expect(entry.released_version).toBe('9.4.0-alpha.0')
      expect(entry.upgrade_command).toBeNull()
    }
    expect(out.signer.name).toBe('@haven_ai/signer')
    expect(out.signer.min_version).toBe('9.3.0-alpha.0')
    expect(out.signer.notes[0].action_required).toBe(true)
  })

  it('does not touch the manifest it was given (the machine-readable documents stay live)', () => {
    const live = buildManifestFrom('', null).packages
    const before = JSON.stringify(live)
    withFixtureReleases(live, releasesFixtureFrom({ [RELEASES_FIXTURE_ENV]: FIXTURE_PATH })!)
    expect(JSON.stringify(live)).toBe(before)
  })
})
