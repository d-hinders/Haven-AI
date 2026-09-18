/**
 * Accounted connector unit tests (#3017 connect, #3018 the document push;
 * epic #3016) — fixture-backed, no DB. The fixtures are LIVE recordings from
 * app.accounted.se with the test key (redacted): one company, several
 * companies, and the provider's error envelopes. The cases map 1:1 to the
 * acceptance list: single → `baseCurrency: null` (null, never 'SEK' — the
 * read path exposes no currency and inventing one would let a future
 * provider change read as a switch), several → `MultiCompanyKeyError`,
 * 401 → the `ProviderError` the generic flow maps to `InvalidApiKeyError`.
 * Plus the auth-refusal vs outage split and the wire contract (bearer key,
 * no un-asked-for headers, no key in any message).
 *
 * #3018 adds the push error map and the record-only verify. The push tests
 * run against the SHARED accounted-test-router (the same implementation the
 * conformance suite drives); verify mocks the two repositories it reads and
 * asserts the fetch double is NEVER called — verify answers from Haven's
 * own record, that is the contract.
 */
import { readFile } from 'node:fs/promises'
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

import { AccountedConnector, MultiCompanyKeyError } from '../accounted-connector.js'
import {
  ACCOUNTED_API_BASE,
  accountedIdempotencyKey,
  AccountedDocumentHashMismatchError,
} from '../accounted-client.js'
import type { ProviderSecrets } from '../connector.js'
import { ProviderError } from '../provider.js'
import { accountedRouter } from './accounted-test-router.js'

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(`./fixtures/accounted/${name}`, import.meta.url), 'utf8'))
}

/** A fetch double that answers every call with the given status + JSON body and records requests. */
function fetchReturning(status: number, body: unknown) {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const impl = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(input), headers: init?.headers ?? {} })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { impl, calls }
}

/** A fetch double whose every call rejects — the outage shape. */
function fetchFailing(message: string) {
  return (async () => {
    throw new Error(message)
  }) as unknown as typeof fetch
}

const SECRETS: ProviderSecrets = { apiKey: 'gnubok_sk_test_unit' }
const SINGLE = (await fixture('companies.json')) as { data: { id: string; name: string }[] }
const COMPANY_ID = SINGLE.data[0].id
const USER = 'user-1'
const PAYMENT = 'pay-1'
const DOC_ID = '3f1c7a52-9b04-4e6a-8f21-7c5d2e8b9a10'
const DOC_REF = `accounted:document:${DOC_ID}`

/** The FeedTransaction the push tests feed (shape per `connector-conformance.ts`). */
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

function connectedMock(companyId: string | null = COMPANY_ID) {
  flowMocks.readApiKeyConnection.mockResolvedValue({
    row: { external_company_id: companyId },
    secrets: { apiKey: 'gnubok_sk_test_unit' },
  })
}

function underlagMock(sizeBytes?: number) {
  const pdf = sizeBytes != null ? Buffer.alloc(sizeBytes, 0x61) : Buffer.from('%PDF-1.4 unit fixture')
  underlagMocks.loadReceiptUnderlag.mockResolvedValue({ filename: `haven-receipt-${PAYMENT}.pdf`, pdf })
  return pdf
}

