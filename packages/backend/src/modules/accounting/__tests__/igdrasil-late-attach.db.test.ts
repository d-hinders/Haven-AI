/**
 * Igdrasil late attach on the REAL database (#4521, epic #2875) — the
 * Accounted #3918 shape: the x402 feed pushes the underlag at funding
 * confirmation, and the merchant's own receipt arrives at the settle retry
 * seconds later. The capture route then calls
 * `lateAttachIgdrasilMerchantReceipt`, which uploads the receipt as a second
 * document and records its `merchant-invoice` sync row — only when an
 * Igdrasil underlag row for that payment is already pushed.
 *
 * Real: the orchestrator (`feedSettledPayment`), the generic OAuth2 connect
 * (PKCE on), the token store and every sync-ledger repository. Stubbed: only
 * `fetch` (the shared `igdrasil-test-router.ts`), the accounting entry and the
 * receipt underlag (a fixed PDF; the renderer's determinism is
 * `igdrasil-feed.db.test.ts`).
 */
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'

const { mocks, underlagMocks } = vi.hoisted(() => ({
  mocks: { accountingFeedAvailable: vi.fn(async () => true), buildAccountingEntryForPayment: vi.fn() },
  underlagMocks: { loadReceiptUnderlag: vi.fn() },
}))
vi.mock('../../agents/index.js', () => ({ accountingFeedAvailable: mocks.accountingFeedAvailable }))
vi.mock('../entry.js', () => ({ buildAccountingEntryForPayment: mocks.buildAccountingEntryForPayment }))
vi.mock('../receipt-underlag.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../receipt-underlag.js')>()),
  loadReceiptUnderlag: underlagMocks.loadReceiptUnderlag,
}))
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

import { randomBytes } from 'node:crypto'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { SECRETS_KEY_ENV } from '../../../infra/secrets.js'
import { getMerchantInvoiceSyncRef, getSyncState, markFailed } from '../../../infra/repositories/accounting-feed-syncs.js'
import { clearConnectors, registerConnector } from '../connector.js'
import { feedSettledPayment } from '../feed-orchestrator.js'
import { IgdrasilConnector, lateAttachIgdrasilMerchantReceipt } from '../igdrasil-connector.js'
import { igdrasilOAuth2Config } from '../igdrasil.js'
import { completeOAuth2Connect } from '../oauth-flow.js'
import { pkceVerifierFor } from '../oauth-pkce.js'
import { IGDRASIL } from '../registry.js'
import { accountingEntry } from './connector-conformance.js'
import { IGDRASIL_DOCUMENT_ID, IGDRASIL_MERCHANT_DOCUMENT_ID, igdrasilRouter } from './igdrasil-test-router.js'

const KEY = randomBytes(32).toString('base64')
const UNDERLAG_REF = `igdrasil:document:${IGDRASIL_DOCUMENT_ID}`
const RECEIPT = { url: null, inlineJson: { fakturanummer: 'FAK-4521-1', saljare: { name: 'Haven Demo AB' } } }

let seq = 0
async function seedUser(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(`INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`, [
    `igdrasil-late-attach-${++seq}-${Date.now()}@test.example`,
  ])
  return rows[0].id
}

mocks.buildAccountingEntryForPayment.mockImplementation(async (_userId: string, paymentId: string) => accountingEntry(paymentId))
underlagMocks.loadReceiptUnderlag.mockImplementation(async (_userId: string, tx: { paymentId: string }) => ({
  filename: `haven-receipt-${tx.paymentId}.pdf`,
  pdf: Buffer.from(`%PDF-1.4 igdrasil late attach fixture ${tx.paymentId}`),
}))

