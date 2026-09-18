/**
 * The outbound allowlist test (#3018): over the recorded request log of a
 * full connector workout, every request the Accounted connector makes is
 * EXACTLY one of the two calls the connector is allowed — method and path:
 *
 *   GET  /api/v1/companies                        (the connect-time read)
 *   POST /api/v1/companies/{companyId}/documents  (the WORM upload)
 *
 * `/download` (it writes a `document.accessed` audit event per call),
 * `journal-entries`, `supplier-invoices`, and `link` never appear — the
 * document-only connector has no other surface, and this test is what stops
 * one from being added silently. The exchanges below cover every response
 * path the connector can drive (success, replay, 409, 403 scope, plain 403,
 * 400, 500, 429) plus verify, which must record NOTHING at all.
 */
import { describe, expect, it, vi } from 'vitest'

const { flowMocks, underlagMocks, repoMocks, entryMocks } = vi.hoisted(() => ({
  flowMocks: { readApiKeyConnection: vi.fn() },
  underlagMocks: { loadReceiptUnderlag: vi.fn() },
  repoMocks: { getSyncState: vi.fn(), getConnection: vi.fn() },
  entryMocks: { buildAccountingEntryForPayment: vi.fn() },
}))
vi.mock('../api-key-flow.js', () => ({ readApiKeyConnection: flowMocks.readApiKeyConnection }))
vi.mock('../receipt-underlag.js', () => ({ loadReceiptUnderlag: underlagMocks.loadReceiptUnderlag }))
vi.mock('../entry.js', () => ({ buildAccountingEntryForPayment: entryMocks.buildAccountingEntryForPayment }))
vi.mock('../../../infra/repositories/accounting-feed-syncs.js', () => ({
  getSyncState: repoMocks.getSyncState,
}))
vi.mock('../../../infra/repositories/accounting-connections.js', () => ({
  getConnection: repoMocks.getConnection,
}))

import { AccountedConnector } from '../accounted-connector.js'
import type { ProviderSecrets } from '../connector.js'
import { accountedRouter } from './accounted-test-router.js'

const SECRETS: ProviderSecrets = { apiKey: 'gnubok_sk_test_allowlist' }
const USER = 'user-allowlist'
const PAYMENT = 'pay-allowlist'
const DOC_REF = 'accounted:document:3f1c7a52-9b04-4e6a-8f21-7c5d2e8b9a10'

function tx() {
  return {
    paymentId: PAYMENT,
    settledAt: '2026-09-10T09:30:00.000Z',
    direction: 'out' as const,
    counterparty: { address: '0x' + 'ab'.repeat(20), name: 'NordShield VPN' },
    resourceUrl: 'https://merchant.example/vpn',
    token: 'USDC',
    amountAtomic: '1000',
    amountSek: '10.42',
    ledgerCurrency: 'SEK' as const,
    amountLedger: '10.42',
    fxRateLedger: '10.42',
    fxRate: '10.42',
    fxSource: 'riksbank',
    fxAt: '2026-09-10T09:30:00.000Z',
    receiptRef: 'receipt-1',
    merchantReceipt: null,
    suggestedAccount: '6540',
  }
}

function connected(companyId: string | null) {
  flowMocks.readApiKeyConnection.mockResolvedValue({
    row: { external_company_id: companyId },
    secrets: SECRETS,
  })
}

function underlag(bytes = Buffer.from('%PDF-1.4 allowlist fixture')) {
  underlagMocks.loadReceiptUnderlag.mockResolvedValue({ filename: `haven-receipt-${PAYMENT}.pdf`, pdf: bytes })
}

