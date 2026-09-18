/**
 * The Accounted feed on the REAL database (#3018, epic #3016) — the
 * acceptance row the issue names: a settled payment for a user with an
 * active Accounted connection produces ONE `pushed` sync row whose ref is
 * `accounted:document:<uuid>`; a second run of the same delivery replays
 * (same idempotency key, same deterministic bytes) and creates NO second
 * document; a changed-bytes attempt under the same key is the provider's
 * 409 `IDEMPOTENCY_KEY_REUSE` — `skipped` with that reason, and not
 * retried: neither by the connector (one refused call, no retry loop) nor
 * by the feed (the pushed row is never re-fed).
 *
 * Real orchestrator (`feedSettledPayment`), real api-key connect, real
 * repositories on the real database; only `fetch` (the shared
 * `accounted-test-router`, the SAME implementation the conformance suite
 * drives) and the receipt underlag (a fixed PDF; the renderer is #498's,
 * proven elsewhere) are stubbed.
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

import { randomBytes } from 'node:crypto'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { SECRETS_KEY_ENV } from '../../../infra/secrets.js'
import { getConnection } from '../../../infra/repositories/accounting-connections.js'
import { getSyncState } from '../../../infra/repositories/accounting-feed-syncs.js'
import { AccountedConnector } from '../accounted-connector.js'
import { accountedIdempotencyKey } from '../accounted-client.js'
import { connectWithApiKey } from '../api-key-flow.js'
import { clearConnectors, registerConnector } from '../connector.js'
import { feedSettledPayment } from '../feed-orchestrator.js'
import { ACCOUNTED } from '../registry.js'
import { accountingEntry } from './connector-conformance.js'
import { accountedRouter, ACCOUNTED_DOCUMENT_ID } from './accounted-test-router.js'

const KEY = randomBytes(32).toString('base64')
const DOC_REF = `accounted:document:${ACCOUNTED_DOCUMENT_ID}`

let seq = 0
async function seedUser(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`accounted-feed-db-${++seq}-${Date.now()}@test.example`],
  )
  return rows[0].id
}

mocks.buildAccountingEntryForPayment.mockImplementation(async (_userId: string, paymentId: string) => accountingEntry(paymentId))
underlagMocks.loadReceiptUnderlag.mockImplementation(async (_userId: string, tx: { paymentId: string }) => ({
  filename: `haven-receipt-${tx.paymentId}.pdf`,
  pdf: Buffer.from('%PDF-1.4 accounted feed db fixture'),
}))

describeDb('Accounted document feed on the real database (#3018)', () => {
  beforeAll(initDbHarness)
  beforeEach(async () => {
    await resetDb()
    clearConnectors()
    process.env[SECRETS_KEY_ENV] = KEY
  })
  afterEach(() => {
    delete process.env[SECRETS_KEY_ENV]
  })

  /** A user with a REAL api-key connection (companies fixture → the row carries the company id). */
  async function connectedUser(): Promise<string> {
    const userId = await seedUser()
    const { impl } = accountedRouter()
    const connector = new AccountedConnector(impl)
    registerConnector(connector)
    await connectWithApiKey({ provider: ACCOUNTED, connector, userId, apiKey: 'gnubok_sk_test_feed_db' })
    // The fixture entry settles at a fixed 2026-09-10 timestamp (the
    // conformance suite's `accountingEntry`); a first connect stamps
    // feed_from = now, which sits above it — clear the floor exactly as the
    // conformance runner's case 8 does, so the fixed-settledAt payment is
    // inside the window.
    await db.query(`UPDATE accounting_connections SET feed_from = NULL WHERE user_id = $1`, [userId])
    return userId
  }

  it('a settled payment is delivered once: one pushed row, ref accounted:document:<uuid>, the idempotency key derived from the payment', async () => {
    const userId = await connectedUser()
    const { impl, state } = accountedRouter()
    registerConnector(new AccountedConnector(impl))
    const pid = `pay-feed-db-${seq}-1`

    expect(await feedSettledPayment(userId, pid)).toEqual({ outcome: 'pushed' })
    const row = await getSyncState(userId, 'accounted', pid)
    expect(row?.status).toBe('pushed')
    expect(row?.external_ref).toBe(DOC_REF)
    expect(state.uploadCalls).toBe(1)
    expect(state.lastUpload?.idempotencyKey).toBe(accountedIdempotencyKey(pid))
    expect(state.lastUpload?.filename).toBe(`haven-receipt-${pid}.pdf`)
    expect(state.lastUpload?.uploadSource).toBe('api')

    // The connection row really carries the destination the upload went to.
    const stored = await getConnection(userId, 'accounted')
    expect(stored?.external_company_id).toBe('732b80b7-d0f7-45b9-8083-571f8d28d001')
  })

  it('a second run of the SAME payment creates nothing (the feed dedup), and a direct re-push REPLAYS — same key, same bytes, no second document', async () => {
    const userId = await connectedUser()
    const { impl, state } = accountedRouter()
    const connector = new AccountedConnector(impl)
    registerConnector(connector)
    const pid = `pay-feed-db-${seq}-2`

    await feedSettledPayment(userId, pid)
    expect(state.uploadCalls).toBe(1)

    // The orchestrator does not re-feed a pushed row — no second document.
    await feedSettledPayment(userId, pid)
    await feedSettledPayment(userId, pid)
    expect(state.uploadCalls).toBe(1)
    expect((await getSyncState(userId, 'accounted', pid))?.external_ref).toBe(DOC_REF)

    // The connector-level replay: the SAME payment pushed again carries the
    // SAME idempotency key and the SAME deterministic bytes, so the provider
    // answers from its cache (`Idempotent-Replayed`) and no document is
    // created — the create counter does not move.
    const replay = await connector.pushTransaction(userId, {
      paymentId: pid,
      settledAt: '2026-09-10T09:30:00.000Z',
      direction: 'out',
      counterparty: { address: '0x' + 'ab'.repeat(20), name: 'NordShield VPN' },
      resourceUrl: 'https://merchant.example/vpn',
      token: 'USDC',
      amountAtomic: '1000',
      amountSek: '10.42',
      ledgerCurrency: 'SEK',
      amountLedger: '10.42',
      fxRateLedger: '10.42',
      fxRate: '10.42',
      fxSource: 'riksbank',
      fxAt: '2026-09-10T09:30:00.000Z',
      receiptRef: 'receipt-1',
      merchantReceipt: null,
      suggestedAccount: '6540',
    })
    expect(replay).toEqual({ externalRef: DOC_REF, status: 'pushed' })
    expect(state.replayIdempotent).toBe(true)
    expect(state.uploadCalls).toBe(1)
    expect(state.uploads).toHaveLength(1)
  })

  it('a changed-bytes attempt under the same key is the 409 verdict — skipped with the reason, one refused call, never re-filed', async () => {
    const userId = await connectedUser()
    const { impl, state } = accountedRouter()
    const connector = new AccountedConnector(impl)
    registerConnector(connector)
    const pid = `pay-feed-db-${seq}-3`

    await feedSettledPayment(userId, pid)
    expect((await getSyncState(userId, 'accounted', pid))?.status).toBe('pushed')

    // The underlag changed under a document already in the WORM store: the
    // provider refuses with 409 and the connector answers TERMINAL skipped —
    // one refused call, no retry, no ref, no second document.
    // single-shot override (mockImplementationOnce): the NEXT underlag is the
    // changed-bytes body, then the module default applies again. Not a DB
    // mock — the ratchet's positional-chain concern does not apply.
    underlagMocks.loadReceiptUnderlag.mockImplementationOnce(() =>
      Promise.resolve({
        filename: `haven-receipt-${pid}.pdf`,
        pdf: Buffer.from('%PDF-1.4 CHANGED BYTES'),
      }),
    )
    const refused = await connector.pushTransaction(userId, {
      paymentId: pid,
      settledAt: '2026-09-10T09:30:00.000Z',
      direction: 'out',
      counterparty: { address: '0x' + 'ab'.repeat(20), name: 'NordShield VPN' },
      resourceUrl: 'https://merchant.example/vpn',
      token: 'USDC',
      amountAtomic: '1000',
      amountSek: '10.42',
      ledgerCurrency: 'SEK',
      amountLedger: '10.42',
      fxRateLedger: '10.42',
      fxRate: '10.42',
      fxSource: 'riksbank',
      fxAt: '2026-09-10T09:30:00.000Z',
      receiptRef: 'receipt-1',
      merchantReceipt: null,
      suggestedAccount: '6540',
    })
    expect(refused.status).toBe('skipped')
    expect(refused.reason).toContain('IDEMPOTENCY_KEY_REUSE')
    expect(refused.externalRef).toBeNull()
    expect(state.uploads).toHaveLength(1) // the refused attempt stored NOTHING

    // The pushed row is untouched — the feed never re-files over the 409.
    const row = await getSyncState(userId, 'accounted', pid)
    expect(row).toMatchObject({ status: 'pushed', external_ref: DOC_REF })

    // And a re-feed of the same payment creates nothing (the orchestrator's
    // pushed-row guard, not another upload attempt).
    await feedSettledPayment(userId, pid)
    expect(state.uploads).toHaveLength(1)
    expect((await getSyncState(userId, 'accounted', pid))?.external_ref).toBe(DOC_REF)
  })
})
