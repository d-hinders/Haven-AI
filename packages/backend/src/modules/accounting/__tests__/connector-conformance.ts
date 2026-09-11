/**
 * Connector conformance suite (#2862, epic #2858) — the executable form of
 * the `AccountingConnector` contract. One parameterised suite every
 * connector must pass; runners:
 *
 *   in-memory-connector.conformance.test.ts   InMemoryConnector
 *   fortnox-connector.conformance.test.ts     FortnoxConnector, recorded HTTP fixtures
 *
 * The suite drives the REAL orchestrator (`feedSettledPayment`), the real
 * ledger and connection repositories on the REAL database (the #1220
 * harness), and the real generic connect flows. The connector under test is
 * the only variable. A harness supplies the provider-specific knobs: how to
 * reach the "attachment failed" and "scope missing" outcomes, how to book or
 * delete the pushed record at the provider, how many create calls the
 * provider saw, and what payload it was sent.
 *
 * Cases (the issue's list, plus the two from the 2026-09-11 review):
 *
 *   1. idempotent re-push returns the same external ref
 *   2. the payload carries no VAT, account or rows (non-asserting guard)
 *   3. attachment failure degrades to a note, never a failed push
 *   4. verify reports registered / booked / missing (deleted and foreign)
 *   5. revoke is called on disconnect exactly when the capability is declared
 *   6. a POST-PUSH insufficient-scope error on the attachment step leaves the
 *      sync row `pushed` with its note and flips only the connection state —
 *      never re-pushable
 *   7. a provider reporting a non-SEK base currency is refused at connect by
 *      the generic flow (enforcement policy is #2864; this proves the flow
 *      calls it)
 */
import { randomBytes } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { getConnection, upsertConnection } from '../../../infra/repositories/accounting-connections.js'
import { getSyncState } from '../../../infra/repositories/accounting-feed-syncs.js'
import { SECRETS_KEY_ENV, encryptSecrets } from '../../../infra/secrets.js'
import type { AccountingConnector, ProviderSecrets } from '../connector.js'
import { clearConnectors, registerConnector } from '../connector.js'
import { disconnectProvider } from '../connections.js'
import { feedSettledPayment } from '../feed-orchestrator.js'
import type { FeedTransaction } from '../feed-transaction.js'
import { UnsupportedBaseCurrencyError, type AccountingProvider, type ProviderCompanyInfo } from '../provider.js'
import { clearTestProviders, registerTestProvider } from '../registry.js'

export type AttachmentOutcome = 'ok' | 'fail' | 'scope_missing'

export interface ConformanceCase {
  connector: AccountingConnector
  /** Provider-side state knobs for the verify cases. */
  book(externalRef: string): void
  remove(externalRef: string): void
  /** How many "create the record" calls the provider has seen. */
  createCalls(): number
  /** The last payload sent to the provider's create call (null for none). */
  createPayload(): Record<string, unknown> | null
  /** Revoke calls the provider has seen. */
  revokeCalls(): number
  /** What the stored secrets decrypt to, for the disconnect case. */
  secrets: ProviderSecrets
  /**
   * Run the generic connect flow for this provider's auth kind against the
   * connector — the OAuth2 code exchange with a token fixture, or the API-key
   * validation. Resolves when a connection landed; rejects when refused.
   */
  connect(): Promise<void>
}

export interface ConformanceHarness {
  provider: AccountingProvider
  /**
   * Fresh connector, with `userId` (a real `users` row the suite created)
   * connected at the provider; `company` overrides what the provider reports
   * at connect.
   */
  setup(opts: { userId: string; attachment?: AttachmentOutcome; company?: Partial<ProviderCompanyInfo> }): Promise<ConformanceCase>
}

/** The payload keys the contract bans — the accountant codes, Haven never asserts. */
export const ASSERTING_PAYLOAD_KEYS = [
  'SupplierInvoiceRows', 'VAT', 'VATType', 'Account', 'VoucherRows', // Fortnox-shaped
  'vatTreatment', 'account', 'rows', 'lines', 'vat', 'vatRate', // generic-shaped
]

