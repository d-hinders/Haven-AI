/**
 * Conformance runner: InMemoryConnector (#2862). The reference connector —
 * if the suite cannot pass here, the suite is wrong, not the connector.
 */
import { vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: { accountingFeedAvailable: vi.fn(async () => true), buildAccountingEntryForPayment: vi.fn() },
}))
vi.mock('../../agents/index.js', () => ({ accountingFeedAvailable: mocks.accountingFeedAvailable }))
vi.mock('../entry.js', () => ({ buildAccountingEntryForPayment: mocks.buildAccountingEntryForPayment }))

import { connectWithApiKey } from '../api-key-flow.js'
import { InMemoryConnector } from '../connector.js'
import type { AccountingProvider } from '../provider.js'
import { accountingEntry, runConnectorConformance, type ConformanceHarness } from './connector-conformance.js'

const MEMORY: AccountingProvider = {
  id: 'memory',
  displayName: 'Memory',
  authKind: 'api_key',
  capabilities: { attachments: true, verify: true, revoke: true, companyInfo: true },
  availability: 'live',
  requiredScopes: [],
}

mocks.buildAccountingEntryForPayment.mockImplementation(async (_userId: string, paymentId: string) => accountingEntry(paymentId))

const harness: ConformanceHarness = {
  provider: MEMORY,
  async setup({ userId, ...opts }) {
    const connector = new InMemoryConnector()
    connector.attachmentOutcome = opts.attachment ?? 'ok'
    if (opts.company) connector.companyInfo = { ...connector.companyInfo, ...opts.company }
    connector.connect(userId)
    const secrets = { apiKey: 'memory-key' }
    return {
      connector,
      book: (ref) => connector.markBooked(ref),
      remove: (ref) => connector.deleteInvoice(ref),
      createCalls: () => connector.pushed.length,
      createPayload: () => (connector.pushed.at(-1)?.tx as unknown as Record<string, unknown>) ?? null,
      revokeCalls: () => connector.revoked.length,
      refuseInvoiceForScope: (on) => { connector.invoiceOutcome = on ? 'scope_missing' : 'ok' },
      secrets,
      connect: async () => {
        await connectWithApiKey({ provider: MEMORY, connector, userId, apiKey: secrets.apiKey })
      },
    }
  },
}

runConnectorConformance('InMemoryConnector', harness)
