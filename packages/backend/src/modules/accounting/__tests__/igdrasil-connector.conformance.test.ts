/**
 * Conformance runner: IgdrasilConnector against hand-authored HTTP fixtures
 * (#4518, epic #2875). The connector, the generic OAuth2 flow (PKCE on), the
 * orchestrator and the repositories run REAL on the real database; only
 * `fetch` (the shared `igdrasil-test-router.ts`, fixtures from Igdrasil's
 * published OpenAPI) and the receipt underlag are stubbed. The underlag's
 * bytes carry the payment id, as the real renderer's do: Igdrasil keys a
 * document on its bytes, so two payments must never render the same file.
 *
 * Capability skips (`connector-conformance.ts`): `attachments` and `verify`
 * are false and the company read reports `baseCurrency: null`, so cases 3/6,
 * case 4's booking halves and cases 7/7b/7c/7d are skipped BY NAME with
 * printed reasons — the same set as Accounted. Case 5 runs with revoke
 * declared (one `/oauth/revoke` call on disconnect); 6b proves the pre-push
 * scope refusal through the real `insufficient_scope` 403.
 */
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
      igdrasilClientId: 'igd_app_fixture',
      igdrasilClientSecret: 'igd_cs_fixture',
      igdrasilRedirectUri: 'https://api.test/accounting/connections/igdrasil/callback',
    },
  }
})
vi.mock('../receipt-underlag.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../receipt-underlag.js')>()),
  loadReceiptUnderlag: async (_userId: string, tx: { paymentId: string }) => ({
    filename: `haven-receipt-${tx.paymentId}.pdf`,
    pdf: Buffer.from(`%PDF-1.4 igdrasil underlag fixture ${tx.paymentId}`),
  }),
}))

import { igdrasilOAuth2Config } from '../igdrasil.js'
import { completeOAuth2Connect } from '../oauth-flow.js'
import { pkceVerifierFor } from '../oauth-pkce.js'
import { IGDRASIL } from '../registry.js'
import { accountingEntry, runConnectorConformance, type ConformanceHarness } from './connector-conformance.js'
import { IGDRASIL_COMPANY_ID, igdrasilRouter, ReportingIgdrasilConnector } from './igdrasil-test-router.js'

mocks.buildAccountingEntryForPayment.mockImplementation(async (_userId: string, paymentId: string) => accountingEntry(paymentId))

const harness: ConformanceHarness = {
  provider: IGDRASIL,
  // `PublicCompany` has no currency field — the currency cases skip.
  declares: { baseCurrency: false },
  // What the generic connect leaves on the row: the one company the grant reaches.
  company: { externalCompanyId: IGDRASIL_COMPANY_ID, name: 'Testbolaget Igdrasil AB', baseCurrency: null },
  async setup({ userId, company }) {
    const { impl, state } = igdrasilRouter()
    const connector = new ReportingIgdrasilConnector(impl, company)
    const secrets = { accessToken: 'igd_oat_stored', refreshToken: 'igd_ort_stored', tokenType: 'Bearer', scope: 'companies:read vouchers:write' }
    return {
      connector,
      book: () => {}, // case 4's booking half is skipped for this connector
      remove: () => {},
      createCalls: () => state.uploadCalls,
      createPayload: () => state.lastPayload,
      revokeCalls: () => state.revokeCalls,
      refuseInvoiceForScope: (on) => {
        state.refuseScope = on
      },
      secrets,
      connect: async () => {
        await completeOAuth2Connect({
          provider: IGDRASIL,
          cfg: igdrasilOAuth2Config({ clientId: 'igd_app_fixture', clientSecret: 'igd_cs_fixture', redirectUri: 'https://api.test/cb' }),
          connector,
          userId,
          code: 'auth-code',
          pkceVerifier: pkceVerifierFor('conformance-jti', 'conformance-key'),
          fetchImpl: impl,
        })
      },
    }
  },
}

runConnectorConformance('IgdrasilConnector (OpenAPI fixtures)', harness)
