/**
 * #496 Fortnox feed adapter. The API surface (fetch) and the connection store
 * are mocked; the live sandbox round-trip validates the real API contract
 * (see the #494 open questions — outcomes recorded on the issue).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGetToken, mockGetConn, mockConfigured, mockLoadUnderlag, mockGetSyncState, mockMarkPushed } = vi.hoisted(() => ({
  mockGetToken: vi.fn(),
  mockGetConn: vi.fn(),
  mockConfigured: vi.fn(),
  mockLoadUnderlag: vi.fn(),
  mockGetSyncState: vi.fn(),
  mockMarkPushed: vi.fn(),
}))
vi.mock('../feed-sync.js', () => ({
  getSyncState: (...a: unknown[]) => mockGetSyncState(...a),
  markPushed: (...a: unknown[]) => mockMarkPushed(...a),
}))
vi.mock('../fortnox-connection.js', () => ({
  getValidFortnoxAccessToken: (...a: unknown[]) => mockGetToken(...a),
  getFortnoxConnection: (...a: unknown[]) => mockGetConn(...a),
  fortnoxConfigured: () => mockConfigured(),
}))
vi.mock('../receipt-underlag.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../receipt-underlag.js')>()
  // Only the DB-backed loader is mocked; the pure renderers and the guarded
  // fetch (#956) run REAL so the dual-attach tests exercise them genuinely.
  return { ...actual, loadReceiptUnderlag: (...a: unknown[]) => mockLoadUnderlag(...a) }
})

const {
  FortnoxConnector,
  assertNonAsserting,
  externalInvoiceNumber,
  supplierNameFor,
  feedDescription,
  lateAttachMerchantReceipt,
  verifyFortnoxInvoice,
} = await import('../fortnox-connector.js')

const TX = {
  paymentId: 'pay-123',
  settledAt: '2026-07-15T09:30:00.000Z',
  direction: 'out' as const,
  counterparty: { address: '0x' + 'ab'.repeat(20), name: 'NordShield VPN' },
  resourceUrl: 'https://merchant.example/vpn',
  token: 'USDC',
  amountAtomic: '1000',
  amountSek: '10.42',
  fxRate: '10.42',
  fxSource: 'riksbank',
  fxAt: '2026-07-15T09:30:00.000Z',
  receiptRef: 'receipt-1',
  merchantReceipt: null as { url: string | null; inlineJson: unknown | null } | null,
  suggestedAccount: null as string | null,
}

function fetchStub(handlers: Record<string, (init?: RequestInit) => { status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    calls.push({ url: u, init })
    for (const [needle, handler] of Object.entries(handlers)) {
      if (u.includes(needle)) {
        const { status = 200, body } = handler(init)
        return new Response(JSON.stringify(body), { status })
      }
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
  return { impl, calls }
}

beforeEach(() => {
  mockGetToken.mockReset()
  mockGetConn.mockReset()
  mockConfigured.mockReset()
  mockLoadUnderlag.mockReset()
  mockGetSyncState.mockReset()
  mockMarkPushed.mockReset()
  mockGetToken.mockResolvedValue('token-1')
  mockConfigured.mockReturnValue(true)
  mockLoadUnderlag.mockResolvedValue(null)
})

describe('FortnoxConnector (#496)', () => {
  it('is connected only when configured AND the user has a connection row', async () => {
    mockGetConn.mockResolvedValueOnce({ user_id: 'u1' })
    expect(await new FortnoxConnector().isConnected('u1')).toBe(true)
    mockGetConn.mockResolvedValueOnce(null)
    expect(await new FortnoxConnector().isConnected('u1')).toBe(false)
    mockConfigured.mockReturnValue(false)
    expect(await new FortnoxConnector().isConnected('u1')).toBe(false)
  })

  it('pushes an UNATTESTED supplier invoice — the non-asserting payload', async () => {
    const { impl, calls } = fetchStub({
      '/suppliers?name=': () => ({ body: { Suppliers: [{ SupplierNumber: '42', Name: 'NordShield VPN' }] } }),
      '/supplierinvoices': () => ({ body: { SupplierInvoice: { GivenNumber: 777 } } }),
    })
    const res = await new FortnoxConnector(impl).pushTransaction('u1', TX)
    // No underlag resolved → pushed with an observable degradation note (#498).
    expect(res).toEqual({
      externalRef: 'fortnox:supplierinvoice:777',
      status: 'pushed',
      note: 'receipt not attached: no receipt available for this payment',
    })

    const post = calls.find((c) => c.url.includes('/supplierinvoices'))!
    const payload = JSON.parse(String(post.init?.body)).SupplierInvoice
    // THE invariant: no voucher rows, no account, no VAT — the accountant codes.
    for (const banned of ['SupplierInvoiceRows', 'VAT', 'VATType', 'Account', 'VoucherRows']) {
      expect(payload).not.toHaveProperty(banned)
    }
    expect(payload).toMatchObject({
      SupplierNumber: '42',
      InvoiceDate: '2026-07-15',
      DueDate: '2026-07-15', // already settled — nothing is due
      Total: 10.42,
      Currency: 'SEK',
      ExternalInvoiceNumber: 'HAVEN-pay-123',
    })
    expect(payload.Comments).toMatch(/already settled on-chain/)
    expect(payload.Comments).toMatch(/pay-123/)
  })

  it('handles a Date-typed settledAt (pg timestamptz reality, found live)', async () => {
    const { impl, calls } = fetchStub({
      '/suppliers?name=': () => ({ body: { Suppliers: [{ SupplierNumber: '42', Name: 'NordShield VPN' }] } }),
      '/supplierinvoices': () => ({ body: { SupplierInvoice: { GivenNumber: 780 } } }),
    })
    // Simulate the orchestrator boundary: pg hands Date, the boundary normalizes.
    const { toReportingTransaction } = await import('../reporting-transaction.js')
    const tx = toReportingTransaction({
      ...TX,
      settledAt: new Date('2026-07-16T09:24:00.000Z') as unknown as string,
      fxAt: new Date('2026-07-16T09:24:00.000Z') as unknown as string,
      counterparty: TX.counterparty,
      resourceUrl: TX.resourceUrl,
      account: null,
    } as never)
    // fxAt is the same pg passthrough — normalized at the boundary too, so the
    // #498 underlag renders ISO timestamps, not JS Date strings.
    expect(tx.fxAt).toBe('2026-07-16T09:24:00.000Z')
    const res = await new FortnoxConnector(impl).pushTransaction('u1', tx)
    expect(res.status).toBe('pushed')
    const payload = JSON.parse(
      String(calls.find((c) => c.url.includes('/supplierinvoices'))!.init?.body),
    ).SupplierInvoice
    expect(payload.InvoiceDate).toBe('2026-07-16')
  })

  it('creates the supplier when no exact-name match exists', async () => {
    const { impl, calls } = fetchStub({
      '/suppliers?name=': () => ({ body: { Suppliers: [{ SupplierNumber: '9', Name: 'Other Co' }] } }),
      '/suppliers': (init) =>
        init?.method === 'POST'
          ? { body: { Supplier: { SupplierNumber: '43', Name: 'NordShield VPN' } } }
          : { body: { Suppliers: [] } },
      '/supplierinvoices': () => ({ body: { SupplierInvoice: { GivenNumber: 778 } } }),
    })
    const res = await new FortnoxConnector(impl).pushTransaction('u1', TX)
    expect(res.status).toBe('pushed')
    const createSupplier = calls.find(
      (c) => c.url.endsWith('/suppliers') && c.init?.method === 'POST',
    )!
    const body = JSON.parse(String(createSupplier.init?.body))
    // Minimal supplier record: name only — no org-number or address assertions.
    expect(body).toEqual({ Supplier: { Name: 'NordShield VPN' } })
  })

  it('skips when the user has no valid token (not connected)', async () => {
    mockGetToken.mockResolvedValue(null)
    const res = await new FortnoxConnector(fetchStub({}).impl).pushTransaction('u1', TX)
    expect(res).toEqual({ externalRef: null, status: 'skipped', reason: 'not_connected' })
  })

  it('skips without book-time SEK (source documents need an amount)', async () => {
    const res = await new FortnoxConnector(fetchStub({}).impl).pushTransaction('u1', {
      ...TX,
      amountSek: null,
    })
    expect(res).toEqual({ externalRef: null, status: 'skipped', reason: 'no_sek_amount' })
  })

  it('skips inbound payments (not supplier purchases)', async () => {
    const res = await new FortnoxConnector(fetchStub({}).impl).pushTransaction('u1', {
      ...TX,
      direction: 'in',
    })
    expect(res).toEqual({ externalRef: null, status: 'skipped', reason: 'not_outbound' })
  })

  it('throws FortnoxError on API failure so the orchestrator marks the sync failed', async () => {
    const { impl } = fetchStub({
      '/suppliers?name=': () => ({ body: { Suppliers: [{ SupplierNumber: '42', Name: 'NordShield VPN' }] } }),
      '/supplierinvoices': () => ({ status: 400, body: { message: 'bad' } }),
    })
    await expect(new FortnoxConnector(impl).pushTransaction('u1', TX)).rejects.toThrow(/HTTP 400/)
  })

  it('surfaces the suggested account as a HINT, never as an account field', async () => {
    const { impl, calls } = fetchStub({
      '/suppliers?name=': () => ({ body: { Suppliers: [{ SupplierNumber: '42', Name: 'NordShield VPN' }] } }),
      '/supplierinvoices': () => ({ body: { SupplierInvoice: { GivenNumber: 779 } } }),
    })
    await new FortnoxConnector(impl).pushTransaction('u1', { ...TX, suggestedAccount: '6540' })
    const payload = JSON.parse(
      String(calls.find((c) => c.url.includes('/supplierinvoices'))!.init?.body),
    ).SupplierInvoice
    expect(payload).not.toHaveProperty('Account')
    expect(payload.YourReference).toBe('suggested account 6540')
  })

  it('attaches the receipt underlag: inbox upload + file connection (#498)', async () => {
    mockLoadUnderlag.mockResolvedValue({ filename: 'haven-receipt-pay-123.pdf', pdf: Buffer.from('%PDF-fake') })
    const { impl, calls } = fetchStub({
      '/suppliers?name=': () => ({ body: { Suppliers: [{ SupplierNumber: '42', Name: 'NordShield VPN' }] } }),
      '/supplierinvoicefileconnections': () => ({ body: {} }),
      '/supplierinvoices': () => ({ body: { SupplierInvoice: { GivenNumber: 777 } } }),
      '/inbox': () => ({ body: { File: { Id: 'file-abc' } } }),
    })
    const res = await new FortnoxConnector(impl).pushTransaction('u1', TX)
    // Fully attached — no degradation note.
    expect(res).toEqual({ externalRef: 'fortnox:supplierinvoice:777', status: 'pushed' })

    const upload = calls.find((c) => c.url.endsWith('/inbox'))!
    expect(upload.init?.method).toBe('POST')
    expect(upload.init?.body).toBeInstanceOf(FormData)

    const connect = calls.find((c) => c.url.includes('/supplierinvoicefileconnections'))!
    expect(JSON.parse(String(connect.init?.body))).toEqual({
      SupplierInvoiceFileConnection: { SupplierInvoiceNumber: '777', FileId: 'file-abc' },
    })
  })

  it('a failed receipt LOOKUP degrades to its own note — never "no receipt exists" (#498)', async () => {
    mockLoadUnderlag.mockRejectedValue(new Error('db down'))
    const { impl } = fetchStub({
      '/suppliers?name=': () => ({ body: { Suppliers: [{ SupplierNumber: '42', Name: 'NordShield VPN' }] } }),
      '/supplierinvoices': () => ({ body: { SupplierInvoice: { GivenNumber: 777 } } }),
    })
    const res = await new FortnoxConnector(impl).pushTransaction('u1', TX)
    expect(res.status).toBe('pushed')
    expect(res.externalRef).toBe('fortnox:supplierinvoice:777')
    expect(res.note).toBe('receipt lookup failed: db down')
  })

  it('a failed attachment NEVER fails the push — degrades to a note (#498)', async () => {
    mockLoadUnderlag.mockResolvedValue({ filename: 'haven-receipt-pay-123.pdf', pdf: Buffer.from('%PDF-fake') })
    const { impl } = fetchStub({
      '/suppliers?name=': () => ({ body: { Suppliers: [{ SupplierNumber: '42', Name: 'NordShield VPN' }] } }),
      '/supplierinvoices': () => ({ body: { SupplierInvoice: { GivenNumber: 777 } } }),
      // Pre-widening consent without the inbox scope lands exactly here.
      '/inbox': () => ({ status: 403, body: { ErrorInformation: { message: 'missing scope', code: 2000663 } } }),
    })
    const res = await new FortnoxConnector(impl).pushTransaction('u1', TX)
    expect(res.status).toBe('pushed')
    expect(res.externalRef).toBe('fortnox:supplierinvoice:777')
    expect(res.note).toMatch(/receipt attachment failed/)
    expect(res.note).toMatch(/missing scope/)
  })
})

describe('helpers', () => {
  it('assertNonAsserting throws on forbidden keys', () => {
    expect(() => assertNonAsserting({ Total: 1 })).not.toThrow()
    expect(() => assertNonAsserting({ SupplierInvoiceRows: [] })).toThrow(/non-asserting/)
    expect(() => assertNonAsserting({ VAT: 25 })).toThrow(/non-asserting/)
  })

  it('externalInvoiceNumber is stable and capped at 50 chars', () => {
    expect(externalInvoiceNumber('pay-123')).toBe('HAVEN-pay-123')
    expect(externalInvoiceNumber('x'.repeat(100))).toHaveLength(50)
  })

  it('feedDescription emits only Fortnox-safe characters (live gotcha, error 2000359)', () => {
    const desc = feedDescription(TX)
    expect(desc).not.toMatch(/[·|]/) // the middle dot tripped the sandbox
    expect(desc).not.toMatch(/:\/\//) // full URLs rejected — host only
    expect(desc).toMatch(/merchant\.example/)
    expect(desc).toMatch(/pay-123/)
  })

  it('supplierNameFor falls back from name to truncated address to unknown', () => {
    expect(supplierNameFor(TX)).toBe('NordShield VPN')
    const fallback = supplierNameFor({ ...TX, counterparty: { name: null, address: '0x' + 'ab'.repeat(20) } })
    expect(fallback).toMatch(/^Merchant 0xabab/)
    // Fortnox-safe: no Unicode ellipsis in the Name field (live gotcha 2000359).
    expect(fallback).not.toMatch(/…/)
    expect(supplierNameFor({ ...TX, counterparty: { name: null, address: null } })).toBe('Unknown merchant')
  })
})

describe('merchant receipt dual-attach (#956)', () => {
  const UNDERLAG = { filename: 'haven-receipt-pay-123.pdf', pdf: Buffer.from('%PDF-haven') }

  function stubs(extra: Record<string, (init?: RequestInit) => { status?: number; body: unknown }> = {}) {
    return fetchStub({
      '/suppliers?name=': () => ({ body: { Suppliers: [{ SupplierNumber: '42', Name: 'NordShield VPN' }] } }),
      '/supplierinvoicefileconnections': () => ({ body: {} }),
      '/supplierinvoices': () => ({ body: { SupplierInvoice: { GivenNumber: 900 } } }),
      '/inbox': () => ({ body: { File: { Id: `file-${Math.random().toString(36).slice(2, 6)}` } } }),
      ...extra,
    })
  }

  it('attaches BOTH files when an inline merchant receipt exists — no note', async () => {
    mockLoadUnderlag.mockResolvedValue(UNDERLAG)
    const { impl, calls } = stubs()
    const res = await new FortnoxConnector(impl).pushTransaction('u1', {
      ...TX,
      merchantReceipt: { url: null, inlineJson: { fakturanummer: 'FAK-2026-00001' } },
    })
    expect(res).toEqual({ externalRef: 'fortnox:supplierinvoice:900', status: 'pushed' })
    expect(calls.filter((c) => c.url.endsWith('/inbox')).length).toBe(2)
    expect(calls.filter((c) => c.url.includes('/supplierinvoicefileconnections')).length).toBe(2)
  })

  it('absence of a merchant receipt is the NORMAL case — single attach, no note', async () => {
    mockLoadUnderlag.mockResolvedValue(UNDERLAG)
    const { impl, calls } = stubs()
    const res = await new FortnoxConnector(impl).pushTransaction('u1', { ...TX, merchantReceipt: null })
    expect(res).toEqual({ externalRef: 'fortnox:supplierinvoice:900', status: 'pushed' })
    expect(calls.filter((c) => c.url.endsWith('/inbox')).length).toBe(1)
  })

  it('a failed merchant-receipt URL fetch degrades to a note; evidence attach + push survive', async () => {
    mockLoadUnderlag.mockResolvedValue(UNDERLAG)
    // The receipt URL host resolves through the SAME injected fetchImpl —
    // return 404 for it.
    const { impl, calls } = stubs({ 'merchant.example/receipt.pdf': () => ({ status: 404, body: {} }) })
    const res = await new FortnoxConnector(impl).pushTransaction('u1', {
      ...TX,
      merchantReceipt: { url: 'https://merchant.example/receipt.pdf', inlineJson: null },
    })
    expect(res.status).toBe('pushed')
    expect(res.note).toMatch(/merchant receipt attachment failed/)
    expect(res.note).toMatch(/HTTP 404/)
    // Evidence PDF still attached:
    expect(calls.filter((c) => c.url.endsWith('/inbox')).length).toBe(1)
  })

  it('a private-host receipt URL is refused by the SSRF guard — note, never fetched blind', async () => {
    mockLoadUnderlag.mockResolvedValue(UNDERLAG)
    const { impl, calls } = stubs()
    const res = await new FortnoxConnector(impl).pushTransaction('u1', {
      ...TX,
      merchantReceipt: { url: 'https://169.254.169.254/latest/meta-data', inlineJson: null },
    })
    expect(res.status).toBe('pushed')
    expect(res.note).toMatch(/private or internal/)
    expect(calls.some((c) => c.url.includes('169.254'))).toBe(false)
  })
})

describe('late attach — the x402 timing gap (#956, found live)', () => {
  function lateStubs(extra: Record<string, (init?: RequestInit) => { status?: number; body: unknown }> = {}) {
    return fetchStub({
      '/supplierinvoicefileconnections?limit=500': () => ({
        body: { SupplierInvoiceFileConnections: [{ SupplierInvoiceNumber: '11', Name: 'haven-receipt-x.pdf' }] },
      }),
      '/supplierinvoicefileconnections': () => ({ body: {} }),
      '/inbox': () => ({ body: { File: { Id: 'file-late' } } }),
      ...extra,
    })
  }

  it('attaches retroactively onto the already-pushed invoice', async () => {
    mockGetSyncState.mockResolvedValue({ status: 'pushed', external_ref: 'fortnox:supplierinvoice:11' })
    const { impl, calls } = lateStubs()
    await lateAttachMerchantReceipt('u1', 'pay-late', { url: null, inlineJson: { fakturanummer: 'FAK-9' } }, impl)
    expect(calls.some((c) => c.url.endsWith('/inbox'))).toBe(true)
    const connect = calls.find((c) => c.url.endsWith('/supplierinvoicefileconnections') && c.init?.method === 'POST')!
    expect(JSON.parse(String(connect.init?.body)).SupplierInvoiceFileConnection.SupplierInvoiceNumber).toBe('11')
    expect(mockMarkPushed).not.toHaveBeenCalled()
  })

  it('no-ops when the payment is not pushed yet (in-order flow attaches at push)', async () => {
    mockGetSyncState.mockResolvedValue({ status: 'pending', external_ref: null })
    const { impl, calls } = lateStubs()
    await lateAttachMerchantReceipt('u1', 'pay-late', { url: null, inlineJson: {} }, impl)
    expect(calls.length).toBe(0)
  })

  it('skips when a merchant-receipt file is already connected (race guard)', async () => {
    mockGetSyncState.mockResolvedValue({ status: 'pushed', external_ref: 'fortnox:supplierinvoice:11' })
    const { impl, calls } = lateStubs({
      '/supplierinvoicefileconnections?limit=500': () => ({
        body: { SupplierInvoiceFileConnections: [{ SupplierInvoiceNumber: '11', Name: 'merchant-receipt-x.pdf' }] },
      }),
    })
    await lateAttachMerchantReceipt('u1', 'pay-late', { url: null, inlineJson: {} }, impl)
    expect(calls.some((c) => c.url.endsWith('/inbox'))).toBe(false)
  })

  it('a late-attach failure lands as a note on the sync row, never an error', async () => {
    mockGetSyncState.mockResolvedValue({ status: 'pushed', external_ref: 'fortnox:supplierinvoice:11' })
    const { impl } = lateStubs({ '/inbox': () => ({ status: 500, body: {} }) })
    await lateAttachMerchantReceipt('u1', 'pay-late', { url: null, inlineJson: {} }, impl)
    expect(mockMarkPushed).toHaveBeenCalledWith(
      'u1', 'fortnox', 'pay-late', 'fortnox:supplierinvoice:11',
      expect.stringMatching(/late-attach failed/),
    )
  })
})

// ── #1362: read-back verification — the first READ in a write-only feed ──────

describe('verifyFortnoxInvoice (#1362)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetToken.mockResolvedValue('tok')
  })

  function invoiceStub(invoice: Record<string, unknown> | null, status = 200) {
    return fetchStub({
      '/supplierinvoices/11': () =>
        invoice ? { body: { SupplierInvoice: invoice } } : { status, body: {} },
    })
  }

  const PUSHED = { status: 'pushed', external_ref: 'fortnox:supplierinvoice:11' }

  it('reports registered + not booked for an unattested invoice (the steady state)', async () => {
    mockGetSyncState.mockResolvedValue(PUSHED)
    const { impl } = invoiceStub({
      GivenNumber: 11,
      ExternalInvoiceNumber: externalInvoiceNumber('pay-1'),
      Booked: false,
      Cancelled: false,
      InvoiceDate: '2026-08-12',
      Total: 10.42,
    })
    const result = await verifyFortnoxInvoice('u1', 'pay-1', impl)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.verification).toMatchObject({
        registered: true, booked: false, cancelled: false,
        invoice_number: 11, voucher: null, total: 10.42,
      })
    }
  })

  it('reports booked WITH the voucher reference once a human has accounted for it', async () => {
    mockGetSyncState.mockResolvedValue(PUSHED)
    const { impl } = invoiceStub({
      GivenNumber: 11,
      ExternalInvoiceNumber: externalInvoiceNumber('pay-1'),
      Booked: true,
      VoucherSeries: 'A',
      VoucherNumber: 123,
      VoucherYear: 2026,
    })
    const result = await verifyFortnoxInvoice('u1', 'pay-1', impl)
    expect(result.ok && result.verification.booked).toBe(true)
    if (result.ok) expect(result.verification.voucher).toBe('A123 2026')
  })

  it('a Fortnox 404 is the honest answer registered:false — never an error', async () => {
    mockGetSyncState.mockResolvedValue(PUSHED)
    const { impl } = invoiceStub(null, 404)
    const result = await verifyFortnoxInvoice('u1', 'pay-1', impl)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.verification.registered).toBe(false)
  })

  it('MUTATION PROOF: an invoice number collision (wrong ExternalInvoiceNumber) must NOT read as registered', async () => {
    // The scenario: the user switched Fortnox company, invoice 11 there is
    // someone else's. Removing the ExternalInvoiceNumber cross-check makes
    // this test fail — the belt to the ledger's braces.
    mockGetSyncState.mockResolvedValue(PUSHED)
    const { impl } = invoiceStub({
      GivenNumber: 11,
      ExternalInvoiceNumber: 'HAVEN-someone-elses-payment',
      Booked: true,
    })
    const result = await verifyFortnoxInvoice('u1', 'pay-1', impl)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.verification.registered).toBe(false)
      expect(result.verification.booked).toBeNull()
    }
  })

  it('refuses actionably when the payment is not pushed, has no ref, or Fortnox is disconnected', async () => {
    mockGetSyncState.mockResolvedValue({ status: 'failed', external_ref: null })
    let result = await verifyFortnoxInvoice('u1', 'pay-1')
    expect(result).toMatchObject({ ok: false, error_code: 'not_pushed', status: 'failed' })

    mockGetSyncState.mockResolvedValue({ status: 'pushed', external_ref: 'weird:ref' })
    result = await verifyFortnoxInvoice('u1', 'pay-1')
    expect(result).toMatchObject({ ok: false, error_code: 'no_invoice_ref' })

    mockGetSyncState.mockResolvedValue(PUSHED)
    mockGetToken.mockResolvedValue(null)
    result = await verifyFortnoxInvoice('u1', 'pay-1')
    expect(result).toMatchObject({ ok: false, error_code: 'not_connected' })
  })

  it('is strictly READ-ONLY: a full verification makes no POST and writes nothing', async () => {
    mockGetSyncState.mockResolvedValue(PUSHED)
    const { impl, calls } = invoiceStub({
      GivenNumber: 11,
      ExternalInvoiceNumber: externalInvoiceNumber('pay-1'),
      Booked: false,
    })
    await verifyFortnoxInvoice('u1', 'pay-1', impl)
    expect(calls.every((c) => (c.init?.method ?? 'GET') === 'GET')).toBe(true)
    expect(mockMarkPushed).not.toHaveBeenCalled()
  })
})
