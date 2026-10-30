/**
 * The outbound allowlist test (#4518): over the request log of a full
 * connector workout, every request the Igdrasil connector makes is EXACTLY
 * one of the four calls it is allowed — method and path:
 *
 *   POST /api/v1/oauth/token                               (the code exchange)
 *   POST /api/v1/oauth/revoke                              (disconnect, a refused connect)
 *   GET  /api/v1/external/companies                        (the connect-time read)
 *   POST /api/v1/external/companies/{company_id}/uploads   (the document push)
 *
 * `…/supplier-invoices` (registers AND books), voucher drafts, `…/book` and
 * `DELETE …/uploads/{id}` never appear — the document-only connector has no
 * other surface, and this test is what stops one being added silently. The
 * workout covers every response path the connector can drive, plus verify,
 * which must record NOTHING.
 */
import { describe, expect, it, vi } from 'vitest'

const { tokenMocks, underlagMocks, repoMocks, entryMocks } = vi.hoisted(() => ({
  tokenMocks: { getValidOAuth2AccessToken: vi.fn(async () => 'igd_oat_live') },
  underlagMocks: { loadReceiptUnderlag: vi.fn(async (_u: string, tx: { paymentId: string }) => ({ filename: `r-${tx.paymentId}.pdf`, pdf: Buffer.from(`%PDF-1.4 ${tx.paymentId}`) })) },
  repoMocks: { getSyncState: vi.fn(async () => ({ status: 'pushed', external_ref: 'igdrasil:document:0f6e2c7a-41b9-4d3e-8a52-9c1d7e3b5a20' })), getConnection: vi.fn(async () => ({ external_company_id: '5b0e6c1a-2f7d-4c39-9a84-1d2e3f4a5b6c', base_currency: null })) },
  entryMocks: { buildAccountingEntryForPayment: vi.fn(async () => null) },
}))
vi.mock('../oauth-flow.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../oauth-flow.js')>()),
  getValidOAuth2AccessToken: tokenMocks.getValidOAuth2AccessToken,
}))
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

import { IgdrasilConnector } from '../igdrasil-connector.js'
import { IGDRASIL_REVOKE_URL, IGDRASIL_TOKEN_URL, igdrasilOAuth2Config } from '../igdrasil.js'
import { completeOAuth2Connect } from '../oauth-flow.js'
import { pkceVerifierFor } from '../oauth-pkce.js'
import { IGDRASIL } from '../registry.js'
import { feedTransaction } from './connector-conformance.js'
import { igdrasilRouter, type IgdrasilRouterState } from './igdrasil-test-router.js'

const ALLOWED = [
  /^POST \/api\/v1\/oauth\/token$/,
  /^POST \/api\/v1\/oauth\/revoke$/,
  /^GET \/api\/v1\/external\/companies$/,
  /^POST \/api\/v1\/external\/companies\/[0-9a-f-]{36}\/uploads$/,
]

describe('Igdrasil outbound allowlist (#4518)', () => {
  it('a full workout makes only the four allowed calls — and verify makes none', async () => {
    const { impl, state } = igdrasilRouter()
    const connector = new IgdrasilConnector(impl)
    const cfg = igdrasilOAuth2Config({ clientId: 'c', clientSecret: 's', redirectUri: 'https://api.test/cb' })
    const verifier = pkceVerifierFor('jti', 'key')
    const secrets = { accessToken: 'igd_oat_live', refreshToken: 'igd_ort_live' }

    // Connect: a refused multi-company grant (exchange + read + revoke) and a good one.
    state.multiCompany = true
    await completeOAuth2Connect({ provider: IGDRASIL, cfg, connector, userId: 'u', code: 'c', pkceVerifier: verifier, fetchImpl: impl }).catch(() => {})
    state.multiCompany = false
    await connector.getCompanyInfo(secrets)

    // Push through every response path.
    let n = 0
    const push = (merchantReceipt: Parameters<typeof feedTransaction>[1] = {}) =>
      connector.pushTransaction('u', feedTransaction(`pay-${++n}`, merchantReceipt)).catch(() => undefined)
    await push()
    await push({ merchantReceipt: { url: null, inlineJson: { total: '1' } } })
    for (const flag of ['refuseScope', 'companyNotGranted', 'roleRevoked', 'badFile', 'rateLimited', 'writesDisabled', 'invalidToken', 'corruptHash'] as const) {
      state[flag satisfies keyof IgdrasilRouterState] = true
      await push()
      state[flag] = false
    }
    await connector.revoke(secrets)

    const before = state.requests.length
    await connector.verify('u', 'igdrasil:document:0f6e2c7a-41b9-4d3e-8a52-9c1d7e3b5a20', 'pay-1')
    expect(state.requests.length).toBe(before)

    const seen = state.requests.map((r) => `${r.method} ${r.path}`)
    expect(seen.length).toBeGreaterThan(10)
    for (const request of seen) expect(ALLOWED.some((re) => re.test(request)), request).toBe(true)
    // Every allowed call was actually exercised — the list is not wider than the code.
    for (const re of ALLOWED) expect(seen.some((r) => re.test(r)), String(re)).toBe(true)
    // The router logs paths relative to the API base; the token endpoints are on it.
    expect(IGDRASIL_TOKEN_URL.endsWith('/api/v1/oauth/token') && IGDRASIL_REVOKE_URL.endsWith('/api/v1/oauth/revoke')).toBe(true)
  })
})
