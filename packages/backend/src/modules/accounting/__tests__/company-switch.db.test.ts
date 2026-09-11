/**
 * Company switch on reconnect, on the REAL database (#2864, epic #2858).
 *
 * A user reconnects Fortnox and the grant now points at a different company
 * (`DatabaseNumber` 111 → 222). Proven here, with the real generic OAuth2
 * flow, the real Fortnox connector against a fixture `fetch`, the real
 * repositories and the real orchestrator:
 *
 *   - one row, company fields replaced, `feed_from` = the switch time,
 *     `status_reason` names the switch, `settings.companySwitches` records it;
 *   - the next `syncUser` creates NO duplicate push — the pre-switch payment
 *     stays `pushed` with its Fortnox-111 invoice ref and is not enumerated
 *     (it is below the new floor), while a payment settled after the switch
 *     flows into 222;
 *   - the verification-gated reopen refuses the pre-switch `pushed` row with
 *     `previous_company` — no `pushed → failed` flip.
 *
 * Mutation targets, each named at its site: the feed_from stamp in
 * `RECORD_COMPANY_SWITCH_SQL` / the switch branch in `applyCompanyInfo`
 * ("the next sync feeds NOTHING" goes red); the previous-company guard in
 * `reopenPushedPayment` ("reopen … refused" goes red).
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'

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
vi.mock('../receipt-underlag.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../receipt-underlag.js')>()),
  loadReceiptUnderlag: async () => null,
}))

import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { companySwitchLog, getConnection, listConnections } from '../../../infra/repositories/accounting-connections.js'
import { getSyncState, listUnpushedPaymentIds } from '../../../infra/repositories/accounting-feed-syncs.js'
import { SECRETS_KEY_ENV } from '../../../infra/secrets.js'
import { clearConnectors, registerConnector } from '../connector.js'
import { reopenPushedPayment, verifyPushedPayment } from '../connections.js'
import { syncUser } from '../feed-orchestrator.js'
import { FortnoxConnector } from '../fortnox-connector.js'
import { FORTNOX_API_BASE, FORTNOX_TOKEN_URL, fortnoxOAuth2Config } from '../fortnox.js'
import { completeOAuth2Connect } from '../oauth-flow.js'
import { FORTNOX } from '../registry.js'
import { accountingEntry } from './connector-conformance.js'

const KEY = randomBytes(32).toString('base64')
const CHAIN = 84532
const TOKEN = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const PAYER = '0x00000000000000000000000000000000000000f1'
const MERCHANT = '0x00000000000000000000000000000000000000aa'
const CFG = fortnoxOAuth2Config({ clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://api.test/cb' })

let seq = 0

async function seedUser(): Promise<{ userId: string; agentId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`company-switch-${++seq}-${Date.now()}@test.example`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'company-switch agent') RETURNING id`,
    [user.rows[0].id],
  )
  return { userId: user.rows[0].id, agentId: agent.rows[0].id }
}

/** A settled, FX-ready payment confirmed `agoSeconds` ago — what the backfill enumerates. */
async function seedSettled(userId: string, agentId: string, agoSeconds: number): Promise<string> {
  const id = randomUUID()
  await db.query(
    `INSERT INTO payment_intents
       (id, agent_id, user_id, safe_address, chain_id, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash, status, tx_hash,
        confirmed_at, expires_at, created_at)
     VALUES ($1, $2, $3, $4, ${CHAIN}, 'USDC', $5, $6, '100000', '0.10',
             '0x00000000000000000000000000000000000000d1', 0, $7, 'confirmed', $8,
             NOW() - ($9 * interval '1 second'), NOW() + interval '10 minutes', NOW() - ($9 * interval '1 second'))`,
    [id, agentId, userId, PAYER, TOKEN, MERCHANT, `0x${String(++seq).padStart(64, 'c')}`.slice(0, 66), `0x${'30'.repeat(32)}`, agoSeconds],
  )
  await db.query(
    `INSERT INTO machine_payment_evidence
       (payment_intent_id, agent_id, user_id, rail, tx_hash, chain_id, resource_url, payer_address,
        settlement_address, token_symbol, token_address, amount_raw, amount_human, amount_sek,
        confirmed_at, created_at)
     VALUES ($1, $2, $3, 'x402', $4, ${CHAIN}, 'https://merchant.example/paid', $5, $6, 'USDC', $7,
             '100000', '0.10', 1.05, NOW() - ($8 * interval '1 second'), NOW() - ($8 * interval '1 second'))`,
    [id, agentId, userId, `0x${'30'.repeat(32)}`, PAYER, MERCHANT, TOKEN, agoSeconds],
  )
  return id
}

