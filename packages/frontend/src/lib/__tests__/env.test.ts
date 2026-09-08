import { describe, it, expect } from 'vitest'

import { havenEnvironment, isProductionEnvironment, PRODUCTION_ENVIRONMENT } from '@/lib/env'

/**
 * The one reading of `NEXT_PUBLIC_HAVEN_ENV` (#2709).
 *
 * The convention under test is "unset means production": the dev Vercel
 * project sets `dev`, production sets nothing. The manifest used to read the
 * raw variable and answer `unknown` on production — the failure this file pins
 * shut. Every case passes the raw value explicitly so the assertions do not
 * depend on how vitest stubs `process.env`.
 */
describe('havenEnvironment (#2709)', () => {
  it.each([undefined, '', '   '])('treats an unset or blank variable as production (%j)', (raw) => {
    expect(havenEnvironment(raw)).toBe(PRODUCTION_ENVIRONMENT)
    expect(isProductionEnvironment(raw)).toBe(true)
  })

  it.each(['production', 'prod', ' Production ', 'PROD'])('treats %j as production', (raw) => {
    expect(havenEnvironment(raw)).toBe('production')
    expect(isProductionEnvironment(raw)).toBe(true)
  })

  it.each([
    ['dev', 'dev'],
    [' Dev ', 'dev'],
    ['staging', 'staging'],
  ])('passes any other value through, trimmed and lower-cased (%j → %j)', (raw, expected) => {
    expect(havenEnvironment(raw)).toBe(expected)
    expect(isProductionEnvironment(raw)).toBe(false)
  })

  it('never answers unknown', () => {
    for (const raw of [undefined, '', 'dev', 'prod', 'anything']) {
      expect(havenEnvironment(raw)).not.toBe('unknown')
    }
  })
})