/** Drive every response path the connector can reach, accumulating the request log. */
async function workout(): Promise<{ method: string; path: string }[]> {
  connected('732b80b7-d0f7-45b9-8083-571f8d28d001')
  underlag()
  const requests: { method: string; path: string }[] = []
  // One exchange = one fresh router, configured by `set`, driven once; its
  // recorded requests join the log. The failure paths THROW by contract, so
  // the drive is caught — the requests it made before throwing are the data.
  const exchange = async (
    set: (state: ReturnType<typeof accountedRouter>['state']) => void,
    drive: (c: AccountedConnector) => Promise<unknown>,
  ) => {
    const { impl, state } = accountedRouter()
    set(state)
    const c = new AccountedConnector(impl)
    await drive(c).catch(() => undefined)
    requests.push(...state.requests)
  }

  await exchange(() => undefined, async (c) => c.getCompanyInfo(SECRETS)) // GET /api/v1/companies
  await exchange(() => undefined, async (c) => c.pushTransaction(USER, tx())) // POST documents (success)
  await exchange(() => undefined, async (c) => c.pushTransaction(USER, tx())) // POST documents (replay)
  await exchange(
    () => undefined,
    async (c) => {
      underlag(Buffer.from('%PDF-1.4 CHANGED BYTES'))
      return c.pushTransaction(USER, tx())
    },
  ) // POST documents → 409
  underlag()
  await exchange((s) => void (s.refuseScope = true), async (c) => c.pushTransaction(USER, tx())) // 403 INSUFFICIENT_SCOPE
  await exchange((s) => void (s.forbidden = true), async (c) => c.pushTransaction(USER, tx())) // plain 403 FORBIDDEN
  await exchange((s) => void (s.tooLarge = true), async (c) => c.pushTransaction(USER, tx())) // 400
  await exchange((s) => void (s.storageFailed = true), async (c) => c.pushTransaction(USER, tx())) // 500
  await exchange((s) => void (s.rateLimited = true), async (c) => c.pushTransaction(USER, tx())) // 429
  await exchange(() => undefined, async (c) => c.pushTransaction(USER, tx())) // success again
  // verify must record NOTHING — it answers from Haven's own record.
  repoMocks.getSyncState.mockResolvedValue({ status: 'pushed', external_ref: DOC_REF })
  repoMocks.getConnection.mockResolvedValue({ base_currency: null })
  entryMocks.buildAccountingEntryForPayment.mockResolvedValue({
    amountSek: '10.42',
    fxRates: { SEK: 10.42 },
    amountHuman: '0.001',
  })
  await exchange(() => undefined, async (c) => c.verify(USER, DOC_REF, PAYMENT))
  await exchange(() => undefined, async (c) => c.verify(USER, DOC_REF, `${PAYMENT}-else`))
  await exchange(() => undefined, async (c) => c.verify(USER, 'fortnox:supplierinvoice:123', PAYMENT))
  return requests
}

describe('Accounted outbound allowlist (#3018)', () => {
  it('every recorded request is exactly GET /api/v1/companies or POST /api/v1/companies/{id}/documents — method and path', async () => {
    const requests = await workout()
    // The workout must actually have exercised the connector, or the
    // allowlist is proven over nothing.
    expect(requests.length).toBeGreaterThan(5)
    const allowed = [/^GET \/api\/v1\/companies$/, /^POST \/api\/v1\/companies\/[^/]+\/documents$/]
    for (const r of requests) {
      const line = `${r.method} ${r.path}`
      expect(allowed.some((re) => re.test(line))).toBe(true)
    }
    // The company read happened (the connect-time shape), and so did uploads.
    expect(requests).toContainEqual({ method: 'GET', path: '/api/v1/companies' })
    expect(requests.some((r) => r.method === 'POST' && /\/documents$/.test(r.path))).toBe(true)
  })

  it('no request to /download, journal-entries, supplier-invoices or link — in ANY recorded exchange', async () => {
    const requests = await workout()
    for (const r of requests) {
      expect(r.path).not.toContain('/download')
      expect(r.path).not.toContain('journal-entries')
      expect(r.path).not.toContain('supplier-invoices')
      expect(r.path).not.toContain('/link')
    }
  })

  it('verify records NOTHING — the record-only connector never calls out', async () => {
    repoMocks.getSyncState.mockResolvedValue({ status: 'pushed', external_ref: DOC_REF })
    repoMocks.getConnection.mockResolvedValue({ base_currency: null })
    entryMocks.buildAccountingEntryForPayment.mockResolvedValue(null)
    const { impl, state } = accountedRouter()
    const c = new AccountedConnector(impl)
    await c.verify(USER, DOC_REF, PAYMENT)
    await c.verify(USER, DOC_REF, `${PAYMENT}-else`)
    await c.verify(USER, 'not-a-ref', PAYMENT)
    expect(state.requests).toHaveLength(0)
  })
})
