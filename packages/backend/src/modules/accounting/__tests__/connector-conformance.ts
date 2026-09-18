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
 *   6b. (#2865) a PRE-push scope refusal — the create call itself refused,
 *      nothing exists at the provider — records a `skipped` row with the
 *      reason AND flips the connection; the same payment is not attempted
 *      again while `scope_missing`, and is delivered exactly once after the
 *      connection is `connected` again
 *   7. a provider reporting an UNSUPPORTED base currency is refused at connect
 *      by the generic flow, before any secret is stored (#2864 owns the
 *      policy; this proves BOTH flows — the OAuth2 runner and the API-key
 *      runner — reach the enforcement point). #2877 widened the supported set
 *      from SEK alone to `domain/ledger-currency.ts`, so the refused case is
 *      a currency outside that list and 7d is its positive control
 *   8. a reconnect that reports a DIFFERENT company id is a company switch
 *      (#2864): one row, company fields replaced, `feed_from` = now, the
 *      switch recorded, the previous company's `pushed` rows untouched and
 *      refused by the verification-gated reopen
 *
 * #3018: a harness whose connector's SHAPE cannot meet a case gets that case
 * SKIPPED by name, with the printed reason (`conformanceSkipsFor`) — a
 * document-only connector cannot claim a booking it never read, and a
 * currency-null company read cannot drive the connect-time currency rule. A
 * full-suite connector (Fortnox, in-memory) runs every case unchanged; the
 * executed skip decisions are pinned by `connector-conformance-skips.test.ts`.
 */
import { randomBytes } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { companySwitchLog, getConnection, listConnections, setStatus, setCompanyInfo, upsertConnection } from '../../../infra/repositories/accounting-connections.js'
import { getSyncState } from '../../../infra/repositories/accounting-feed-syncs.js'
import { SECRETS_KEY_ENV, encryptSecrets } from '../../../infra/secrets.js'
import type { AccountingConnector, ProviderSecrets } from '../connector.js'
import { clearConnectors, registerConnector } from '../connector.js'
import { disconnectProvider, reopenPushedPayment, toConnectionSummary } from '../connections.js'
import { feedSettledPayment } from '../feed-orchestrator.js'
import type { FeedTransaction } from '../feed-transaction.js'
import { UNSUPPORTED_BASE_CURRENCY_MESSAGE, UnsupportedBaseCurrencyError, type AccountingProvider, type ProviderCompanyInfo } from '../provider.js'
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
  /** #2865: make the provider refuse the CREATE call for scope (nothing created) — or stop doing so. */
  refuseInvoiceForScope(on: boolean): void
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
   * #3018: what this connector's SHAPE cannot exercise, declared by the
   * harness so the runner can skip cases BY NAME with a printed reason
   * instead of failing them. The descriptor (`provider.capabilities`) still
   * drives verify/attachment skips; this carries only what the descriptor
   * has no flag for. Absent = the full suite (Fortnox, in-memory).
   */
  declares?: {
    /**
     * false = the connector's company read exposes NO base currency
     * (Accounted answers null — the 2026-05-12 spec has no currency field),
     * so the connect-time currency rule (cases 7/7b/7c/7d) has nothing to
     * refuse and nothing positive to store.
     */
    baseCurrency?: boolean
  }
  /**
   * #3018: what the GENERIC CONNECT would have stored about the company, for
   * harnesses whose connector reports one (Fortnox: DatabaseNumber + SEK).
   * The runner applies it via `setCompanyInfo` right after the row lands, so
   * the connector under test sees exactly what a real connect stores. An
   * api_key connector whose push reads the company id OFF THE ROW (Accounted,
   * `readApiKeyConnection`) gets its real connect flow in `connect()` — and
   * its `setup` seeds this from the same company the connector's read
   * reported, so the row is the shape a connect leaves behind.
   */
  company?: { externalCompanyId: string | null; name: string | null; baseCurrency: string | null }
  /**
   * Fresh connector, with `userId` (a real `users` row the suite created)
   * connected at the provider; `company` overrides what the provider reports
   * at connect.
   */
  setup(opts: { userId: string; attachment?: AttachmentOutcome; company?: Partial<ProviderCompanyInfo> }): Promise<ConformanceCase>
}

/**
 * #3018: the cases this harness's connector cannot meet, derived once so the
 * runner and the skip-proving test read the SAME decision.
 *
 *  - `attachmentCases` — cases 3 and 6 drive the attachment step (the
 *    underlag uploaded AFTER a pushed invoice). A document-only connector
 *    (`capabilities.attachments: false` — the document IS the object) has no
 *    such step, and a faked one would test nothing.
 *  - `bookingHalves` — case 4's `registered → book(ref) → booked` half
 *    claims a human booking at the provider. A `capabilities.verify: false`
 *    connector answers from Haven's own record and cannot report booking;
 *    its `foreign_invoice` and `no_invoice_ref` halves still run.
 *  - `baseCurrencyCases` — cases 7/7b/7c/7d ARE the connect-time currency rule;
 *    a connector whose company read reports `baseCurrency: null` (declared)
 *    cannot drive them.
 */
export interface ConformanceSkips {
  attachmentCases: boolean
  bookingHalves: boolean
  baseCurrencyCases: boolean
  /** One printed reason per skipped area — empty for a full-suite connector. */
  reasons: string[]
}

export function conformanceSkipsFor(harness: ConformanceHarness): ConformanceSkips {
  const reasons: string[] = []
  const attachmentCases = !harness.provider.capabilities.attachments
  if (attachmentCases) {
    reasons.push(
      `cases 3, 6 skipped: ${harness.provider.id} declares capabilities.attachments false — the document IS the delivered object, there is no attachment step to fail`,
    )
  }
  const bookingHalves = !harness.provider.capabilities.verify
  if (bookingHalves) {
    reasons.push(
      `case 4's registered/booked/deleted halves skipped: ${harness.provider.id} declares capabilities.verify false — verify answers from Haven's own record and cannot report a booking; its foreign_invoice and no_invoice_ref halves still run`,
    )
  }
  const baseCurrencyCases = harness.declares?.baseCurrency === false
  if (baseCurrencyCases) {
    reasons.push(
      `cases 7, 7b, 7c, 7d skipped: ${harness.provider.id}'s company read reports baseCurrency null (no currency on the provider's spec) — the connect-time currency rule has nothing to refuse and no currency to store`,
    )
  }
  return { attachmentCases, bookingHalves, baseCurrencyCases, reasons }
}

/**
 * The skip predicate of every parameterised case that CAN skip, keyed by the
 * case's leading number. The runner's `skip()` calls go through these SAME
 * predicates (`caseSkipped`), and `connector-conformance-skips.test.ts`
 * evaluates them against each shape's vector — so the "runs every case
 * unchanged" claim measures the decisions the runner actually executes, not
 * a parallel model of them. A case that must never skip (1, 2, 4b, 5, 6b, 8)
 * has no entry here.
 */
const CASE_SKIP_PREDICATES: Readonly<Record<string, (skips: ConformanceSkips) => boolean>> = {
  '3': ({ attachmentCases }) => attachmentCases,
  '4': ({ bookingHalves }) => bookingHalves,
  '6': ({ attachmentCases }) => attachmentCases,
  '7': ({ baseCurrencyCases }) => baseCurrencyCases,
  '7b': ({ baseCurrencyCases }) => baseCurrencyCases,
  '7c': ({ baseCurrencyCases }) => baseCurrencyCases,
  '7d': ({ baseCurrencyCases }) => baseCurrencyCases,
}

/** The runner's ACTUAL skip decision for one case — the predicate the skip-proving test evaluates. */
export function caseSkipped(caseNo: string, skips: ConformanceSkips): boolean {
  const predicate = CASE_SKIP_PREDICATES[caseNo]
  if (!predicate) throw new Error(`conformance case ${caseNo} has no skip predicate — register it in CASE_SKIP_PREDICATES`)
  return predicate(skips)
}

/** Every case number with a registered skip predicate, sorted — the skip-proving test pins this set. */
export function skippableCases(): string[] {
  return Object.keys(CASE_SKIP_PREDICATES).sort()
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
    ledgerCurrency: 'SEK',
    amountLedger: '10.42',
    fxRateLedger: '10.42',
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
    amountAtomic: tx.amountAtomic, amountHuman: '0.001', amountSek: tx.amountSek, fxRate: tx.fxRate,
    fxSource: tx.fxSource, fxAt: tx.fxAt, fxRates: { SEK: 10.42, EUR: 0.92, DKK: 6.87 },
    receiptRef: tx.receiptRef, merchantReceipt: null, account: '6540', vatTreatment: 'reverse_charge',
  }
}

