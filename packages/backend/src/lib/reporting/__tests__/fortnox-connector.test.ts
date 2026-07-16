/**
 * #496 Fortnox feed adapter. The API surface (fetch) and the connection store
 * are mocked; the live sandbox round-trip validates the real API contract
 * (see the #494 open questions — outcomes recorded on the issue).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockGetToken, mockGetConn, mockConfigured } = vi.hoisted(() => ({
  mockGetToken: vi.fn(),
  mockGetConn: vi.fn(),
  mockConfigured: vi.fn(),
}))
vi.mock('../../fortnox-connection.js', () => ({
  getValidFortnoxAccessToken: (...a: unknown[]) => mockGetToken(...a),
  getFortnoxConnection: (...a: unknown[]) => mockGetConn(...a),
  fortnoxConfigured: () => mockConfigured(),
}))

const {
  FortnoxConnector,
  assertNonAsserting,
  externalInvoiceNumber,
  supplierNameFor,
  feedDescription,
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
  mockGetToken.mockResolvedValue('token-1')
  mockConfigured.mockReturnValue(true)
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
    expect(res).toEqual({ externalRef: 'fortnox:supplierinvoice:777', status: 'pushed' })

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
    expect(supplierNameFor({ ...TX, counterparty: { name: null, address: '0x' + 'ab'.repeat(20) } })).toMatch(
      /^Merchant 0xabab/,
    )
    expect(supplierNameFor({ ...TX, counterparty: { name: null, address: null } })).toBe('Unknown merchant')
  })
})
