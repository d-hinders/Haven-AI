import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CLIENT_COMPAT, PUBLISHED_CLIENT_PACKAGES, compareVersions } from './client-compat.js'
import { CLIENT_RELEASES, buildReleaseCompat, upgradeCommandFor } from './client-releases.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageVersion = (pkg: string): string => {
  const dir = pkg.replace('@haven_ai/', '')
  return JSON.parse(readFileSync(path.join(here, '..', '..', dir, 'package.json'), 'utf8')).version
}

describe('CLIENT_RELEASES (#3304)', () => {
  it('covers exactly the five published packages', () => {
    expect(Object.keys(CLIENT_RELEASES).sort()).toEqual([...PUBLISHED_CLIENT_PACKAGES].sort())
  })

  it('names released_version as its newest note, notes newest first with ISO dates', () => {
    for (const pkg of PUBLISHED_CLIENT_PACKAGES) {
      const { released_version, notes } = CLIENT_RELEASES[pkg]
      expect(notes.length, pkg).toBeGreaterThan(0)
      expect(notes[0].version, pkg).toBe(released_version)
      for (let i = 1; i < notes.length; i++) {
        expect(compareVersions(notes[i - 1].version, notes[i].version), pkg).toBeGreaterThan(0)
      }
      for (const n of notes) expect(n.date, pkg).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  // Never AHEAD of the package: a document announcing a version the source has
  // not released would send agents after something that does not exist. Equal
  // is what the bump writes (#3305); behind is tolerated so a package.json
  // edited outside the bump does not break this unrelated test.
  it('never announces a version above the package.json version', () => {
    for (const pkg of PUBLISHED_CLIENT_PACKAGES) {
      expect(compareVersions(CLIENT_RELEASES[pkg].released_version, packageVersion(pkg)), pkg).toBeLessThanOrEqual(0)
    }
  })
})

describe('upgradeCommandFor', () => {
  it('prints the connector for the signer, MCP and connector, and each package for itself otherwise', () => {
    expect(upgradeCommandFor('@haven_ai/sdk', 'alpha')).toBe('npm install @haven_ai/sdk@alpha')
    expect(upgradeCommandFor('@haven_ai/cli', 'dev')).toBe('npx -y @haven_ai/cli@dev')
    for (const pkg of ['@haven_ai/signer', '@haven_ai/mcp', '@haven_ai/connect'] as const) {
      expect(upgradeCommandFor(pkg, 'alpha')).toBe('npx -y @haven_ai/connect@alpha')
    }
  })
})

describe('buildReleaseCompat', () => {
  const saved = structuredClone(CLIENT_COMPAT)
  afterEach(() => {
    for (const pkg of PUBLISHED_CLIENT_PACKAGES) Object.assign(CLIENT_COMPAT[pkg], saved[pkg])
  })

  it('joins the release data with the enforced thresholds, and the command with the channel', () => {
    const out = buildReleaseCompat('alpha')
    for (const pkg of PUBLISHED_CLIENT_PACKAGES) {
      expect(out[pkg]).toEqual({
        released_version: CLIENT_RELEASES[pkg].released_version,
        recommended_version: CLIENT_COMPAT[pkg].recommended_version,
        min_version: CLIENT_COMPAT[pkg].min_version,
        upgrade_command: upgradeCommandFor(pkg, 'alpha'),
        notes: CLIENT_RELEASES[pkg].notes,
      })
    }
  })

  it('leaves the command null when the channel is unknown, and invents none', () => {
    for (const entry of Object.values(buildReleaseCompat(null))) expect(entry.upgrade_command).toBeNull()
  })

  // The source table itself is mutated — not a copy passed in — so this fails
  // if the builder ever captures CLIENT_COMPAT at import time instead of reading
  // the table the backend enforces.
  it('follows a min_version change in CLIENT_COMPAT itself', () => {
    ;(CLIENT_COMPAT['@haven_ai/signer'] as { min_version: string | null }).min_version = '0.5.0-alpha.1'
    ;(CLIENT_COMPAT['@haven_ai/sdk'] as { recommended_version: string | null }).recommended_version = '0.5.0-alpha.0'
    const out = buildReleaseCompat('alpha')
    expect(out['@haven_ai/signer'].min_version).toBe('0.5.0-alpha.1')
    expect(out['@haven_ai/sdk'].recommended_version).toBe('0.5.0-alpha.0')
  })
})