export function feedTransaction(paymentId: string, over: Partial<FeedTransaction> = {}): FeedTransaction {
  return {
    paymentId,
    settledAt: '2026-09-10T09:30:00.000Z',
    direction: 'out',
    counterparty: { address: '0x' + 'ab'.repeat(20), name: 'NordShield VPN' },
    resourceUrl: 'https://merchant.example/vpn',
    token: 'USDC',
    amountAtomic: '1000',
    amountSek: '10.42',
    fxRate: '10.42',
    fxSource: 'riksbank',
    fxAt: '2026-09-10T09:30:00.000Z',
    receiptRef: 'receipt-1',
    merchantReceipt: null,
    suggestedAccount: '6540',
    ...over,
  }
}

/** The AccountingEntry shape `buildAccountingEntryForPayment` returns, for the runner's mock. */
export function accountingEntry(paymentId: string) {
  const tx = feedTransaction(paymentId)
  return {
    paymentId, txHash: '0xabc', chainId: 84532, settledAt: tx.settledAt, direction: 'out' as const,
    counterparty: { ...tx.counterparty, country: null }, resourceUrl: tx.resourceUrl, token: tx.token,
    amountAtomic: tx.amountAtomic, amountSek: tx.amountSek, fxRate: tx.fxRate, fxSource: tx.fxSource, fxAt: tx.fxAt,
    receiptRef: tx.receiptRef, merchantReceipt: null, account: '6540', vatTreatment: 'reverse_charge',
  }
}

