/**
 * Conformance runner: FortnoxConnector against recorded HTTP fixtures
 * (#2862). The connector, the token lifecycle (`fortnox-connection.ts` →
 * generic `oauth-flow.ts`), the orchestrator and the repositories all run
 * REAL on the real database; only `fetch` (served from `fixtures/fortnox/`)
 * is stubbed. Per-case provider state — booked, deleted, the scope error on
 * the file connection — is the router's.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: { accountingFeedAvailable: vi.fn(async () => true), buildAccountingEntryForPayment: vi.fn() },
}))
vi.mock('../../agents/index.js', () => ({ accountingFeedAvailable: mocks.accountingFeedAvailable }))
vi.mock('../entry.js', () => ({ buildAccountingEntryForPayment: mocks.buildAccountingEntryForPayment }))
vi.mock('../../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../config.js')>()
  return {
    ...actual,
    config: {
      ...actual.config,
      fortnoxClientId: 'cid',
      fortnoxClientSecret: 'csecret',
      fortnoxRedirectUri: 'https://api.test/accounting/connections/fortnox/callback',
    },
  }
})
// The underlag loader reads payment evidence the suite does not seed; the
// renderer is irrelevant to the contract. A fixed small PDF makes the
// attachment step RUN so its failure modes are reachable.
vi.mock('../receipt-underlag.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../receipt-underlag.js')>()),
  loadReceiptUnderlag: async () => ({ filename: 'haven-receipt.pdf', pdf: Buffer.from('%PDF-1.4 fixture') }),
}))

import { FortnoxConnector } from '../fortnox-connector.js'
import { fortnoxOAuth2Config, FORTNOX_TOKEN_URL, FORTNOX_API_BASE } from '../fortnox.js'
import { completeOAuth2Connect } from '../oauth-flow.js'
import type { ProviderSecrets } from '../connector.js'
import type { ProviderCompanyInfo } from '../provider.js'
import { FORTNOX } from '../registry.js'
import { accountingEntry, runConnectorConformance, type AttachmentOutcome, type ConformanceHarness } from './connector-conformance.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fortnox')
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))

mocks.buildAccountingEntryForPayment.mockImplementation(async (_userId: string, paymentId: string) => accountingEntry(paymentId))

/**
 * A fetch that answers from the recorded fixtures and tracks the per-case
 * provider state. It patches the two identifiers that vary per case into
 * the recorded bodies (the external invoice number we sent, the booked
 * state) exactly as Fortnox echoes them.
 */
function fortnoxRouter(attachment: AttachmentOutcome) {
  const state = { createCalls: 0, createPayload: null as Record<string, unknown> | null, booked: false, deleted: false, externalInvoiceNumber: '' }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (u === FORTNOX_TOKEN_URL && method === 'POST') return json(fixture('token.json'))
    if (!u.startsWith(FORTNOX_API_BASE)) return json(fixture('error-404.json'), 404)
    const path = u.slice(FORTNOX_API_BASE.length)

    if (path === '/companyinformation') return json(fixture('companyinformation.json'))
    if (path.startsWith('/suppliers?name=')) return json(fixture('suppliers-search-empty.json'))
    if (path === '/suppliers' && method === 'POST') return json(fixture('supplier-created.json'))
    if (path === '/supplierinvoices' && method === 'POST') {
      state.createCalls += 1
      const payload = (JSON.parse(String(init?.body)) as { SupplierInvoice: Record<string, unknown> }).SupplierInvoice
      state.createPayload = payload
      state.externalInvoiceNumber = String(payload.ExternalInvoiceNumber)
      const body = fixture('supplierinvoice-created.json') as { SupplierInvoice: Record<string, unknown> }
      body.SupplierInvoice.ExternalInvoiceNumber = state.externalInvoiceNumber
      return json(body)
    }
    if (path === '/inbox' && method === 'POST') {
      return attachment === 'fail' ? json({ ErrorInformation: { error: 1, message: 'Internt fel.', code: 2000000 } }, 500) : json(fixture('inbox-upload.json'))
    }
    if (path === '/supplierinvoicefileconnections' && method === 'POST') {
      return attachment === 'scope_missing' ? json(fixture('fileconnection-scope-error.json'), 400) : json(fixture('fileconnection-created.json'))
    }
    if (path === '/supplierinvoices/777' && method === 'GET') {
      if (state.deleted) return json(fixture('error-404.json'), 404)
      const body = fixture(state.booked ? 'supplierinvoice-get-booked.json' : 'supplierinvoice-get.json') as { SupplierInvoice: Record<string, unknown> }
      body.SupplierInvoice.ExternalInvoiceNumber = state.externalInvoiceNumber
      return json(body)
    }
    return json(fixture('error-404.json'), 404)
  }) as typeof fetch
  return { impl, state }
}

/** Lets a case override what Fortnox reports — Fortnox itself books in SEK by construction. */
class ReportingFortnoxConnector extends FortnoxConnector {
  constructor(fetchImpl: typeof fetch, private readonly company: Partial<ProviderCompanyInfo> | undefined) {
    super(fetchImpl)
  }
  override async getCompanyInfo(secrets: ProviderSecrets): Promise<ProviderCompanyInfo> {
    const real = await super.getCompanyInfo(secrets)
    return { ...real, ...(this.company ?? {}) }
  }
}

const harness: ConformanceHarness = {
  provider: FORTNOX,
  async setup({ userId, ...opts }) {
    const { impl, state } = fortnoxRouter(opts.attachment ?? 'ok')
    const connector = new ReportingFortnoxConnector(impl, opts.company)
    const secrets = { accessToken: 'fx-access-stored', refreshToken: 'fx-refresh-stored', tokenType: 'Bearer', scope: 'bookkeeping' }
    return {
      connector,
      book: () => { state.booked = true },
      remove: () => { state.deleted = true },
      createCalls: () => state.createCalls,
      createPayload: () => state.createPayload,
      revokeCalls: () => 0, // Fortnox declares revoke: false — the suite asserts it is never called
      secrets,
      connect: async () => {
        await completeOAuth2Connect({
          provider: FORTNOX,
          cfg: fortnoxOAuth2Config({ clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://api.test/cb' }),
          connector,
          userId,
          code: 'auth-code',
          fetchImpl: impl,
        })
      },
    }
  },
}

runConnectorConformance('FortnoxConnector (recorded fixtures)', harness)