export function runConnectorConformance(name: string, harness: ConformanceHarness): void {
  const KEY = randomBytes(32).toString('base64')
  // #3018: what this connector's shape cannot exercise, computed once — the
  // skips below and the skip-proving test read the same decision.
  const skips = conformanceSkipsFor(harness)

  describeDb(`connector conformance: ${name}`, () => {
    // The skipped cases are printed BY NAME with the reason (issue #3018):
    // a green suite must show what it did NOT exercise, so a reader cannot
    // mistake "green" for "every case ran".
    beforeAll(() => {
      for (const reason of skips.reasons) {
        // eslint-disable-next-line no-console -- the printed record IS the requirement
        console.info(`[conformance: ${name}] SKIP ${reason}`)
      }
    })
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
      // What the generic connect's `applyCompanyInfo` step would have
      // written. Only connectors that REPORT a company: a null company id on
      // the harness is the same "read never succeeded" state a row lands in
      // without it (the documented recoverable-by-reconnecting shape).
      if (harness.company?.externalCompanyId) {
        await setCompanyInfo(userId, harness.provider.id, harness.company)
      }
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

    it('3. attachment failure degrades to a note on a PUSHED row, never a failed push', async ({ skip }) => {
      skip(caseSkipped('3', skips))
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

    it('4. verify reports registered → booked → missing (deleted), and a foreign record as not ours', async ({ skip }) => {
      skip(caseSkipped('4', skips))
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

      c.remove(ref)
      const gone = await c.connector.verify(c.userId, ref, pid)
      expect(gone).toMatchObject({ ok: true, verification: { registered: false, missing: 'deleted', booked: null, voucher: null } })
      expect(await c.connector.verify(c.userId, 'not-a-ref', pid)).toEqual({ ok: false, error_code: 'no_invoice_ref' })
    })

    it('4b. verify refuses a FOREIGN record as not ours — the identity halves every connector must meet', async () => {
      // #3018: with `capabilities.verify: false` the connector cannot report
      // booking, but the foreign_invoice and no_invoice_ref halves are about
      // OUR OWN record's identity — they run everywhere, for every shape.
      // UNCONDITIONAL: a skip here is what silently dropped the
      // foreign_invoice assertion from the verify-capable suites (round-1
      // review of #3018).
      const c = await connectedCase()
      const pid = paymentId()
      await feedSettledPayment(c.userId, pid)
      const ref = (await syncRow(c.userId, pid))!.external_ref!
      const foreign = await c.connector.verify(c.userId, ref, `${pid}-someone-else`)
      expect(foreign).toMatchObject({ ok: true, verification: { registered: false, missing: 'foreign_invoice', booked: null } })
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

    it('6. a post-push insufficient-scope error leaves the row pushed with its note, flips ONLY the connection, and is never re-pushable', async ({ skip }) => {
      skip(caseSkipped('6', skips))
      const c = await connectedCase({ attachment: 'scope_missing' })
      const pid = paymentId()
      await feedSettledPayment(c.userId, pid)
      const row = await syncRow(c.userId, pid)
      expect(row?.status).toBe('pushed')
      expect(row?.external_ref).toEqual(expect.any(String))
      expect(row?.error).toMatch(/attachment failed/)
      const degraded = (await connection(c.userId))!
      expect(degraded).toMatchObject({ status: 'scope_missing', is_active_destination: true })
      // #2865: the reason names the scope(s) in the parseable shape the
      // dashboard's `missingScopes` reads.
      expect(degraded.status_reason).toMatch(/^missing scopes: [a-z]/)
      expect(toConnectionSummary(degraded).missingScopes.length).toBeGreaterThan(0)

      // Never re-pushable: the pushed row is not re-claimable (this case
      // re-feeds the SAME payment). That a degraded row also yields no
      // destination for NEW payments is proven on the real database in
      // feed-from.db.test.ts, not here.
      await feedSettledPayment(c.userId, pid)
      expect(c.createCalls()).toBe(1)
      expect(await syncRow(c.userId, pid)).toMatchObject({ status: 'pushed', external_ref: row!.external_ref })

      // #2865: and after the connection is `connected` again (a re-consent),
      // the row is STILL not re-fed — it was never `skipped`.
      await setStatus(c.userId, harness.provider.id, 'connected', null)
      await feedSettledPayment(c.userId, pid)
      expect(c.createCalls()).toBe(1)
      expect(await syncRow(c.userId, pid)).toMatchObject({ status: 'pushed', external_ref: row!.external_ref })
    })

    it('6b. a PRE-push scope refusal (nothing created) records a skipped row, flips the connection, and is delivered exactly once after reconnect', async () => {
      const c = await connectedCase()
      c.refuseInvoiceForScope(true)
      const pid = paymentId()
      const outcome = await feedSettledPayment(c.userId, pid)
      expect(outcome.outcome).toBe('skipped')
      const row = await syncRow(c.userId, pid)
      expect(row).toMatchObject({ status: 'skipped', external_ref: null, attempts: 1 })
      expect(row?.error).toMatch(/scope/)
      expect(c.createCalls()).toBe(0)
      // MUTATION TARGET (#2865): without the flip on a skipped result the
      // connection stays connected and every later payment repeats the refusal.
      const degraded = (await connection(c.userId))!
      expect(degraded).toMatchObject({ status: 'scope_missing', is_active_destination: true })
      expect(degraded.status_reason).toMatch(/scope/)

      // While scope_missing: no destination, the row is not touched.
      expect(await feedSettledPayment(c.userId, pid)).toEqual({ outcome: 'not_fed' })
      expect(await syncRow(c.userId, pid)).toMatchObject({ status: 'skipped', attempts: 1 })
      expect(c.createCalls()).toBe(0)

      // Re-consent (the scope is now granted): the skipped row is re-claimable
      // and delivered exactly once.
      c.refuseInvoiceForScope(false)
      await setStatus(c.userId, harness.provider.id, 'connected', null)
      expect(await feedSettledPayment(c.userId, pid)).toEqual({ outcome: 'pushed' })
      expect(c.createCalls()).toBe(1)
      expect(await syncRow(c.userId, pid)).toMatchObject({ status: 'pushed', attempts: 2, external_ref: expect.any(String) })
      expect((await connection(c.userId))?.status).toBe('connected')
    })

    it('7. a provider reporting an UNSUPPORTED base currency is refused at connect by the generic flow, and nothing is stored', async ({ skip }) => {
      skip(caseSkipped('7', skips))
      const userId = await seedUser()
      // JPY: not a ledger currency Haven feeds (#2877 widened the rule from
      // SEK-only to the six in `domain/ledger-currency.ts`; an unsupported
      // currency is still refused at connect, which is the invariant here).
      const c = await harness.setup({ userId, company: { baseCurrency: 'JPY' } })
      registerConnector(c.connector)
      // MUTATION TARGET (#2864): drop `assertSupportedBaseCurrency` from the
      // flow and the connect resolves with a stored JPY row.
      const err = await c.connect().then(() => null, (e: unknown) => e)
      expect(err).toBeInstanceOf(UnsupportedBaseCurrencyError)
      expect((err as Error).message).toContain(UNSUPPORTED_BASE_CURRENCY_MESSAGE)
      expect((err as Error).message).toContain('JPY')
      // Before any secret is stored: no row at all.
      expect(await connection(userId)).toBeNull()
      expect(await listConnections(userId)).toEqual([])
      // An OAuth2 grant was already obtained at the provider by the code
      // exchange; it is revoked there when the descriptor can (#2863's rule).
      expect(c.revokeCalls()).toBe(harness.provider.authKind === 'oauth2' && harness.provider.capabilities.revoke ? 1 : 0)
    })

    it('7c. … and a RECONNECT that reports an unsupported ledger leaves the existing row exactly as it was', async ({ skip }) => {
      skip(caseSkipped('7c', skips))
      const userId = await seedUser()
      const sek = await harness.setup({ userId, company: { baseCurrency: 'SEK' } })
      registerConnector(sek.connector)
      await sek.connect()
      const before = (await connection(userId))!
      clearConnectors()
      const jpy = await harness.setup({ userId, company: { baseCurrency: 'JPY' } })
      registerConnector(jpy.connector)
      await expect(jpy.connect()).rejects.toBeInstanceOf(UnsupportedBaseCurrencyError)
      const after = (await connection(userId))!
      expect(after).toEqual(before)
      expect(after.base_currency).toBe('SEK')
    })

    it('7d. a SUPPORTED non-SEK ledger connects and is stored with its own currency (#2877)', async ({ skip }) => {
      skip(caseSkipped('7d', skips))
      const userId = await seedUser()
      // MUTATION TARGET: narrow `isSupportedLedgerCurrency` back to SEK and
      // this connect is refused — the widening is what this case measures,
      // and case 7 above is the control that the refusal still exists.
      const c = await harness.setup({ userId, company: { externalCompanyId: 'co-7d', name: 'Syv D ApS', baseCurrency: 'DKK' } })
      registerConnector(c.connector)
      await expect(c.connect()).resolves.toBeUndefined()
      expect(await connection(userId)).toMatchObject({
        status: 'connected', base_currency: 'DKK', is_active_destination: true,
        external_company_id: 'co-7d', external_company_name: 'Syv D ApS',
      })
    })

    it('7b. positive control: the same flow with a SEK ledger stores the connection with id, name and currency', async ({ skip }) => {
      skip(caseSkipped('7b', skips))
      const userId = await seedUser()
      const c = await harness.setup({ userId, company: { externalCompanyId: 'co-7b', name: 'Sju B AB', baseCurrency: 'SEK' } })
      registerConnector(c.connector)
      await expect(c.connect()).resolves.toBeUndefined()
      expect(await connection(userId)).toMatchObject({
        status: 'connected', base_currency: 'SEK', is_active_destination: true,
        external_company_id: 'co-7b', external_company_name: 'Sju B AB',
      })
    })

    it('8. a reconnect reporting a DIFFERENT company id is a company switch: one row, fields replaced, feed_from = now, switch recorded, previous pushes untouched and not reopenable', async () => {
      const userId = await seedUser()
      const alpha = await harness.setup({ userId, company: { externalCompanyId: 'co-A', name: 'Alpha AB', baseCurrency: 'SEK' } })
      registerConnector(alpha.connector)
      await alpha.connect()
      const first = (await connection(userId))!
      expect(first).toMatchObject({ external_company_id: 'co-A', external_company_name: 'Alpha AB', is_active_destination: true })
      expect(companySwitchLog(first)).toEqual([])

      // Deliver one payment into Alpha; the feed-from floor is the first
      // connect's stamp, so the case's fixed settledAt must not sit below it.
      const pid = paymentId()
      await db.query(`UPDATE accounting_connections SET feed_from = NULL WHERE user_id = $1`, [userId])
      await feedSettledPayment(userId, pid)
      const pushed = await syncRow(userId, pid)
      expect(pushed?.status).toBe('pushed')
      expect(alpha.createCalls()).toBe(1)

      // Reconnect — same user, same provider — and the provider now reports Beta.
      await new Promise((r) => setTimeout(r, 25))
      clearConnectors()
      const beta = await harness.setup({ userId, company: { externalCompanyId: 'co-B', name: 'Beta AB', baseCurrency: 'SEK' } })
      registerConnector(beta.connector)
      const before = Date.now()
      await beta.connect()

      const rows = await listConnections(userId)
      expect(rows).toHaveLength(1)
      const switched = rows[0]
      expect(switched).toMatchObject({ id: first.id, external_company_id: 'co-B', external_company_name: 'Beta AB', base_currency: 'SEK', status: 'connected' })
      // MUTATION TARGET (#2864): without the feed_from stamp on a switch the
      // floor stays NULL and the next sync feeds Alpha's history into Beta.
      expect(switched.feed_from).not.toBeNull()
      expect(new Date(switched.feed_from!).getTime()).toBeGreaterThanOrEqual(before - 1000)
      expect(switched.status_reason).toMatch(/company switched .*Alpha AB \(co-A\) → Beta AB \(co-B\)/)
      expect(companySwitchLog(switched)).toMatchObject([{ fromCompanyId: 'co-A', fromCompanyName: 'Alpha AB', toCompanyId: 'co-B', toCompanyName: 'Beta AB' }])
      expect(new Date(companySwitchLog(switched)[0].at).toISOString()).toBe(new Date(switched.feed_from!).toISOString())

      // Alpha's pushed row keeps its external ref; re-feeding it creates nothing in Beta.
      expect(await syncRow(userId, pid)).toMatchObject({ status: 'pushed', external_ref: pushed!.external_ref })
      await feedSettledPayment(userId, pid)
      expect(beta.createCalls()).toBe(0)
      expect(await syncRow(userId, pid)).toMatchObject({ status: 'pushed', external_ref: pushed!.external_ref })

      // The verification-gated reopen refuses the pre-switch row: it belongs
      // to the previous company, and a reopen would re-feed it into Beta.
      const refused = await reopenPushedPayment(userId, harness.provider.id, pid, 'reopened: invoice missing')
      expect(refused).toMatchObject({ reopened: false, error_code: 'previous_company', company_name: 'Alpha AB' })
      expect(await syncRow(userId, pid)).toMatchObject({ status: 'pushed' })
    })
  })
}
