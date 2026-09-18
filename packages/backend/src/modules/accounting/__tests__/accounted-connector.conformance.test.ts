/**
 * Conformance runner: AccountedConnector against recorded HTTP fixtures
 * (#3018). Same shape as the Fortnox runner: the connector, the generic
 * api-key flow, the orchestrator and the repositories run REAL on the real
 * database; only `fetch` (served from `fixtures/accounted/`, via the shared
 * `accounted-test-router.ts`) is stubbed, and the receipt underlag is a
 * fixed deterministic PDF (the renderer is #498's, proven elsewhere).
 *
 * Capability skips (`connector-conformance.ts`): `capabilities.attachments`
 * and `capabilities.verify` are false on the descriptor and the company read
 * reports `baseCurrency: null`, so cases 3/6, case 4's booking halves and
 * cases 7/7c/7d are skipped BY NAME with printed reasons; case 4b still runs
 * the foreign_invoice / no_invoice_ref halves, and 6b proves the pre-push
 * scope refusal (upload refused → skipped row + connection flip).
 */
import { vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: { accountingFeedAvailable: vi.fn(async () => true), buildAccountingEntryForPayment: vi.fn() },
}))
vi.mock('../../agents/index.js', () => ({ accountingFeedAvailable: mocks.accountingFeedAvailable }))
vi.mock('../entry.js', () => ({ buildAccountingEntryForPayment: mocks.buildAccountingEntryForPayment }))
vi.mock('../receipt-underlag.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../receipt-underlag.js')>()),
  loadReceiptUnderlag: async (_userId: string, tx: { paymentId: string }) => ({
    filename: `haven-receipt-${tx.paymentId}.pdf`,
    pdf: Buffer.from('%PDF-1.4 accounted underlag fixture'),
  }),
}))

import { connectWithApiKey } from '../api-key-flow.js'
import { ACCOUNTED } from '../registry.js'
import { accountingEntry, runConnectorConformance, type ConformanceHarness } from './connector-conformance.js'
import { accountedRouter, ReportingAccountedConnector } from './accounted-test-router.js'

mocks.buildAccountingEntryForPayment.mockImplementation(async (_userId: string, paymentId: string) => accountingEntry(paymentId))

const harness: ConformanceHarness = {
  provider: ACCOUNTED,
  // #3018: the company read exposes no currency — the runner skips the
  // connect-time currency cases for this harness.
  declares: { baseCurrency: false },
  // What a real api-key connect leaves on the row (the single company the
  // fixture key can see, no currency): the push reads the destination
  // company id off the row, so `connectedCase` seeds it the way
  // `applyCompanyInfo` would have.
  company: {
    externalCompanyId: '732b80b7-d0f7-45b9-8083-571f8d28d001',
    name: 'KOMMANDITBOLAGET TESTAREN 3',
    baseCurrency: null,
  },
  async setup({ userId, company }) {
    const { impl, state } = accountedRouter()
    const connector = new ReportingAccountedConnector(impl, company)
    const secrets = { apiKey: 'gnubok_sk_test_conformance' }
    return {
      connector,
      book: () => {}, // case 4's booking half is skipped for this connector
      remove: () => {},
      createCalls: () => state.uploadCalls,
      createPayload: () => state.lastPayload,
      revokeCalls: () => 0,
      refuseInvoiceForScope: (on) => {
        state.refuseScope = on
      },
      secrets,
      connect: async () => {
        await connectWithApiKey({ provider: ACCOUNTED, connector, userId, apiKey: secrets.apiKey })
      },
    }
  },
}

runConnectorConformance('AccountedConnector (recorded fixtures)', harness)
