/**
 * Igdrasil connector unit tests (#4518, epic #2875) — fixture-backed, no DB.
 * The push and connect tests run against the SHARED igdrasil-test-router (the
 * same implementation the conformance suite drives); the repositories, the
 * token getter and the underlag loader are the collaborators mocked here, and
 * verify asserts the fetch double is NEVER called — it answers from Haven's
 * own record.
 *
 * What each block pins:
 *  - the company read: one company connects with `baseCurrency: null`; two
 *    companies, or a second page, refuse with `MultiCompanyGrantError` — and
 *    through the REAL `completeOAuth2Connect`, the grant just issued is
 *    revoked at Igdrasil (the generic flow's revoke, not a second path);
 *  - the push: one `file` part and nothing else, no account/VAT/lines, the
 *    `igdrasil:document:<uuid>` ref, the same bytes naming the same document;
 *  - the error map, one case per mapped code, and the transient ones thrown;
 *  - the registration gate (`igdrasilConnectorIfConfigured`).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const { configMock, tokenMocks, underlagMocks, repoMocks, entryMocks } = vi.hoisted(() => ({
  configMock: {
    igdrasilClientId: 'igd_app_fixture',
    igdrasilClientSecret: 'igd_cs_fixture',
    igdrasilRedirectUri: 'https://api.test/accounting/connections/igdrasil/callback',
  },
  tokenMocks: { getValidOAuth2AccessToken: vi.fn() },
  underlagMocks: { loadReceiptUnderlag: vi.fn() },
  repoMocks: { getSyncState: vi.fn(), getConnection: vi.fn() },
  entryMocks: { buildAccountingEntryForPayment: vi.fn() },
}))
vi.mock('../../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../config.js')>()
  return { ...actual, config: new Proxy(actual.config, { get: (t, k) => (k in configMock ? configMock[k as keyof typeof configMock] : t[k as keyof typeof t]) }) }
})
vi.mock('../oauth-flow.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../oauth-flow.js')>()),
  getValidOAuth2AccessToken: tokenMocks.getValidOAuth2AccessToken,
}))
// The connect lifecycle refuses before the exchange without a secrets key;
// the connect cases here stop at the company read, before anything is stored.
vi.mock('../../../infra/secrets.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../infra/secrets.js')>()),
  secretsKeyConfigured: () => true,
}))
vi.mock('../receipt-underlag.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../receipt-underlag.js')>()),
  loadReceiptUnderlag: underlagMocks.loadReceiptUnderlag,
}))
vi.mock('../entry.js', () => ({ buildAccountingEntryForPayment: entryMocks.buildAccountingEntryForPayment }))
vi.mock('../../../infra/repositories/accounting-feed-syncs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../infra/repositories/accounting-feed-syncs.js')>()),
  getSyncState: repoMocks.getSyncState,
}))
vi.mock('../../../infra/repositories/accounting-connections.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../infra/repositories/accounting-connections.js')>()),
  getConnection: repoMocks.getConnection,
}))

import { IgdrasilConnector, igdrasilConnectorIfConfigured } from '../igdrasil-connector.js'
import { IGDRASIL_REVOKE_URL, igdrasilOAuth2Config } from '../igdrasil.js'
import { completeOAuth2Connect } from '../oauth-flow.js'
import { pkceVerifierFor } from '../oauth-pkce.js'
import { MultiCompanyGrantError, ProviderError } from '../provider.js'
import { IGDRASIL } from '../registry.js'
import { ASSERTING_PAYLOAD_KEYS, accountingEntry, feedTransaction } from './connector-conformance.js'
import {
  IGDRASIL_COMPANY_ID,
  IGDRASIL_DOCUMENT_ID,
  IGDRASIL_MERCHANT_DOCUMENT_ID,
  igdrasilRouter,
} from './igdrasil-test-router.js'

const USER = 'user-igdrasil'
const SECRETS = { accessToken: 'igd_oat_live', refreshToken: 'igd_ort_live', tokenType: 'Bearer', scope: 'companies:read vouchers:write' }
const REF = `igdrasil:document:${IGDRASIL_DOCUMENT_ID}`

function underlagFor(paymentId: string) {
  return { filename: `haven-receipt-${paymentId}.pdf`, pdf: Buffer.from(`%PDF-1.4 igdrasil unit ${paymentId}`) }
}

beforeEach(() => {
  tokenMocks.getValidOAuth2AccessToken.mockReset().mockResolvedValue('igd_oat_live')
  repoMocks.getConnection.mockReset().mockResolvedValue({ external_company_id: IGDRASIL_COMPANY_ID, base_currency: null, status: 'connected', secrets_ciphertext: Buffer.from('x') })
  repoMocks.getSyncState.mockReset()
  underlagMocks.loadReceiptUnderlag.mockReset().mockImplementation(async (_u: string, tx: { paymentId: string }) => underlagFor(tx.paymentId))
  entryMocks.buildAccountingEntryForPayment.mockReset().mockImplementation(async (_u: string, pid: string) => accountingEntry(pid))
  configMock.igdrasilClientId = 'igd_app_fixture'
  configMock.igdrasilClientSecret = 'igd_cs_fixture'
  configMock.igdrasilRedirectUri = 'https://api.test/accounting/connections/igdrasil/callback'
})

describe('IgdrasilConnector.getCompanyInfo', () => {
  it('one company: its id and name, baseCurrency null (no currency on PublicCompany), read with the bearer token', async () => {
    const { impl, state } = igdrasilRouter()
    const info = await new IgdrasilConnector(impl).getCompanyInfo(SECRETS)
    expect(info).toEqual({ externalCompanyId: IGDRASIL_COMPANY_ID, name: 'Testbolaget Igdrasil AB', baseCurrency: null })
    expect(state.requests).toEqual([{ method: 'GET', path: '/api/v1/external/companies' }])
  })

  it('multi-company: two companies refuse with MultiCompanyGrantError', async () => {
    const { impl, state } = igdrasilRouter()
    state.multiCompany = true
    await expect(new IgdrasilConnector(impl).getCompanyInfo(SECRETS)).rejects.toBeInstanceOf(MultiCompanyGrantError)
  })

  it('multi-company: one company with has_more (a second page) refuses too', async () => {
    const { impl, state } = igdrasilRouter()
    state.morePages = true
    await expect(new IgdrasilConnector(impl).getCompanyInfo(SECRETS)).rejects.toBeInstanceOf(MultiCompanyGrantError)
  })

  it('a token Igdrasil refuses is a thrown ProviderError, not a company', async () => {
    const { impl, state } = igdrasilRouter()
    state.invalidToken = true
    await expect(new IgdrasilConnector(impl).getCompanyInfo(SECRETS)).rejects.toMatchObject({ status: 401, provider: 'igdrasil' })
  })
})

describe('the connect lifecycle (real completeOAuth2Connect, PKCE on)', () => {
  const cfg = igdrasilOAuth2Config({ clientId: 'igd_app_fixture', clientSecret: 'igd_cs_fixture', redirectUri: 'https://api.test/cb' })
  const verifier = pkceVerifierFor('jti-unit', 'key-unit')

  it('a multi-company grant is refused AND the grant just issued is revoked at Igdrasil', async () => {
    const { impl, state } = igdrasilRouter()
    state.multiCompany = true
    await expect(
      completeOAuth2Connect({ provider: IGDRASIL, cfg, connector: new IgdrasilConnector(impl), userId: USER, code: 'auth-code', pkceVerifier: verifier, fetchImpl: impl }),
    ).rejects.toBeInstanceOf(MultiCompanyGrantError)
    // The exchange carried the verifier (PKCE is on for Igdrasil)…
    expect(new URLSearchParams(state.tokenBodies[0]).get('code_verifier')).toBe(verifier)
    // …and the generic flow revoked the fresh grant: its refresh token, once.
    expect(state.revokeCalls).toBe(1)
    const revoked = new URLSearchParams(state.revokeBodies[0])
    expect(revoked.get('token')).toBe('igd_ort_fixture_refresh')
    expect(revoked.get('token_type_hint')).toBe('refresh_token')
    expect(state.requests.filter((r) => r.path.includes('/uploads'))).toEqual([])
  })
})

describe('IgdrasilConnector.pushTransaction', () => {
  it('uploads the underlag as one `file` part — no idempotency key, no account, VAT or lines — and returns the namespaced ref', async () => {
    const { impl, state } = igdrasilRouter()
    const tx = feedTransaction('pay-1')
    const result = await new IgdrasilConnector(impl).pushTransaction(USER, tx)
    expect(result).toEqual({ externalRef: REF, status: 'pushed' })
    expect(state.uploads).toHaveLength(1)
    const [upload] = state.uploads
    expect(upload.companyId).toBe(IGDRASIL_COMPANY_ID)
    expect(upload.parts).toEqual(['file'])
    expect(upload.filename).toBe('haven-receipt-pay-1.pdf')
    expect(upload.contentType).toBe('application/pdf')
    expect(upload.headers).toEqual({ Authorization: 'Bearer igd_oat_live', Accept: 'application/json' })
    for (const key of ASSERTING_PAYLOAD_KEYS) expect(upload.parts).not.toContain(key)
  })

  it('the same bytes again name the same document: same ref, no second document created', async () => {
    const { impl, state } = igdrasilRouter()
    const connector = new IgdrasilConnector(impl)
    const tx = feedTransaction('pay-2')
    const first = await connector.pushTransaction(USER, tx)
    const second = await connector.pushTransaction(USER, tx)
    expect(second.externalRef).toBe(first.externalRef)
    expect(state.uploadCalls).toBe(1)
    expect(state.uploads).toHaveLength(2)
  })

  it('the merchant invoice is a second document with its own ref; a failure there is a note, never a failed push', async () => {
    const receipt = { url: null, inlineJson: { saljare: { name: 'Haven Demo AB' }, total: '1.00' } }
    const ok = igdrasilRouter()
    const pushed = await new IgdrasilConnector(ok.impl).pushTransaction(USER, feedTransaction('pay-3', { merchantReceipt: receipt }))
    expect(pushed).toMatchObject({ externalRef: REF, status: 'pushed', merchantInvoiceRef: `igdrasil:document:${IGDRASIL_MERCHANT_DOCUMENT_ID}` })
    expect(ok.state.uploadCalls).toBe(2)

    const failing = igdrasilRouter()
    failing.state.failSecondUpload = true
    const degraded = await new IgdrasilConnector(failing.impl).pushTransaction(USER, feedTransaction('pay-4', { merchantReceipt: receipt }))
    expect(degraded.status).toBe('pushed')
    expect(degraded.externalRef).toBe(REF)
    expect(degraded.merchantInvoiceRef).toBeUndefined()
    expect(degraded.note).toMatch(/merchant's own invoice was not attached/)
  })

  it('no live token → not_connected, no request; no company on the row → skipped, no request', async () => {
    const { impl, state } = igdrasilRouter()
    tokenMocks.getValidOAuth2AccessToken.mockResolvedValueOnce(null)
    expect(await new IgdrasilConnector(impl).pushTransaction(USER, feedTransaction('pay-5'))).toEqual({ externalRef: null, status: 'skipped', reason: 'not_connected' })
    repoMocks.getConnection.mockResolvedValueOnce({ external_company_id: null })
    const noCompany = await new IgdrasilConnector(impl).pushTransaction(USER, feedTransaction('pay-6'))
    expect(noCompany).toMatchObject({ status: 'skipped', externalRef: null })
    expect(noCompany.reason).toMatch(/no company recorded/)
    expect(state.requests).toEqual([])
  })

  it('a sha256 that does not match the bytes sent is not a delivery: skipped, no ref stored', async () => {
    const { impl, state } = igdrasilRouter()
    state.corruptHash = true
    const result = await new IgdrasilConnector(impl).pushTransaction(USER, feedTransaction('pay-7'))
    expect(result).toMatchObject({ externalRef: null, status: 'skipped' })
    expect(result.reason).toMatch(/sha256 mismatch/)
  })
})

describe('IgdrasilConnector.pushTransaction — the error map', () => {
  async function pushWith(flag: 'refuseScope' | 'companyNotGranted' | 'roleRevoked' | 'badFile' | 'rateLimited' | 'writesDisabled' | 'invalidToken') {
    const { impl, state } = igdrasilRouter()
    state[flag] = true
    return new IgdrasilConnector(impl).pushTransaction(USER, feedTransaction(`pay-${flag}`))
  }

  it('insufficient_scope: skipped before anything was created, connection → scope_missing naming vouchers:write', async () => {
    const result = await pushWith('refuseScope')
    expect(result).toMatchObject({ externalRef: null, status: 'skipped', connectionStatus: 'scope_missing', missingScopes: ['vouchers:write'] })
  })

  it('company_not_granted: skipped, connection → needs_reauthorisation', async () => {
    expect(await pushWith('companyNotGranted')).toMatchObject({ status: 'skipped', connectionStatus: 'needs_reauthorisation' })
  })

  it('grant_role_revoked: skipped, connection → needs_reauthorisation', async () => {
    const result = await pushWith('roleRevoked')
    expect(result).toMatchObject({ status: 'skipped', connectionStatus: 'needs_reauthorisation' })
    expect(result.reason).toContain('grant_role_revoked')
  })

  it('400: the document itself was refused — skipped, and the connection is NOT flagged', async () => {
    const result = await pushWith('badFile')
    expect(result).toMatchObject({ externalRef: null, status: 'skipped' })
    expect(result.connectionStatus).toBeUndefined()
  })

  it('429: thrown with retryAfterMs from Retry-After (seconds), for the sweep to defer', async () => {
    await expect(pushWith('rateLimited')).rejects.toMatchObject({ status: 429, retryAfterMs: 7000 })
  })

  it('503 writes_disabled: thrown as transient — never a grant verdict', async () => {
    const err = await pushWith('writesDisabled').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err).toMatchObject({ status: 503, providerCode: 'writes_disabled' })
  })

  it('401 invalid_token at push: thrown as transient (the next refresh decides the grant), no connection flag', async () => {
    await expect(pushWith('invalidToken')).rejects.toMatchObject({ status: 401, providerCode: 'invalid_token' })
  })

  it('no error message carries the access token', async () => {
    for (const flag of ['refuseScope', 'companyNotGranted', 'badFile'] as const) {
      expect(JSON.stringify(await pushWith(flag))).not.toContain('igd_oat_live')
    }
    for (const flag of ['rateLimited', 'writesDisabled', 'invalidToken'] as const) {
      const err = (await pushWith(flag).catch((e: unknown) => e)) as Error
      expect(err.message).not.toContain('igd_oat_live')
    }
  })
})

describe('IgdrasilConnector.verify — from Haven’s own record, zero provider calls', () => {
  it('pushed with this ref → registered with the document id; never claims booking', async () => {
    const { impl, state } = igdrasilRouter()
    repoMocks.getSyncState.mockResolvedValue({ status: 'pushed', external_ref: REF })
    const outcome = await new IgdrasilConnector(impl).verify(USER, REF, 'pay-v')
    expect(outcome).toMatchObject({ ok: true, verification: { registered: true, missing: null, document_ref: IGDRASIL_DOCUMENT_ID, booked: null, voucher: null } })
    expect(state.requests).toEqual([])
  })

  it('a well-formed ref the row does not carry → foreign_invoice; another shape → no_invoice_ref', async () => {
    const { impl, state } = igdrasilRouter()
    repoMocks.getSyncState.mockResolvedValue({ status: 'pushed', external_ref: 'igdrasil:document:aaaaaaaa-0000-4000-8000-000000000000' })
    expect(await new IgdrasilConnector(impl).verify(USER, REF, 'pay-v')).toMatchObject({ ok: true, verification: { registered: false, missing: 'foreign_invoice' } })
    expect(await new IgdrasilConnector(impl).verify(USER, 'accounted:document:3f1c7a52-9b04-4e6a-8f21-7c5d2e8b9a10', 'pay-v')).toEqual({ ok: false, error_code: 'no_invoice_ref' })
    expect(state.requests).toEqual([])
  })
})

describe('IgdrasilConnector.revoke', () => {
  it('posts the refresh token to /oauth/revoke with token_type_hint=refresh_token and Basic client auth', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    await new IgdrasilConnector(impl).revoke(SECRETS)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(IGDRASIL_REVOKE_URL)
    const body = new URLSearchParams(String(calls[0].init.body))
    expect(body.get('token')).toBe('igd_ort_live')
    expect(body.get('token_type_hint')).toBe('refresh_token')
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('igd_app_fixture:igd_cs_fixture').toString('base64')}`)
  })

  it('a secrets blob without a refresh token is a provider error, not a silent success', async () => {
    await expect(new IgdrasilConnector(igdrasilRouter().impl).revoke({ accessToken: 'x' })).rejects.toBeInstanceOf(ProviderError)
  })
})

describe('registration gate (igdrasilConnectorIfConfigured)', () => {
  it('REGRESSION GUARD: with any of the three IGDRASIL_* values unset there is no instance — the provider stays configured: false', () => {
    for (const key of ['igdrasilClientId', 'igdrasilClientSecret', 'igdrasilRedirectUri'] as const) {
      const saved = configMock[key]
      configMock[key] = ''
      expect(igdrasilConnectorIfConfigured()).toBeNull()
      configMock[key] = saved
    }
  })

  it('with all three set there is an instance, and the descriptor is still coming_soon (#4519 flips it)', () => {
    expect(igdrasilConnectorIfConfigured()).toBeInstanceOf(IgdrasilConnector)
    expect(IGDRASIL.availability).toBe('coming_soon')
    expect(IGDRASIL.capabilities).toEqual({ attachments: false, verify: false, revoke: true, companyInfo: true })
    expect(IGDRASIL.requiredScopes).toEqual(['companies:read', 'vouchers:write'])
  })
})