/**
 * A Fortnox that belongs to ONE company: `/companyinformation` reports its
 * DatabaseNumber, and every supplier invoice it creates is numbered from its
 * own counter. Invoices are looked up per company, so a number from the
 * other company is a 404 here — exactly what Fortnox answers after a switch.
 */
function fortnoxCompany(databaseNumber: number, name: string) {
  const state = { creates: 0, invoices: new Map<number, string>() }
  let next = databaseNumber * 1000
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (u === FORTNOX_TOKEN_URL && method === 'POST') {
      return json({ access_token: `at-${databaseNumber}-${++seq}`, refresh_token: `rt-${databaseNumber}-${seq}`, token_type: 'Bearer', expires_in: 3600, scope: 'bookkeeping companyinformation' })
    }
    const path = u.startsWith(FORTNOX_API_BASE) ? u.slice(FORTNOX_API_BASE.length) : u
    if (path === '/companyinformation') return json({ CompanyInformation: { CompanyName: name, OrganizationNumber: '556677-8899', DatabaseNumber: databaseNumber } })
    if (path.startsWith('/suppliers?name=')) return json({ Suppliers: [{ SupplierNumber: '1', Name: 'NordShield VPN' }] })
    if (path === '/supplierinvoices' && method === 'POST') {
      state.creates += 1
      const n = ++next
      const payload = (JSON.parse(String(init?.body)) as { SupplierInvoice: { ExternalInvoiceNumber: string } }).SupplierInvoice
      state.invoices.set(n, payload.ExternalInvoiceNumber)
      return json({ SupplierInvoice: { GivenNumber: n, ExternalInvoiceNumber: payload.ExternalInvoiceNumber } })
    }
    const get = path.match(/^\/supplierinvoices\/(\d+)$/)
    if (get && method === 'GET') {
      const ext = state.invoices.get(Number(get[1]))
      if (!ext) return json({ ErrorInformation: { error: 1, message: 'Kunde inte hitta leverantörsfakturan.', code: 2000422 } }, 404)
      return json({ SupplierInvoice: { GivenNumber: Number(get[1]), ExternalInvoiceNumber: ext, Booked: false, Cancelled: false, InvoiceDate: '2026-09-11', Total: 1.05 } })
    }
    return json({ ErrorInformation: { error: 1, message: 'not found', code: 404 } }, 404)
  }) as typeof fetch
  return { impl, state }
}

