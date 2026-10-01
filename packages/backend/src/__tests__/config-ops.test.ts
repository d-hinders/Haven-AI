/**
 * Ops console configuration (#3509): the parsers refuse the boot on anything
 * that would silently widen or narrow who can sign in, and "unset" stays the
 * quiet off state.
 */
import { describe, expect, it } from 'vitest'
import {
  isOpsConfigured,
  parseOpsAllowedGithubIds,
  parseOpsConfig,
  parseOpsDatabaseUrl,
  parseOpsRedirectOrigins,
} from '../config/ops.js'

const FULL = {
  OPS_GITHUB_CLIENT_ID: 'cid',
  OPS_GITHUB_CLIENT_SECRET: 'csecret',
  OPS_JWT_SECRET: 'ops-secret-0123456789abcdef0123456789',
  OPS_ALLOWED_GITHUB_IDS: '124281397, 3707311,35528685',
  OPS_REDIRECT_ORIGINS: 'https://haven-ops.vercel.app,http://localhost:3002',
  OPS_PUBLIC_ORIGIN: 'https://api.example.com',
}

describe('parseOpsConfig', () => {
  it('parses a full configuration and reports it configured', () => {
    const cfg = parseOpsConfig(FULL, 'dashboard-secret')
    expect(cfg.allowedGithubIds).toEqual([124281397, 3707311, 35528685])
    expect(cfg.redirectOrigins).toEqual(['https://haven-ops.vercel.app', 'http://localhost:3002'])
    expect(isOpsConfigured(cfg)).toBe(true)
  })

  it('is off, not an error, when nothing is set', () => {
    const cfg = parseOpsConfig({}, 'dashboard-secret')
    expect(isOpsConfigured(cfg)).toBe(false)
  })

  it.each(Object.keys(FULL))('is off — and warns naming it — when %s alone is missing', (key) => {
    const warnings: string[] = []
    const cfg = parseOpsConfig({ ...FULL, [key]: '' }, 'dashboard-secret', (m) => warnings.push(m))
    expect(isOpsConfigured(cfg)).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(`Missing: ${key}.`)
  })

  it('does not warn when ops is fully configured or entirely unset', () => {
    const warnings: string[] = []
    parseOpsConfig(FULL, 'dashboard-secret', (m) => warnings.push(m))
    parseOpsConfig({}, 'dashboard-secret', (m) => warnings.push(m))
    expect(warnings).toEqual([])
  })

  it('refuses to boot on an OPS_JWT_SECRET shorter than 32 characters', () => {
    expect(() => parseOpsConfig({ ...FULL, OPS_JWT_SECRET: 'x'.repeat(31) }, 'dashboard-secret')).toThrow(/shorter than 32/)
    expect(() => parseOpsConfig({ ...FULL, OPS_JWT_SECRET: 'x'.repeat(32) }, 'dashboard-secret')).not.toThrow()
  })

  it('refuses to boot when OPS_JWT_SECRET equals JWT_SECRET', () => {
    expect(() => parseOpsConfig(FULL, FULL.OPS_JWT_SECRET)).toThrow(/OPS_JWT_SECRET is equal to JWT_SECRET/)
  })
})

describe('parseOpsAllowedGithubIds', () => {
  it.each(['founder', '12a', '-5', '0', '1.5', '124281397,,3707311', '99999999999999999999'])(
    'refuses %j — numeric ids only, never logins',
    (raw) => {
      expect(() => parseOpsAllowedGithubIds(raw)).toThrow(/OPS_ALLOWED_GITHUB_IDS/)
    },
  )

  it('de-duplicates', () => {
    expect(parseOpsAllowedGithubIds('7,7, 8')).toEqual([7, 8])
  })
})

describe('parseOpsRedirectOrigins', () => {
  it.each([
    'https://ops.example.com/',
    'https://ops.example.com/path',
    'https://*.vercel.app',
    'http://ops.example.com',
    'ops.example.com',
    'https://ops.example.com?x=1',
  ])('refuses %j — exact origins only', (raw) => {
    expect(() => parseOpsRedirectOrigins(raw)).toThrow(/OPS_REDIRECT_ORIGINS/)
  })

  it('accepts https origins, ports, and plain http on localhost only', () => {
    expect(parseOpsRedirectOrigins('https://a.example:8443,http://127.0.0.1:3002')).toEqual([
      'https://a.example:8443',
      'http://127.0.0.1:3002',
    ])
  })
})

describe('parseOpsDatabaseUrl (#3510)', () => {
  const MAIN = 'postgres://haven:pw@db.internal:5432/haven'

  it('is the quiet off state when unset', () => {
    expect(parseOpsDatabaseUrl(undefined, MAIN)).toBe('')
    expect(parseOpsDatabaseUrl('  ', MAIN)).toBe('')
  })

  it('accepts the read-only role login', () => {
    expect(parseOpsDatabaseUrl('postgres://haven_ops_readonly:pw@db.internal:5432/haven', MAIN)).toBe(
      'postgres://haven_ops_readonly:pw@db.internal:5432/haven',
    )
  })

  it('refuses to boot when it is the main DATABASE_URL — no fallback through the main login', () => {
    expect(() => parseOpsDatabaseUrl(MAIN, MAIN)).toThrow(/OPS_DATABASE_URL is equal to DATABASE_URL/)
    expect(() => parseOpsDatabaseUrl(` ${MAIN} `, MAIN)).toThrow(/OPS_DATABASE_URL is equal to DATABASE_URL/)
  })

  it('refuses the main login through another host, scheme or query string', () => {
    for (const sameUser of [
      'postgresql://haven:pw@db.internal:5432/haven',
      'postgres://haven:pw@public-proxy.example:31337/haven',
      'postgres://haven:pw@db.internal:5432/haven?sslmode=require',
      'postgres://hav%65n:pw@db.internal:5432/haven',
    ]) {
      expect(() => parseOpsDatabaseUrl(sameUser, MAIN)).toThrow(/the same user as DATABASE_URL/)
    }
  })

  it('refuses a URL that names no user, or does not parse', () => {
    expect(() => parseOpsDatabaseUrl('postgres://db.internal:5432/haven', MAIN)).toThrow(/names no login user/)
    expect(() => parseOpsDatabaseUrl('not a url', MAIN)).toThrow(/names no login user/)
  })
})