describeDb('Igdrasil late attach of a merchant receipt captured after the push (#4521)', () => {
  beforeAll(initDbHarness)
  beforeEach(async () => {
    await resetDb()
    clearConnectors()
    process.env[SECRETS_KEY_ENV] = KEY
  })
  afterEach(() => {
    delete process.env[SECRETS_KEY_ENV]
  })

  /** A user with a REAL OAuth2 connection, and the router whose fetch the connector and the late attach share. */
  async function connected() {
    const userId = await seedUser()
    const router = igdrasilRouter()
    const connector = new IgdrasilConnector(router.impl)
    registerConnector(connector)
    await completeOAuth2Connect({
      provider: IGDRASIL,
      cfg: igdrasilOAuth2Config({ clientId: 'igd_app_fixture', clientSecret: 'igd_cs_fixture', redirectUri: 'https://api.test/cb' }),
      connector,
      userId,
      code: 'auth-code',
      pkceVerifier: pkceVerifierFor('late-attach-jti', 'late-attach-key'),
      fetchImpl: router.impl,
    })
    // The fixture entry settles at a fixed timestamp; a first connect stamps
    // feed_from = now, above it. Clear the floor, as the Accounted suite does.
    await db.query(`UPDATE accounting_connections SET feed_from = NULL WHERE user_id = $1`, [userId])
    return { userId, state: router.state, impl: router.impl }
  }

  it('a receipt captured after the push is uploaded once as the second document and recorded; a repeat is a no-op', async () => {
    const { userId, state, impl } = await connected()
    const pid = `pay-igd-late-${seq}-1`

    // Push WITHOUT the receipt (the normal x402 order).
    expect(await feedSettledPayment(userId, pid)).toEqual({ outcome: 'pushed' })
    expect((await getSyncState(userId, 'igdrasil', pid))?.external_ref).toBe(UNDERLAG_REF)
    expect(state.uploadCalls).toBe(1)
    expect(await getMerchantInvoiceSyncRef(userId, 'igdrasil', pid)).toBeNull()

    await lateAttachIgdrasilMerchantReceipt(userId, pid, RECEIPT, impl)
    expect(state.uploadCalls).toBe(2)
    expect(state.uploads.at(-1)?.parts).toEqual(['file'])
    expect(await getMerchantInvoiceSyncRef(userId, 'igdrasil', pid)).toBe(`igdrasil:document:${IGDRASIL_MERCHANT_DOCUMENT_ID}`)
    // The underlag row is untouched: same ref, still pushed, no note.
    const underlag = await getSyncState(userId, 'igdrasil', pid)
    expect(underlag).toMatchObject({ status: 'pushed', external_ref: UNDERLAG_REF, error: null })

    // A duplicate report makes no request at all — the recorded row stops it first.
    const requestsBefore = state.requests.length
    await lateAttachIgdrasilMerchantReceipt(userId, pid, { url: null, inlineJson: { fakturanummer: 'FAK-4521-2' } }, impl)
    expect(state.requests.length).toBe(requestsBefore)

    // The underlag row failing later never rewrites the merchant-invoice row.
    await markFailed(userId, 'igdrasil', pid, 'provider outage')
    expect(await getMerchantInvoiceSyncRef(userId, 'igdrasil', pid)).toBe(`igdrasil:document:${IGDRASIL_MERCHANT_DOCUMENT_ID}`)
  })

  it('a payment not pushed to Igdrasil makes no Igdrasil request and records nothing', async () => {
    // MUTATION TARGET: remove the "own pushed row" guard in
    // `lateAttachIgdrasilMerchantReceipt` and both calls below reach Igdrasil.
    const { userId, state, impl } = await connected()
    const pid = `pay-igd-late-${seq}-2`
    const requestsBefore = state.requests.length

    // No sync row at all: the payment never went to Igdrasil.
    await lateAttachIgdrasilMerchantReceipt(userId, pid, RECEIPT, impl)
    expect(state.requests.length).toBe(requestsBefore)
    expect(await getMerchantInvoiceSyncRef(userId, 'igdrasil', pid)).toBeNull()

    // A row that is not `pushed` (the underlag failed): still nothing.
    expect(await feedSettledPayment(userId, pid)).toEqual({ outcome: 'pushed' })
    await markFailed(userId, 'igdrasil', pid, 'provider outage')
    const afterFail = state.requests.length
    await lateAttachIgdrasilMerchantReceipt(userId, pid, RECEIPT, impl)
    expect(state.requests.length).toBe(afterFail)
    expect(await getMerchantInvoiceSyncRef(userId, 'igdrasil', pid)).toBeNull()
  })

  it('an upload Igdrasil refuses resolves, records no merchant-invoice row and leaves a note on the pushed underlag row', async () => {
    // MUTATION TARGET: let the error escape the try in
    // `lateAttachIgdrasilMerchantReceipt` and this call rejects.
    const { userId, state, impl } = await connected()
    const pid = `pay-igd-late-${seq}-3`
    expect(await feedSettledPayment(userId, pid)).toEqual({ outcome: 'pushed' })

    state.writesDisabled = true
    await expect(lateAttachIgdrasilMerchantReceipt(userId, pid, RECEIPT, impl)).resolves.toBeUndefined()
    expect(await getMerchantInvoiceSyncRef(userId, 'igdrasil', pid)).toBeNull()
    const underlag = await getSyncState(userId, 'igdrasil', pid)
    expect(underlag?.status).toBe('pushed')
    expect(underlag?.external_ref).toBe(UNDERLAG_REF)
    expect(underlag?.error).toMatch(/^the merchant's own invoice was not attached: /)
  })
})
