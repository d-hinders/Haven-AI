import { describe, expect, it } from 'vitest'
import {
  CLIENT_COMPAT,
  PUBLISHED_CLIENT_PACKAGES,
  compareVersions,
  evaluateClient,
  formatClientHeader,
  parseClientHeader,
  type ClientCompatEntry,
  type PublishedClientPackage,
} from './client-compat.js'

function table(
  overrides: Partial<Record<PublishedClientPackage, Partial<ClientCompatEntry>>> = {},
): Record<PublishedClientPackage, ClientCompatEntry> {
  const out = {} as Record<PublishedClientPackage, ClientCompatEntry>
  for (const pkg of PUBLISHED_CLIENT_PACKAGES) {
    out[pkg] = { recommended_version: null, min_version: null, ...overrides[pkg] }
  }
  return out
}

describe('parseClientHeader', () => {
  it('splits a scoped package from its version at the LAST slash', () => {
    expect(parseClientHeader('@haven_ai/mcp/0.4.0-alpha.0')).toEqual({
      package: '@haven_ai/mcp',
      version: '0.4.0-alpha.0',
    })
    expect(parseClientHeader(formatClientHeader('@haven_ai/signer', '1.2.3'))).toEqual({
      package: '@haven_ai/signer',
      version: '1.2.3',
    })
  })

  it('reads the first value of a repeated header', () => {
    expect(parseClientHeader(['@haven_ai/cli/1.0.0', '@haven_ai/sdk/0.1.0'])?.package).toBe('@haven_ai/cli')
  })

  it.each([
    [undefined],
    [''],
    ['   '],
    ['@haven_ai/mcp'],
    ['@haven_ai/mcp/'],
    ['/1.0.0'],
    ['@haven_ai/mcp/latest'],
    ['@haven_ai/mcp/1.0'],
    ['@haven_ai/mcp/v1.0.0'],
    ['@haven_ai/mcp/01.0.0'],
    [`@haven_ai/mcp/${'1'.repeat(300)}.0.0`],
  ])('returns null for %j — an unparseable header is no header', (raw) => {
    expect(parseClientHeader(raw as string | undefined)).toBeNull()
  })
})

describe('compareVersions (semver 2.0 precedence)', () => {
  it('orders the documented chain, prereleases below their release', () => {
    const chain = [
      '0.0.0-dev.20260925',
      '0.4.0-alpha.0',
      '0.4.0-alpha.1',
      '0.4.0-alpha.10',
      '0.4.0-beta',
      '0.4.0',
      '0.4.1',
      '0.10.0',
      '1.0.0',
    ]
    for (let i = 0; i < chain.length - 1; i++) {
      expect(compareVersions(chain[i], chain[i + 1])).toBeLessThan(0)
      expect(compareVersions(chain[i + 1], chain[i])).toBeGreaterThan(0)
    }
  })

  it('treats equal versions (build metadata ignored) as equal', () => {
    expect(compareVersions('1.2.3-alpha.0', '1.2.3-alpha.0')).toBe(0)
    expect(compareVersions('1.2.3+build.5', '1.2.3')).toBe(0)
  })

  it('throws on a malformed version rather than guessing', () => {
    expect(() => compareVersions('1.2', '1.2.0')).toThrow(/not a semver/)
  })
})

describe('evaluateClient', () => {
  it('is unidentified with no header or an unparseable one, whatever the table says', () => {
    const strict = table({ '@haven_ai/mcp': { min_version: '9.9.9', recommended_version: '9.9.9' } })
    expect(evaluateClient(undefined, strict)).toEqual({ kind: 'unidentified' })
    expect(evaluateClient('@haven_ai/mcp/not-a-version', strict)).toEqual({ kind: 'unidentified' })
  })

  it('exempts a package outside the published five (the hosted mcp-server)', () => {
    const strict = table({ '@haven_ai/mcp': { min_version: '9.9.9' } })
    expect(evaluateClient('@haven_ai/mcp-server/0.1.0', strict)).toMatchObject({
      kind: 'exempt',
      reason: 'unlisted_package',
    })
  })

  it('exempts a dev-channel snapshot even far below a set minimum', () => {
    const strict = table({ '@haven_ai/signer': { min_version: '0.4.0-alpha.0' } })
    expect(evaluateClient('@haven_ai/signer/0.0.0-dev.20260925123456', strict)).toMatchObject({
      kind: 'exempt',
      reason: 'snapshot',
    })
  })

  it('is current with both thresholds unset — the shipped default', () => {
    expect(evaluateClient('@haven_ai/sdk/0.0.1', table())).toEqual({
      kind: 'current',
      package: '@haven_ai/sdk',
      version: '0.0.1',
    })
  })

  it('is behind (hint only) below recommended with min unset', () => {
    const t = table({ '@haven_ai/mcp': { recommended_version: '0.5.0' } })
    expect(evaluateClient('@haven_ai/mcp/0.4.0-alpha.0', t)).toEqual({
      kind: 'behind',
      package: '@haven_ai/mcp',
      version: '0.4.0-alpha.0',
      recommended_version: '0.5.0',
      min_version: null,
    })
  })

  it('is below_min only below a SET minimum, and current at exactly the minimum', () => {
    const t = table({ '@haven_ai/cli': { recommended_version: '0.6.0', min_version: '0.5.0' } })
    expect(evaluateClient('@haven_ai/cli/0.5.0-alpha.3', t).kind).toBe('below_min')
    expect(evaluateClient('@haven_ai/cli/0.5.0', t).kind).toBe('behind')
    expect(evaluateClient('@haven_ai/cli/0.6.0', t).kind).toBe('current')
  })

  it('reads one package\'s thresholds, never another\'s', () => {
    const t = table({ '@haven_ai/signer': { min_version: '9.0.0' } })
    expect(evaluateClient('@haven_ai/mcp/0.1.0', t).kind).toBe('current')
    expect(evaluateClient('@haven_ai/signer/0.1.0', t).kind).toBe('below_min')
  })
})

describe('CLIENT_COMPAT (the shipped table)', () => {
  it('governs exactly the five published packages', () => {
    expect(Object.keys(CLIENT_COMPAT).sort()).toEqual([...PUBLISHED_CLIENT_PACKAGES].sort())
  })

  it('holds only valid versions or null, so evaluateClient can never throw on it', () => {
    for (const entry of Object.values(CLIENT_COMPAT)) {
      for (const v of [entry.recommended_version, entry.min_version]) {
        if (v !== null) expect(() => compareVersions(v, v)).not.toThrow()
      }
      if (entry.min_version !== null && entry.recommended_version !== null) {
        expect(compareVersions(entry.min_version, entry.recommended_version)).toBeLessThanOrEqual(0)
      }
    }
  })
})
