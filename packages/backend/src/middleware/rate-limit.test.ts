import { describe, expect, it } from 'vitest'
import { rateLimitKeyFor } from './rate-limit.js'

function req(headers: Record<string, string | string[] | undefined>, ip = '203.0.113.7') {
  return { headers, ip }
}

describe('rateLimitKeyFor', () => {
  it('keys Bearer-authenticated requests per credential, not per IP', () => {
    const a = rateLimitKeyFor(req({ authorization: 'Bearer sk_agent_aaa' }, '1.1.1.1'))
    const b = rateLimitKeyFor(req({ authorization: 'Bearer sk_agent_bbb' }, '1.1.1.1'))
    expect(a).toMatch(/^cred:[0-9a-f]{32}$/)
    expect(b).toMatch(/^cred:[0-9a-f]{32}$/)
    expect(a).not.toBe(b)
    // Same credential from another IP shares the bucket.
    expect(rateLimitKeyFor(req({ authorization: 'Bearer sk_agent_aaa' }, '2.2.2.2'))).toBe(a)
  })

  it('keys X-API-Key agents per credential too — they must not collapse into the IP bucket', () => {
    const key = rateLimitKeyFor(req({ 'x-api-key': 'sk_agent_ccc' }))
    expect(key).toMatch(/^cred:[0-9a-f]{32}$/)
    expect(key).not.toBe(rateLimitKeyFor(req({ 'x-api-key': 'sk_agent_ddd' })))
    // Same agent via either header shape gets a stable per-credential bucket.
    expect(rateLimitKeyFor(req({ 'x-api-key': 'sk_agent_ccc' }, '9.9.9.9'))).toBe(key)
  })

  it('prefers Authorization when both headers are present', () => {
    const both = rateLimitKeyFor(
      req({ authorization: 'Bearer sk_agent_aaa', 'x-api-key': 'sk_agent_ccc' }),
    )
    expect(both).toBe(rateLimitKeyFor(req({ authorization: 'Bearer sk_agent_aaa' })))
  })

  it('falls back to per-IP for unauthenticated requests', () => {
    expect(rateLimitKeyFor(req({}, '203.0.113.7'))).toBe('ip:203.0.113.7')
    // Empty and non-string header values do not count as credentials.
    expect(rateLimitKeyFor(req({ authorization: '' }, '203.0.113.7'))).toBe('ip:203.0.113.7')
    expect(rateLimitKeyFor(req({ 'x-api-key': ['a', 'b'] }, '203.0.113.7'))).toBe('ip:203.0.113.7')
  })

  it('never embeds the raw credential in the bucket key', () => {
    const key = rateLimitKeyFor(req({ authorization: 'Bearer sk_agent_secret_value' }))
    expect(key).not.toContain('sk_agent_secret_value')
  })
})
