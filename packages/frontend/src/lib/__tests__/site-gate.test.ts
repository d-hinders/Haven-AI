import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isNewSiteVisible } from '@/lib/site-gate'

/**
 * The redesigned public site's build-time gate (#3573, epic #3572).
 *
 * The explicit-argument cases pin the rule; the stubbed-env cases pin that the
 * DEFAULT arguments read the two variables — the path every caller takes.
 */
describe('isNewSiteVisible (#3573)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it.each([undefined, '', 'production', 'prod'])('is off on production (%j) without the preview flag', (env) => {
    expect(isNewSiteVisible(env, undefined)).toBe(false)
  })

  it('is on outside production', () => {
    expect(isNewSiteVisible('dev', undefined)).toBe(true)
  })

  it("is on in a production-shaped build when the preview flag is '1'", () => {
    expect(isNewSiteVisible(undefined, '1')).toBe(true)
  })

  it.each(['0', 'true', '', ' 1'])("is off on production for any preview value but '1' (%j)", (preview) => {
    expect(isNewSiteVisible(undefined, preview)).toBe(false)
  })

  it('reads NEXT_PUBLIC_HAVEN_ENV by default', () => {
    vi.stubEnv('NEXT_PUBLIC_HAVEN_SITE_PREVIEW', '')
    vi.stubEnv('NEXT_PUBLIC_HAVEN_ENV', 'dev')
    expect(isNewSiteVisible()).toBe(true)
    vi.stubEnv('NEXT_PUBLIC_HAVEN_ENV', '')
    expect(isNewSiteVisible()).toBe(false)
  })

  it('reads NEXT_PUBLIC_HAVEN_SITE_PREVIEW by default', () => {
    vi.stubEnv('NEXT_PUBLIC_HAVEN_ENV', '')
    vi.stubEnv('NEXT_PUBLIC_HAVEN_SITE_PREVIEW', '1')
    expect(isNewSiteVisible()).toBe(true)
  })

  it('references both variables literally, so Next inlines them into client bundles', () => {
    const source = readFileSync(join(__dirname, '..', 'site-gate.ts'), 'utf8')
    expect(source).toContain('= process.env.NEXT_PUBLIC_HAVEN_ENV')
    expect(source).toContain('= process.env.NEXT_PUBLIC_HAVEN_SITE_PREVIEW')
  })
})
