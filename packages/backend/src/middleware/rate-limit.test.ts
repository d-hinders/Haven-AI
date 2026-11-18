import { describe, expect, it } from 'vitest'
import { feedbackSubmitRateLimit, rateLimitKeyFor, type RateLimitSubject } from './rate-limit.js'

function req(fields: Omit<RateLimitSubject, 'ip'> & { headers?: Record<string, string | string[] | undefined> }, ip = '203.0.113.7') {
  return { ...fields, ip }
}

/**
 * #4955: the key is the identity an auth hook verified. Headers are carried
 * in some of these requests ONLY to prove they are never read — the old rule
 * hashed `Authorization` (else `X-API-Key`), so a junk header picked the
 * bucket. Route-level proof (real plugin, real auth, real routes) is in
 * `routes/__tests__/rate-limit-identity-keys.test.ts`.
 */
describe('rateLimitKeyFor (#4955)', () => {
  it('keys an admitted agent on its id, whatever headers arrived', () => {
    const a = rateLimitKeyFor(req({ agent: { id: 'agent-1' }, headers: { authorization: 'Bearer junk-1' } }))
    const b = rateLimitKeyFor(req({ agent: { id: 'agent-1' }, headers: { authorization: 'Bearer junk-2' } }, '2.2.2.2'))
    expect(a).toBe('agent:agent-1')
    expect(b).toBe(a)
    expect(rateLimitKeyFor(req({ agent: { id: 'agent-2' } }))).not.toBe(a)
  })

  it('keys a Sales key on its key id', () => {
    expect(rateLimitKeyFor(req({ merchant: { key_id: 'mk-1' }, headers: { 'x-api-key': 'junk' } }))).toBe('merchant_key:mk-1')
  })

  it('keys an owner session on its verified sub, so two tokens of one owner share a bucket', () => {
    expect(rateLimitKeyFor(req({ user: { sub: 'user-1', iat: 1 }, headers: { authorization: 'Bearer token-a' } }))).toBe('user:user-1')
    expect(rateLimitKeyFor(req({ user: { sub: 'user-1', iat: 2 }, headers: { authorization: 'Bearer token-b' } }))).toBe('user:user-1')
    expect(rateLimitKeyFor(req({ user: { sub: 'user-2' } }))).toBe('user:user-2')
  })

  it('falls back to the IP when no auth admitted the caller — headers alone never leave the IP bucket', () => {
    expect(rateLimitKeyFor(req({}))).toBe('ip:203.0.113.7')
    expect(rateLimitKeyFor(req({ headers: { authorization: 'Bearer junk' } }))).toBe('ip:203.0.113.7')
    expect(rateLimitKeyFor(req({ headers: { 'x-api-key': 'sk_agent_unverified' } }))).toBe('ip:203.0.113.7')
    expect(rateLimitKeyFor(req({ headers: { 'x-api-key': ['a', 'b'] } }))).toBe('ip:203.0.113.7')
  })

  it('ignores an empty or non-string identity rather than keying on it', () => {
    expect(rateLimitKeyFor(req({ agent: { id: '' } }))).toBe('ip:203.0.113.7')
    expect(rateLimitKeyFor(req({ merchant: { key_id: 7 } }))).toBe('ip:203.0.113.7')
    expect(rateLimitKeyFor(req({ user: { sub: '' } }))).toBe('ip:203.0.113.7')
    expect(rateLimitKeyFor(req({ user: null }))).toBe('ip:203.0.113.7')
  })

  it('never embeds a credential in the bucket key', () => {
    const key = rateLimitKeyFor(req({ agent: { id: 'agent-1' }, headers: { authorization: 'Bearer sk_agent_secret_value' } }))
    expect(key).not.toContain('sk_agent_secret_value')
  })
})

describe('feedbackSubmitRateLimit (#3597)', () => {
  const keyGenerator = feedbackSubmitRateLimit.rateLimit.keyGenerator

  it('keys per user — two sessions for the same user share one bucket', () => {
    const a = keyGenerator({ user: { sub: 'user-1' } })
    const b = keyGenerator({ user: { sub: 'user-1' } })
    expect(a).toBe(b)
    expect(a).toBe('feedback_user:user-1')
  })

  it('two different users get two different buckets', () => {
    const a = keyGenerator({ user: { sub: 'user-1' } })
    const b = keyGenerator({ user: { sub: 'user-2' } })
    expect(a).not.toBe(b)
  })

  // MUTATION PROOF: reading `request.headers`/`request.ip` instead of
  // `request.user.sub` would pass every test above (two distinct fake
  // requests still produce two distinct keys) and only fail here, where the
  // SAME user is reached through what the credential-keyed generator would
  // see as two different callers.
  it('MUTATION PROOF: unrelated request shape (headers/ip) does not change the key — only user.sub does', () => {
    const viaHeaders = keyGenerator({
      user: { sub: 'user-1' },
      headers: { authorization: 'Bearer token-a' },
      ip: '1.1.1.1',
    } as never)
    const viaOtherHeaders = keyGenerator({
      user: { sub: 'user-1' },
      headers: { authorization: 'Bearer token-b' },
      ip: '2.2.2.2',
    } as never)
    expect(viaHeaders).toBe(viaOtherHeaders)
  })
})