export function runConnectorConformance(name: string, harness: ConformanceHarness): void {
  const KEY = randomBytes(32).toString('base64')

  describeDb(`connector conformance: ${name}`, () => {
    let seq = 0
    const paymentId = () => `pay-${name.replace(/\W+/g, '-')}-${++seq}`

    beforeAll(initDbHarness)
    beforeEach(async () => {
      await resetDb()
      clearConnectors()
      clearTestProviders()
      registerTestProvider(harness.provider)
      process.env[SECRETS_KEY_ENV] = KEY
    })
    afterEach(() => {
      delete process.env[SECRETS_KEY_ENV]
    })

    async function seedUser(): Promise<string> {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
        [`conformance-${name.replace(/\W+/g, '-')}-${++seq}-${Date.now()}@test.example`],
      )
      return rows[0].id
    }

    /** A user with a stored, active connection for the provider — the first row takes the flag. */
    async function connectedCase(opts: { attachment?: AttachmentOutcome } = {}) {
      const userId = await seedUser()
      const c = await harness.setup({ userId, ...opts })
      registerConnector(c.connector)
      const { ciphertext, keyVersion } = encryptSecrets(c.secrets)
      await upsertConnection(userId, {
        provider: harness.provider.id,
        authKind: harness.provider.authKind,
        secretsCiphertext: ciphertext,
        secretsKeyVersion: keyVersion,
        grantedScope: null,
        tokenExpiresAt: new Date(Date.now() + 3600 * 1000),
      })
      return { ...c, userId }
    }

    const syncRow = (userId: string, pid: string) => getSyncState(userId, harness.provider.id, pid)
    const connection = (userId: string) => getConnection(userId, harness.provider.id)

    it('1. idempotent re-push: the second feed of one payment creates nothing and the external ref is stable', async () => {
      const c = await connectedCase()
      const pid = paymentId()
      await feedSettledPayment(c.userId, pid)
      const first = await syncRow(c.userId, pid)
      expect(first?.status).toBe('pushed')
      expect(first?.external_ref).toEqual(expect.any(String))
      expect(c.createCalls()).toBe(1)

      await feedSettledPayment(c.userId, pid)
      await feedSettledPayment(c.userId, pid)
      expect(c.createCalls()).toBe(1)
      expect(await syncRow(c.userId, pid)).toMatchObject({ status: 'pushed', external_ref: first!.external_ref })
    })

    it('2. the payload carries no VAT, account or rows — the non-asserting guard', async () => {
      const c = await connectedCase()
      const pid = paymentId()
      await feedSettledPayment(c.userId, pid)
      expect((await syncRow(c.userId, pid))?.status).toBe('pushed')
      const payload = c.createPayload()
      expect(payload).not.toBeNull()
      for (const banned of ASSERTING_PAYLOAD_KEYS) {
        expect(payload, `payload must not carry ${banned}`).not.toHaveProperty(banned)
      }
    })

    it('3. attachment failure degrades to a note on a PUSHED row, never a failed push', async () => {
      const c = await connectedCase({ attachment: 'fail' })
      const pid = paymentId()
      await feedSettledPayment(c.userId, pid)
      const row = await syncRow(c.userId, pid)
      expect(row?.status).toBe('pushed')
      expect(row?.external_ref).toEqual(expect.any(String))
      expect(row?.error).toMatch(/attachment failed/)
      // The connection is untouched — this was not a grant problem.
      expect((await connection(c.userId))?.status).toBe('connected')
    })

    it('4. verify reports registered → booked → missing (deleted), and a foreign record as not ours', async () => {
      const c = await connectedCase()
      const pid = paymentId()
      await feedSettledPayment(c.userId, pid)
      const ref = (await syncRow(c.userId, pid))!.external_ref!

      const registered = await c.connector.verify(c.userId, ref, pid)
      expect(registered).toMatchObject({ ok: true, verification: { registered: true, missing: null, booked: false, voucher: null } })

      c.book(ref)
      const booked = await c.connector.verify(c.userId, ref, pid)
      expect(booked).toMatchObject({ ok: true, verification: { registered: true, booked: true } })
      expect((booked as { verification: { voucher: string | null } }).verification.voucher).toEqual(expect.any(String))

      const foreign = await c.connector.verify(c.userId, ref, `${pid}-someone-else`)
      expect(foreign).toMatchObject({ ok: true, verification: { registered: false, missing: 'foreign_invoice', booked: null } })

      c.remove(ref)
      const gone = await c.connector.verify(c.userId, ref, pid)
      expect(gone).toMatchObject({ ok: true, verification: { registered: false, missing: 'deleted', booked: null, voucher: null } })

      expect(await c.connector.verify(c.userId, 'not-a-ref', pid)).toEqual({ ok: false, error_code: 'no_invoice_ref' })
    })

    it(`5. disconnect ${harness.provider.capabilities.revoke ? 'CALLS' : 'does NOT call'} revoke — exactly as the descriptor declares`, async () => {
      const c = await connectedCase()
      const outcome = await disconnectProvider(c.userId, harness.provider.id)
      expect(outcome.existed).toBe(true)
      expect(c.revokeCalls()).toBe(harness.provider.capabilities.revoke ? 1 : 0)
      expect(outcome.revoked).toBe(harness.provider.capabilities.revoke)
      // Either way the row stays, disconnected, secrets cleared.
      expect(await connection(c.userId)).toMatchObject({
        status: 'disconnected', secrets_ciphertext: null, is_active_destination: false,
      })
    })

    it('6. a post-push insufficient-scope error leaves the row pushed with its note, flips ONLY the connection, and is never re-pushable', async () => {
      const c = await connectedCase({ attachment: 'scope_missing' })
      const pid = paymentId()
      await feedSettledPayment(c.userId, pid)
      const row = await syncRow(c.userId, pid)
      expect(row?.status).toBe('pushed')
      expect(row?.external_ref).toEqual(expect.any(String))
      expect(row?.error).toMatch(/attachment failed/)
      expect(await connection(c.userId)).toMatchObject({ status: 'scope_missing', is_active_destination: true })

      // Never re-pushable: the connection is degraded, so no destination is
      // active — and even if it were, the pushed row is not re-claimable.
      await feedSettledPayment(c.userId, pid)
      expect(c.createCalls()).toBe(1)
      expect(await syncRow(c.userId, pid)).toMatchObject({ status: 'pushed', external_ref: row!.external_ref })
    })

    it('7. a provider reporting a non-SEK base currency is refused at connect by the generic flow, and nothing is stored', async () => {
      const userId = await seedUser()
      const c = await harness.setup({ userId, company: { baseCurrency: 'EUR' } })
      registerConnector(c.connector)
      await expect(c.connect()).rejects.toBeInstanceOf(UnsupportedBaseCurrencyError)
      expect(await connection(userId)).toBeNull()
    })

    it('7b. positive control: the same flow with a SEK ledger stores the connection', async () => {
      const userId = await seedUser()
      const c = await harness.setup({ userId, company: { baseCurrency: 'SEK' } })
      registerConnector(c.connector)
      await expect(c.connect()).resolves.toBeUndefined()
      expect(await connection(userId)).toMatchObject({ status: 'connected', base_currency: 'SEK', is_active_destination: true })
    })
  })
}
