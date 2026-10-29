/**
 * PKCE in the generic accounting OAuth2 flow (#4517, epic #2875).
 *
 * The flow's HTTP half with a PKCE provider config: the consent URL carries
 * the S256 challenge, the code exchange carries the verifier it was derived
 * from, and both refuse without one. A provider without PKCE (Fortnox) gets
 * exactly the URL and exchange body it always did — pinned here, so the
 * opt-in cannot leak into Fortnox's wire. The route-level wiring (one jti →
 * the same verifier at connect-url and at the callback, never in the state)
 * is in `routes/__tests__/accounting-connections.test.ts`.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { buildAuthorizeUrl, exchangeCode, type OAuth2ProviderConfig } from '../oauth-flow.js'
import { pkceChallengeFor, pkceVerifierFor } from '../oauth-pkce.js'

const BASE: OAuth2ProviderConfig = {
  providerId: 'pkce-provider',
  authorizeUrl: 'https://provider.test/oauth/authorize',
  tokenUrl: 'https://provider.test/oauth/token',
  clientId: 'cid',
  clientSecret: 'csecret',
  redirectUri: 'https://api.test/accounting/connections/pkce-provider/callback',
  scope: 'companies:read vouchers:write',
}
const PKCE: OAuth2ProviderConfig = { ...BASE, pkce: 'S256' }
const JTI = '6f1d0c3e-6a43-4c55-9a51-2b0e7f1c9d10'
const KEY = 'server-only-key'

function tokenFetch() {
  return vi.fn(async () =>
    new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', token_type: 'Bearer', scope: 'companies:read', expires_in: 900 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

describe('oauth-pkce: verifier and challenge', () => {
  it('the challenge is base64url(SHA-256(verifier)) — RFC 7636 Appendix B vector', () => {
    expect(pkceChallengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('the verifier is 43 characters from the unreserved set, stable per (jti, key), distinct across either', () => {
    const v = pkceVerifierFor(JTI, KEY)
    expect(v).toMatch(/^[A-Za-z0-9\-._~]{43}$/)
    expect(pkceVerifierFor(JTI, KEY)).toBe(v)
    expect(pkceVerifierFor('another-jti', KEY)).not.toBe(v)
    expect(pkceVerifierFor(JTI, 'another-key')).not.toBe(v)
  })

  it('the verifier is not computable from the jti alone (it is not a hash of the jti)', () => {
    const v = pkceVerifierFor(JTI, KEY)
    expect(v).not.toBe(createHash('sha256').update(JTI).digest('base64url'))
    expect(v).not.toBe(createHash('sha256').update(`accounting-pkce:${JTI}`).digest('base64url'))
  })

  it('refuses without a jti or a key', () => {
    expect(() => pkceVerifierFor('', KEY)).toThrow(/jti/)
    expect(() => pkceVerifierFor(JTI, '')).toThrow(/key/)
  })
})

describe('buildAuthorizeUrl with PKCE', () => {
  it('carries code_challenge (of the verifier) and code_challenge_method=S256, and never the verifier', () => {
    const verifier = pkceVerifierFor(JTI, KEY)
    const url = buildAuthorizeUrl(PKCE, 'signed-state', verifier)
    const params = new URL(url).searchParams
    expect(params.get('code_challenge')).toBe(pkceChallengeFor(verifier))
    expect(params.get('code_challenge_method')).toBe('S256')
    expect(params.get('code_verifier')).toBeNull()
    expect(url).not.toContain(verifier)
    expect(params.get('state')).toBe('signed-state')
  })

  it('refuses to build a PKCE consent URL without a verifier', () => {
    expect(() => buildAuthorizeUrl(PKCE, 'signed-state')).toThrow(/requires PKCE/)
  })

  it('REGRESSION GUARD: a provider without PKCE gets exactly the pre-#4517 URL, verifier or not', () => {
    const expected =
      'https://provider.test/oauth/authorize?client_id=cid&redirect_uri=https%3A%2F%2Fapi.test%2Faccounting%2Fconnections%2Fpkce-provider%2Fcallback&scope=companies%3Aread+vouchers%3Awrite&state=s&response_type=code'
    expect(buildAuthorizeUrl(BASE, 's')).toBe(expected)
    expect(buildAuthorizeUrl(BASE, 's', pkceVerifierFor(JTI, KEY))).toBe(expected)
  })
})

describe('exchangeCode with PKCE', () => {
  it('exchange carries the verifier — the one whose challenge the consent URL sent', async () => {
    const verifier = pkceVerifierFor(JTI, KEY)
    const challenge = new URL(buildAuthorizeUrl(PKCE, 's', verifier)).searchParams.get('code_challenge')
    const fetchImpl = tokenFetch()
    await exchangeCode(PKCE, 'auth-code', fetchImpl as unknown as typeof fetch, verifier)
    const body = new URLSearchParams(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('auth-code')
    const sent = body.get('code_verifier')
    expect(sent).toBe(verifier)
    // What the provider checks: the challenge recomputed from what was sent.
    expect(pkceChallengeFor(sent!)).toBe(challenge)
  })

  it('refuses before any request when the verifier is missing', async () => {
    const fetchImpl = tokenFetch()
    await expect(exchangeCode(PKCE, 'auth-code', fetchImpl as unknown as typeof fetch)).rejects.toThrow(/requires PKCE/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('REGRESSION GUARD: a provider without PKCE sends exactly grant_type, code, redirect_uri', async () => {
    const fetchImpl = tokenFetch()
    await exchangeCode(BASE, 'auth-code', fetchImpl as unknown as typeof fetch, pkceVerifierFor(JTI, KEY))
    expect(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)).toBe(
      'grant_type=authorization_code&code=auth-code&redirect_uri=https%3A%2F%2Fapi.test%2Faccounting%2Fconnections%2Fpkce-provider%2Fcallback',
    )
  })
})