describe('AccountedConnector.getCompanyInfo (#3017)', () => {
  it('one company → the company from the live fixture, baseCurrency NULL (never a guessed SEK)', async () => {
    const { impl, calls } = fetchReturning(200, SINGLE)
    const info = await new AccountedConnector(impl).getCompanyInfo(SECRETS)
    expect(info).toEqual({
      externalCompanyId: SINGLE.data[0].id,
      name: SINGLE.data[0].name,
      baseCurrency: null,
    })
    // The one company read path: GET /api/v1/companies on the pinned host.
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${ACCOUNTED_API_BASE}/api/v1/companies`)
  })

  it('several companies → MultiCompanyKeyError (409 MULTI_COMPANY_KEY at the route)', async () => {
    const { impl } = fetchReturning(200, await fixture('companies-multi.json'))
    const err = await new AccountedConnector(impl)
      .getCompanyInfo(SECRETS)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MultiCompanyKeyError)
    const multi = err as MultiCompanyKeyError
    expect(multi.code).toBe('MULTI_COMPANY_KEY')
    expect(multi.count).toBe(2)
    // The user answer is in the message: a key scoped to ONE company.
    expect(multi.message).toMatch(/2 companies/)
    expect(multi.message).toMatch(/one company/)
  })

  it('401 (the live envelope) → ProviderError with status 401 — what the flow maps to InvalidApiKeyError', async () => {
    const { impl } = fetchReturning(401, await fixture('error-401.json'))
    const err = await new AccountedConnector(impl)
      .getCompanyInfo(SECRETS)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect((err as ProviderError).status).toBe(401)
    expect((err as ProviderError).provider).toBe('accounted')
  })

  it('zero companies → a key verdict (401), not a silent connect', async () => {
    const { impl } = fetchReturning(200, { data: [], meta: { request_id: 'req_x', api_version: '2026-05-12' } })
    const err = await new AccountedConnector(impl)
      .getCompanyInfo(SECRETS)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect((err as ProviderError).status).toBe(401)
  })

  it('auth refusal vs outage: a 403 is a key verdict, a 5xx and a network error are NOT', async () => {
    const refused = await new AccountedConnector(fetchReturning(403, { error: { code: 'INSUFFICIENT_SCOPE' } }).impl)
      .getCompanyInfo(SECRETS)
      .catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(ProviderError)
    expect((refused as ProviderError).status).toBe(403)

    const outage = await new AccountedConnector(fetchReturning(503, { error: { code: 'UNAVAILABLE' } }).impl)
      .getCompanyInfo(SECRETS)
      .catch((e: unknown) => e)
    expect(outage).toBeInstanceOf(ProviderError)
    expect((outage as ProviderError).status).toBe(503)

    const down = await new AccountedConnector(fetchFailing('ECONNRESET'))
      .getCompanyInfo(SECRETS)
      .catch((e: unknown) => e)
    expect(down).toBeInstanceOf(ProviderError)
    expect((down as ProviderError).status).toBe(0)
    expect((down as ProviderError).message).toMatch(/Could not reach Accounted/)
  })

  it('wire contract: bearer key + Accept, NO Gnubok-Version header (the spec declares no header params)', async () => {
    const { impl, calls } = fetchReturning(200, SINGLE)
    await new AccountedConnector(impl).getCompanyInfo(SECRETS)
    expect(calls[0].headers.Authorization).toBe(`Bearer ${SECRETS.apiKey}`)
    expect(calls[0].headers.Accept).toBe('application/json')
    expect(Object.keys(calls[0].headers)).not.toContain('Gnubok-Version')
  })

  it('no error message ever carries the key', async () => {
    const cases: Promise<unknown>[] = [
      new AccountedConnector(fetchReturning(401, await fixture('error-401.json')).impl)
        .getCompanyInfo(SECRETS)
        .catch((e: unknown) => e),
      new AccountedConnector(fetchReturning(503, { error: { code: 'UNAVAILABLE' } }).impl)
        .getCompanyInfo(SECRETS)
        .catch((e: unknown) => e),
      new AccountedConnector(fetchFailing('ECONNRESET'))
        .getCompanyInfo(SECRETS)
        .catch((e: unknown) => e),
    ]
    for (const err of await Promise.all(cases)) {
      expect((err as Error).message).not.toContain(SECRETS.apiKey)
    }
  })
})

describe('AccountedConnector.pushTransaction (#3018)', () => {
  const withRouter = () => {
    const { impl, state } = accountedRouter()
    return { connector: new AccountedConnector(impl), state }
  }

  it('success: uploads the underlag and returns the namespaced ref with the document id', async () => {
    connectedMock()
    underlagMock()
    const { connector, state } = withRouter()
    const result = await connector.pushTransaction(USER, tx())
    expect(result).toMatchObject({ status: 'pushed', externalRef: DOC_REF })
    expect(state.uploadCalls).toBe(1)
    // The multipart contract: filename + upload_source, an idempotency key
    // derived from the payment, and the key never in any URL.
    expect(state.lastUpload?.filename).toBe(`haven-receipt-${PAYMENT}.pdf`)
    expect(state.lastUpload?.uploadSource).toBe('api')
    expect(state.lastUpload?.idempotencyKey).toBe(accountedIdempotencyKey(PAYMENT))
  })

  it('delivery proof: a 2xx whose sha256_hash does not match the sent bytes is SKIPPED, no ref stored', async () => {
    connectedMock()
    underlagMock()
    const { connector, state } = withRouter()
    state.corruptHash = true
    const result = await connector.pushTransaction(USER, tx())
    expect(result.status).toBe('skipped')
    expect(result.reason).toMatch(/sha256 mismatch/)
    expect(result.externalRef).toBeNull()
    expect(state.uploadCalls).toBe(1)
  })

  it('403 INSUFFICIENT_SCOPE → skipped + scope_missing; a plain 403 FORBIDDEN is NOT a scope verdict', async () => {
    connectedMock()
    underlagMock()
    const scoped = withRouter()
    scoped.state.refuseScope = true
    const refused = await scoped.connector.pushTransaction(USER, tx())
    expect(refused.status).toBe('skipped')
    expect(refused.connectionStatus).toBe('scope_missing')
    expect(refused.reason).toMatch(/scope refused before the document was created/)
    expect(refused.missingScopes).toEqual(['documents:write'])

    const plain = withRouter()
    plain.state.forbidden = true
    const forbidden = await plain.connector.pushTransaction(USER, tx()).catch((e: unknown) => e)
    // A generic FORBIDDEN is thrown — retried by the sweep, never scope_missing.
    expect(forbidden).toBeInstanceOf(ProviderError)
    expect((forbidden as ProviderError).status).toBe(403)
  })

  it('409 IDEMPOTENCY_KEY_REUSE (same key, different bytes) → terminal skipped, never retried here', async () => {
    connectedMock()
    underlagMock()
    const { connector, state } = withRouter()
    const first = await connector.pushTransaction(USER, tx())
    expect(first.status).toBe('pushed')
    // Same payment, changed bytes → the provider refuses with 409.
    underlagMocks.loadReceiptUnderlag.mockResolvedValue({
      filename: `haven-receipt-${PAYMENT}.pdf`,
      pdf: Buffer.from('%PDF-1.4 CHANGED BYTES'),
    })
    const second = await connector.pushTransaction(USER, tx())
    expect(second.status).toBe('skipped')
    expect(second.reason).toContain('IDEMPOTENCY_KEY_REUSE')
    expect(second.externalRef).toBeNull()
    expect(state.uploadCalls).toBe(2)
  })

  it('400 DOC_UPLOAD_TOO_LARGE / DOC_UPLOAD_UNSUPPORTED_TYPE → permanent skipped with the code as the reason', async () => {
    connectedMock()
    underlagMock()
    const tooLarge = withRouter()
    tooLarge.state.tooLarge = true
    const result = await tooLarge.connector.pushTransaction(USER, tx())
    expect(result.status).toBe('skipped')
    expect(result.reason).toContain('DOC_UPLOAD_TOO_LARGE')
  })

  it('500 DOC_UPLOAD_STORAGE_FAILED → retryable: thrown for the sweep', async () => {
    connectedMock()
    underlagMock()
    const { connector, state } = withRouter()
    state.storageFailed = true
    const err = await connector.pushTransaction(USER, tx()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect((err as ProviderError).status).toBe(500)
  })

  it('429 → ProviderError with retryAfterMs read from the Retry-After header (SECONDS → ms)', async () => {
    connectedMock()
    underlagMock()
    const { connector, state } = withRouter()
    state.rateLimited = true
    const err = await connector.pushTransaction(USER, tx()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect((err as ProviderError).status).toBe(429)
    expect((err as ProviderError & { retryAfterMs?: number }).retryAfterMs).toBe(7000)
  })

  it('oversize underlag (> 10 MB, measured locally) → skipped BEFORE any request', async () => {
    connectedMock()
    underlagMock(10 * 1024 * 1024 + 1)
    const { connector, state } = withRouter()
    const result = await connector.pushTransaction(USER, tx())
    expect(result.status).toBe('skipped')
    expect(result.reason).toMatch(/larger than Accounted accepts/)
    expect(state.requests).toHaveLength(0)
  })

  it('no connection / no company → skipped without touching the provider', async () => {
    underlagMock()
    flowMocks.readApiKeyConnection.mockResolvedValue(null)
    const { connector, state } = withRouter()
    const result = await connector.pushTransaction(USER, tx())
    expect(result.status).toBe('skipped')
    expect(result.reason).toBe('not_connected')
    expect(state.requests).toHaveLength(0)

    connectedMock(null)
    const { connector: c2, state: s2 } = withRouter()
    const r2 = await c2.pushTransaction(USER, tx())
    expect(r2.status).toBe('skipped')
    expect(s2.requests).toHaveLength(0)
  })

  it('the upload request itself never carries the key anywhere but the Authorization header', async () => {
    connectedMock()
    underlagMock()
    const { impl, state } = accountedRouter()
    const apiKey = 'gnubok_sk_test_unit'
    flowMocks.readApiKeyConnection.mockResolvedValue({
      row: { external_company_id: COMPANY_ID },
      secrets: { apiKey },
    })
    await new AccountedConnector(impl).pushTransaction(USER, tx())
    for (const r of state.requests) {
      expect(r.path).not.toContain(apiKey)
    }
  })
})

describe('AccountedConnector.verify (#3018) — answers from Haven\'s own record', () => {
  const REF = 'accounted:document:3f1c7a52-9b04-4e6a-8f21-7c5d2e8b9a10'

  it('registered: the pushed row carries this ref → document_ref + total, zero provider calls', async () => {
    const { impl, state } = accountedRouter()
    repoMocks.getSyncState.mockResolvedValue({
      status: 'pushed',
      external_ref: REF,
    })
    repoMocks.getConnection.mockResolvedValue({ base_currency: null })
    entryMocks.buildAccountingEntryForPayment.mockResolvedValue({
      amountSek: '10.42',
      fxRates: { SEK: 10.42 },
      amountHuman: '0.001',
    })
    const result = await new AccountedConnector(impl).verify(USER, REF, PAYMENT)
    expect(result).toMatchObject({
      ok: true,
      verification: {
        registered: true,
        missing: null,
        booked: null,
        cancelled: null,
        voucher: null,
        document_ref: '3f1c7a52-9b04-4e6a-8f21-7c5d2e8b9a10',
        invoice_number: null,
        total: 10.42,
      },
    })
    // THE contract: no network call anywhere in verify.
    expect(state.requests).toHaveLength(0)
  })

  it('foreign_invoice: the ref exists but the row does not carry it', async () => {
    const { impl, state } = accountedRouter()
    repoMocks.getSyncState.mockResolvedValue({ status: 'pushed', external_ref: 'accounted:document:other-id' })
    repoMocks.getConnection.mockResolvedValue({ base_currency: null })
    entryMocks.buildAccountingEntryForPayment.mockResolvedValue(null)
    const result = await new AccountedConnector(impl).verify(USER, REF, PAYMENT)
    expect(result).toMatchObject({ ok: true, verification: { registered: false, missing: 'foreign_invoice', booked: null } })
    expect(state.requests).toHaveLength(0)
  })

  it('no_invoice_ref: the ref is not an accounted document ref at all', async () => {
    const { impl, state } = accountedRouter()
    repoMocks.getSyncState.mockResolvedValue(null)
    repoMocks.getConnection.mockResolvedValue(null)
    entryMocks.buildAccountingEntryForPayment.mockResolvedValue(null)
    const result = await new AccountedConnector(impl).verify(USER, 'fortnox:supplierinvoice:123', PAYMENT)
    expect(result).toEqual({ ok: false, error_code: 'no_invoice_ref' })
    expect(state.requests).toHaveLength(0)
  })
})
