import { describe, it, expect } from 'vitest'
import {
  parseSetupId,
  setupIdFromSearch,
  postAuthDestination,
  sanitizeNextPath,
  nextPathFromSearch,
  parseViaMarker,
  viaMarkerFromSearch,
  VIA_AGENT,
} from '../discovery'

/**
 * Hand-off link sanitisers (#2522).
 *
 * `next` is an open-redirect boundary — the value comes from a URL a stranger
 * may have written and is handed to `router.replace`. The hostile cases below
 * are not hypotheticals: each was resolved with the real URL parser first, and
 * the two marked BYPASS are the ones an origin check alone lets through.
 */

describe('sanitizeNextPath', () => {
  it('keeps a same-origin path with its query and hash', () => {
    expect(sanitizeNextPath('/agents?setup=hv_setup_x')).toBe('/agents?setup=hv_setup_x')
    expect(sanitizeNextPath('/agents#budget')).toBe('/agents#budget')
    expect(sanitizeNextPath('/')).toBe('/')
    expect(sanitizeNextPath('  /onboarding  ')).toBe('/onboarding')
  })

  it('refuses anything that leaves the origin', () => {
    const hostile = [
      'https://evil.com',
      'http://evil.com',
      '//evil.com',
      '/\\evil.com',
      '\\\\evil.com',
      'javascript:alert(1)',
      'data:text/html,<script>',
      'evil.com',
      '//',
    ]
    for (const value of hostile) {
      expect(sanitizeNextPath(value), `expected ${JSON.stringify(value)} to be refused`).toBeNull()
    }
  })

  it('BYPASS 1: refuses a same-origin value whose RESULT is protocol-relative', () => {
    // `/..//evil.com` resolves to the same origin — an origin check passes —
    // but its pathname is `//evil.com`, which a browser reads as a
    // protocol-relative URL. Returning it would reopen the redirect.
    expect(new URL('/..//evil.com', 'https://haven.invalid').origin).toBe('https://haven.invalid')
    expect(new URL('/..//evil.com', 'https://haven.invalid').pathname).toBe('//evil.com')
    expect(sanitizeNextPath('/..//evil.com')).toBeNull()
  })

  it('BYPASS 2: refuses control characters instead of letting the parser strip them', () => {
    // The parser drops the tab, so the string that gets resolved is not the
    // string that was checked. A tab before a second slash would survive as
    // `//evil.com`.
    expect(new URL('/foo\tbar', 'https://haven.invalid').pathname).toBe('/foobar')
    expect(sanitizeNextPath('/foo\tbar')).toBeNull()
    expect(sanitizeNextPath('/\t/evil.com')).toBeNull()
    expect(sanitizeNextPath('/foo\nbar')).toBeNull()
    expect(sanitizeNextPath('/foo\r\nbar')).toBeNull()
  })

  it('refuses non-strings and over-long values', () => {
    expect(sanitizeNextPath(null)).toBeNull()
    expect(sanitizeNextPath(undefined)).toBeNull()
    expect(sanitizeNextPath('')).toBeNull()
    expect(sanitizeNextPath('   ')).toBeNull()
    expect(sanitizeNextPath(`/${'a'.repeat(512)}`)).toBeNull()
    expect(sanitizeNextPath(`/${'a'.repeat(500)}`)).toBe(`/${'a'.repeat(500)}`)
  })

  it('reads next from a search string', () => {
    expect(nextPathFromSearch('?next=%2Fagents%3Fsetup%3Dhv_setup_x')).toBe(
      '/agents?setup=hv_setup_x',
    )
    expect(nextPathFromSearch('?next=https%3A%2F%2Fevil.com')).toBeNull()
    expect(nextPathFromSearch('')).toBeNull()
    expect(nextPathFromSearch('?other=1')).toBeNull()
  })
})

describe('parseViaMarker', () => {
  it('accepts only the agent enum', () => {
    expect(parseViaMarker('agent')).toBe(VIA_AGENT)
    expect(parseViaMarker('AGENT')).toBe(VIA_AGENT)
    expect(parseViaMarker(' agent ')).toBe(VIA_AGENT)
  })

  it('drops every other value rather than storing it', () => {
    // A free-text field here would let a link author write anything into the
    // funnel metrics D1 (#2529) segments on.
    const rejected: Array<string | null | undefined> = [
      'human',
      'bot',
      'agent-x',
      'agentic',
      '',
      null,
      undefined,
    ]
    for (const value of rejected) {
      expect(parseViaMarker(value), `expected ${JSON.stringify(value)} to be dropped`).toBeNull()
    }
  })

  it('reads via from a search string', () => {
    expect(viaMarkerFromSearch('?via=agent')).toBe(VIA_AGENT)
    expect(viaMarkerFromSearch('?via=human')).toBeNull()
    expect(viaMarkerFromSearch('?next=%2Fagents&via=agent')).toBe(VIA_AGENT)
    expect(viaMarkerFromSearch('')).toBeNull()
  })
})

describe('parseSetupId', () => {
  const ID = '11111111-2222-3333-4444-555555555555'

  it('accepts a setup id in the shape the API issues', () => {
    expect(parseSetupId(ID)).toBe(ID)
    expect(parseSetupId(ID.toUpperCase())).toBe(ID.toUpperCase())
    expect(setupIdFromSearch(`?setup=${ID}`)).toBe(ID)
  })

  it('leaves the pre-existing ?setup=first sentinel alone (#352)', () => {
    // `setup` is a SHARED parameter: `?setup=first` already means "auto-open
    // the connect flow for this user's first agent". The two shapes coexist
    // only because that handler tests for the literal and this one accepts a
    // UUID — loosening either is what this case is here to catch.
    expect(parseSetupId('first')).toBeNull()
    expect(setupIdFromSearch('?setup=first')).toBeNull()
  })

  it('drops anything else rather than interpolating it into a request path', () => {
    // "the server will 404 it" is not a reason to send arbitrary input into a
    // URL path. An unusable value reads as absent, so the page renders.
    for (const value of ['../admin', `${ID}/../x`, 'hv_setup_abc', '', 'null', null, undefined]) {
      expect(parseSetupId(value as string | null | undefined)).toBeNull()
    }
    expect(setupIdFromSearch('?setup=../admin')).toBeNull()
    expect(setupIdFromSearch('')).toBeNull()
  })
})

describe('postAuthDestination', () => {
  it('sends an established user straight to the hand-off target', () => {
    expect(postAuthDestination(true, '/agents?setup=x')).toBe('/agents?setup=x')
    expect(postAuthDestination(true, null)).toBe('/dashboard')
  })

  it('carries the target THROUGH onboarding for a brand-new user', () => {
    // The contract that makes the link worth pasting: signup, create an
    // account, and still land on the approval rather than the dashboard.
    expect(postAuthDestination(false, '/agents?setup=x')).toBe(
      '/onboarding?next=%2Fagents%3Fsetup%3Dx',
    )
    expect(postAuthDestination(false, null)).toBe('/onboarding')
  })
})