describeDb('company switch on reconnect (#2864)', () => {
  beforeAll(initDbHarness)
  beforeEach(async () => {
    await resetDb()
    process.env[SECRETS_KEY_ENV] = KEY
    clearConnectors()
    mocks.accountingFeedAvailable.mockReset().mockResolvedValue(true)
    mocks.buildAccountingEntryForPayment.mockReset().mockImplementation(async (_u: string, paymentId: string) => {
      const row = await db.query<{ confirmed_at: Date }>(`SELECT confirmed_at FROM machine_payment_evidence WHERE payment_intent_id = $1`, [paymentId])
      return { ...accountingEntry(paymentId), settledAt: row.rows[0].confirmed_at.toISOString() }
    })
  })
  afterEach(() => {
    delete process.env[SECRETS_KEY_ENV]
  })

  it('reconnecting with a different DatabaseNumber keeps ONE row, replaces the company fields, sets feed_from, and the next sync creates no duplicate push', async () => {
    const { userId, agentId } = await seedUser()

    // Connect to company 111 and feed one settled payment into it.
    const alpha = fortnoxCompany(111, 'Alpha AB')
    registerConnector(new FortnoxConnector(alpha.impl))
    const first = await completeOAuth2Connect({ provider: FORTNOX, cfg: CFG, connector: new FortnoxConnector(alpha.impl), userId, code: 'code-1', fetchImpl: alpha.impl })
    expect(first).toMatchObject({ external_company_id: '111', external_company_name: 'Alpha AB', base_currency: 'SEK', is_active_destination: true })
    // The first connect stamped its floor; the payment below settles after it.
    await new Promise((r) => setTimeout(r, 20))
    const inAlpha = await seedSettled(userId, agentId, 0)
    expect(await syncUser(userId)).toEqual({ fed: 1 })
    const pushed = (await getSyncState(userId, 'fortnox', inAlpha))!
    expect(pushed).toMatchObject({ status: 'pushed', external_ref: 'fortnox:supplierinvoice:111001' })
    expect(alpha.state.creates).toBe(1)

    // Reconnect: the new grant belongs to company 222.
    await new Promise((r) => setTimeout(r, 25))
    const beta = fortnoxCompany(222, 'Beta AB')
    clearConnectors()
    registerConnector(new FortnoxConnector(beta.impl))
    const before = Date.now()
    const switched = await completeOAuth2Connect({ provider: FORTNOX, cfg: CFG, connector: new FortnoxConnector(beta.impl), userId, code: 'code-2', fetchImpl: beta.impl })
    const after = Date.now()

    const rows = await listConnections(userId)
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.id).toBe(first.id)
    expect(row).toMatchObject({ external_company_id: '222', external_company_name: 'Beta AB', base_currency: 'SEK', status: 'connected', is_active_destination: true })
    expect(switched).toMatchObject({ external_company_id: '222', external_company_name: 'Beta AB' })
    // MUTATION TARGET: drop the feed_from stamp on a switch and the floor
    // stays at the FIRST connect's time — the Alpha-era payment is enumerated
    // again and pushed into Beta as a second invoice.
    const feedFrom = new Date(row.feed_from!).getTime()
    expect(feedFrom).toBeGreaterThanOrEqual(before - 1000)
    expect(feedFrom).toBeLessThanOrEqual(after + 1000)
    expect(feedFrom).toBeGreaterThan(new Date(first.feed_from!).getTime())
    expect(row.status_reason).toMatch(/^company switched .*Alpha AB \(111\) → Beta AB \(222\)/)
    expect(companySwitchLog(row)).toEqual([
      { at: new Date(row.feed_from!).toISOString(), fromCompanyId: '111', fromCompanyName: 'Alpha AB', toCompanyId: '222', toCompanyName: 'Beta AB' },
    ])

    // Next sync: the Alpha-era payment is below the floor and already pushed
    // — nothing is enumerated, nothing is created in Beta, the row is untouched.
    expect(await listUnpushedPaymentIds(userId, 'fortnox', 200, row.feed_from)).toEqual([])
    expect(await syncUser(userId)).toEqual({ fed: 0 })
    expect(beta.state.creates).toBe(0)
    expect(await getSyncState(userId, 'fortnox', inAlpha)).toMatchObject({ status: 'pushed', external_ref: pushed.external_ref, attempts: 1 })

    // A payment settled AFTER the switch flows into Beta — the floor is a floor.
    await new Promise((r) => setTimeout(r, 20))
    const inBeta = await seedSettled(userId, agentId, 0)
    expect(await syncUser(userId)).toEqual({ fed: 1 })
    expect(beta.state.creates).toBe(1)
    expect(await getSyncState(userId, 'fortnox', inBeta)).toMatchObject({ status: 'pushed', external_ref: 'fortnox:supplierinvoice:222001' })
    const all = await db.query<{ payment_id: string; status: string }>(`SELECT payment_id, status FROM accounting_feed_syncs WHERE user_id = $1 ORDER BY created_at`, [userId])
    expect(all.rows).toEqual([{ payment_id: inAlpha, status: 'pushed' }, { payment_id: inBeta, status: 'pushed' }])
  })

  it('after the switch, reopen on a pre-switch pushed row is refused with the previous-company reason — no pushed → failed flip', async () => {
    const { userId, agentId } = await seedUser()
    const alpha = fortnoxCompany(111, 'Alpha AB')
    registerConnector(new FortnoxConnector(alpha.impl))
    await completeOAuth2Connect({ provider: FORTNOX, cfg: CFG, connector: new FortnoxConnector(alpha.impl), userId, code: 'code-1', fetchImpl: alpha.impl })
    await new Promise((r) => setTimeout(r, 20))
    const inAlpha = await seedSettled(userId, agentId, 0)
    expect(await syncUser(userId)).toEqual({ fed: 1 })

    await new Promise((r) => setTimeout(r, 25))
    const beta = fortnoxCompany(222, 'Beta AB')
    clearConnectors()
    registerConnector(new FortnoxConnector(beta.impl))
    await completeOAuth2Connect({ provider: FORTNOX, cfg: CFG, connector: new FortnoxConnector(beta.impl), userId, code: 'code-2', fetchImpl: beta.impl })

    // Verify through the ACTIVE connection (now Beta): invoice 111001 does
    // not exist there — "missing: deleted" is what Fortnox honestly answers,
    // and what used to make the row eligible for reopen.
    const verdict = await verifyPushedPayment(userId, inAlpha)
    expect(verdict).toMatchObject({ ok: true, provider: 'fortnox', verification: { registered: false, missing: 'deleted' } })

    // MUTATION TARGET: remove the previous-company guard in
    // `reopenPushedPayment` and this reopens (pushed → failed), after which
    // the next sync re-pushes the Alpha payment into Beta.
    const refused = await reopenPushedPayment(userId, 'fortnox', inAlpha, 'reopened: fortnox invoice 111001 no longer exists')
    expect(refused).toEqual({ reopened: false, error_code: 'previous_company', switched_at: expect.any(String), company_name: 'Alpha AB' })
    expect(await getSyncState(userId, 'fortnox', inAlpha)).toMatchObject({ status: 'pushed', external_ref: 'fortnox:supplierinvoice:111001' })
    expect(await syncUser(userId)).toEqual({ fed: 0 })
    expect(beta.state.creates).toBe(0)

    // Positive control: a post-switch Beta row that Beta genuinely lost IS reopenable.
    await new Promise((r) => setTimeout(r, 20))
    const inBeta = await seedSettled(userId, agentId, 0)
    expect(await syncUser(userId)).toEqual({ fed: 1 })
    beta.state.invoices.clear()
    expect(await verifyPushedPayment(userId, inBeta)).toMatchObject({ ok: true, verification: { registered: false, missing: 'deleted' } })
    expect(await reopenPushedPayment(userId, 'fortnox', inBeta, 'reopened: gone')).toEqual({ reopened: true })
    expect(await getSyncState(userId, 'fortnox', inBeta)).toMatchObject({ status: 'failed' })
  })

  it('a reconnect to the SAME company is not a switch: the floor and the log are untouched', async () => {
    const { userId } = await seedUser()
    const alpha = fortnoxCompany(111, 'Alpha AB')
    registerConnector(new FortnoxConnector(alpha.impl))
    const first = await completeOAuth2Connect({ provider: FORTNOX, cfg: CFG, connector: new FortnoxConnector(alpha.impl), userId, code: 'code-1', fetchImpl: alpha.impl })
    await new Promise((r) => setTimeout(r, 25))
    const again = await completeOAuth2Connect({ provider: FORTNOX, cfg: CFG, connector: new FortnoxConnector(alpha.impl), userId, code: 'code-2', fetchImpl: alpha.impl })
    expect(new Date(again.feed_from!).toISOString()).toBe(new Date(first.feed_from!).toISOString())
    const row = (await getConnection(userId, 'fortnox'))!
    expect(row.status_reason).toBeNull()
    expect(companySwitchLog(row)).toEqual([])
    expect(await reopenPushedPayment(userId, 'fortnox', 'never-pushed', 'x')).toEqual({ reopened: false, error_code: 'not_pushed' })
  })
})
