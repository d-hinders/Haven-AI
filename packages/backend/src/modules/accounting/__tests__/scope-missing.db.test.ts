/**
 * Scope-missing detection and re-consent, on the REAL database (#2865,
 * epic #2858). The real generic OAuth2 flow, the real Fortnox connector on a
 * fixture `fetch`, the real repositories, the real orchestrator and the real
 * retry sweep (#2866) with an injected clock. Three sequences:
 *
 *   1. the callback compares the granted scope string with the descriptor:
 *      a narrower grant is STORED (secrets, active flag) but `scope_missing`,
 *      with the missing scopes named; a full-scope re-consent restores it;
 *   2. POST-push: the attachment step hits Fortnox's `[2000663]` — the row
 *      stays `pushed` with its note, the CONNECTION flips, and after the
 *      re-consent the sweep does NOT re-push: exactly ONE supplier-invoice
 *      POST across the whole sequence;
 *   3. PRE-push: the invoice POST itself is refused for scope — the row is
 *      `skipped` with the reason, the connection flips, the sweep leaves the
 *      row alone while `scope_missing`, and the re-consent keeps `settings`,
 *      `feed_from`, the active flag, the switch log and the sync history
 *      byte-for-byte — after which the next sweep delivers the skipped row
 *      exactly once.
 *
 * Mutation targets, each named at its site: the scope comparison in
 * `completeOAuth2Connect` (test 1 goes red); the post-push branch in
 * `feedSettledPayment` marking the row `skipped` instead of `pushed` (test 2:
 * a second invoice); the `settings`/`feed_from` preservation in
 * `UPSERT_ACCOUNTING_CONNECTION_SQL` (test 3: preservation); the pre-push
 * flip in `feedSettledPayment` / the catch around the invoice POST in
 * `pushWithToken` (test 3: the connection stays connected).
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
      accountingEnabled: true,
      fortnoxClientId: 'cid',
      fortnoxClientSecret: 'csecret',
      fortnoxRedirectUri: 'https://api.test/accounting/connections/fortnox/callback',
    },
  }
})
// A fixed small PDF so the attachment step RUNS and its scope failure is reachable.
vi.mock('../receipt-underlag.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../receipt-underlag.js')>()),
  loadReceiptUnderlag: async () => ({ filename: 'haven-receipt.pdf', pdf: Buffer.from('%PDF-1.4 fixture') }),
}))

import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { companySwitchLog, getConnection, listConnections } from '../../../infra/repositories/accounting-connections.js'
import { getSyncState, listDueRetrySyncs } from '../../../infra/repositories/accounting-feed-syncs.js'
import { SECRETS_KEY_ENV, decryptSecrets } from '../../../infra/secrets.js'
import { clearConnectors, registerConnector } from '../connector.js'
import { getDestinationSummary, toConnectionSummary } from '../connections.js'
import { feedSettledPayment, syncUser } from '../feed-orchestrator.js'
import { FortnoxConnector } from '../fortnox-connector.js'
import { FORTNOX_API_BASE, FORTNOX_SCOPE, FORTNOX_TOKEN_URL, fortnoxOAuth2Config } from '../fortnox.js'
import { completeOAuth2Connect, type OAuth2Secrets } from '../oauth-flow.js'
import { FORTNOX } from '../registry.js'
import { resetRetrySweepState, runRetrySweep } from '../retry-sweep.js'
import { accountingEntry } from './connector-conformance.js'

const KEY = randomBytes(32).toString('base64')
const CHAIN = 84532
const TOKEN = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const PAYER = '0x00000000000000000000000000000000000000f1'
const MERCHANT = '0x00000000000000000000000000000000000000aa'
const CFG = fortnoxOAuth2Config({ clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://api.test/cb' })
const NARROW_SCOPE = 'bookkeeping supplierinvoice supplier archive inbox'
const SCOPE_ERROR = { ErrorInformation: { error: 1, message: 'Har inte behörighet för scope.', code: 2000663 } }

/** The sweep's clock: two hours on, so every backoff has elapsed and no test waits. */
const later = () => new Date(Date.now() + 2 * 60 * 60_000)

let seq = 0

async function seedUser(): Promise<{ userId: string; agentId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`scope-missing-${++seq}-${Date.now()}@test.example`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'scope-missing agent') RETURNING id`,
    [user.rows[0].id],
  )
  return { userId: user.rows[0].id, agentId: agent.rows[0].id }
}

/** A settled, FX-ready payment confirmed now — what the backfill enumerates and the sweep re-feeds. */
async function seedSettled(userId: string, agentId: string): Promise<string> {
  const id = randomUUID()
  await db.query(
    `INSERT INTO payment_intents
       (id, agent_id, user_id, safe_address, chain_id, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash, status, tx_hash,
        confirmed_at, expires_at, created_at)
     VALUES ($1, $2, $3, $4, ${CHAIN}, 'USDC', $5, $6, '100000', '0.10',
             '0x00000000000000000000000000000000000000d1', 0, $7, 'confirmed', $8,
             NOW(), NOW() + interval '10 minutes', NOW())`,
    [id, agentId, userId, PAYER, TOKEN, MERCHANT, `0x${String(++seq).padStart(64, 'c')}`.slice(0, 66), `0x${'30'.repeat(32)}`],
  )
  await db.query(
    `INSERT INTO machine_payment_evidence
       (payment_intent_id, agent_id, user_id, rail, tx_hash, chain_id, resource_url, payer_address,
        settlement_address, token_symbol, token_address, amount_raw, amount_human, amount_sek,
        confirmed_at, created_at)
     VALUES ($1, $2, $3, 'x402', $4, ${CHAIN}, 'https://merchant.example/paid', $5, $6, 'USDC', $7,
             '100000', '0.10', 1.05, NOW(), NOW())`,
    [id, agentId, userId, `0x${'30'.repeat(32)}`, PAYER, MERCHANT, TOKEN],
  )
  return id
}

/**
 * One Fortnox tenant with three knobs: what scope string the token endpoint
 * echoes, whether the invoice POST is refused for scope (pre-push), and
 * whether the file connection is (post-push). `creates` counts invoices that
 * actually came into existence.
 */
function fortnox() {
  const state = { tokenScope: FORTNOX_SCOPE, refuseInvoice: false, refuseFileConnection: false, creates: 0, invoicePosts: 0 }
  let next = 5000
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (u === FORTNOX_TOKEN_URL && method === 'POST') {
      return json({ access_token: `at-${++seq}`, refresh_token: `rt-${seq}`, token_type: 'Bearer', expires_in: 3600, scope: state.tokenScope })
    }
    const path = u.startsWith(FORTNOX_API_BASE) ? u.slice(FORTNOX_API_BASE.length) : u
    if (path === '/companyinformation') return json({ CompanyInformation: { CompanyName: 'Scope AB', OrganizationNumber: '556677-8899', DatabaseNumber: 777 } })
    if (path.startsWith('/suppliers?name=')) return json({ Suppliers: [{ SupplierNumber: '1', Name: 'NordShield VPN' }] })
    if (path === '/supplierinvoices' && method === 'POST') {
      state.invoicePosts += 1
      if (state.refuseInvoice) return json(SCOPE_ERROR, 400)
      state.creates += 1
      const payload = (JSON.parse(String(init?.body)) as { SupplierInvoice: { ExternalInvoiceNumber: string } }).SupplierInvoice
      return json({ SupplierInvoice: { GivenNumber: ++next, ExternalInvoiceNumber: payload.ExternalInvoiceNumber } })
    }
    if (path === '/inbox' && method === 'POST') return json({ File: { Id: 'file-1' } })
    if (path === '/supplierinvoicefileconnections' && method === 'POST') {
      return state.refuseFileConnection ? json(SCOPE_ERROR, 400) : json({ SupplierInvoiceFileConnection: { FileId: 'file-1' } })
    }
    return json({ ErrorInformation: { error: 1, message: 'not found', code: 404 } }, 404)
  }) as typeof fetch
  return { impl, state }
}

const connect = (f: ReturnType<typeof fortnox>, userId: string, code: string) =>
  completeOAuth2Connect({ provider: FORTNOX, cfg: CFG, connector: new FortnoxConnector(f.impl), userId, code, fetchImpl: f.impl })

describeDb('scope-missing detection and re-consent (#2865)', () => {
  beforeAll(initDbHarness)
  beforeEach(async () => {
    await resetDb()
    resetRetrySweepState()
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

  it('a callback with a NARROWER scope than required stores the connection as scope_missing naming the missing scopes; a full-scope re-consent restores connected', async () => {
    const { userId } = await seedUser()
    const f = fortnox()
    f.state.tokenScope = NARROW_SCOPE
    registerConnector(new FortnoxConnector(f.impl))
    const stored = await connect(f, userId, 'code-narrow')

    // MUTATION TARGET: skip `recordScopeShortfall` in `completeOAuth2Connect`
    // and this row is `connected` with a grant that cannot attach files.
    const row = (await getConnection(userId, 'fortnox'))!
    expect(row).toMatchObject({ status: 'scope_missing', is_active_destination: true, granted_scope: NARROW_SCOPE, external_company_id: '777' })
    expect(row.status_reason).toMatch(/^missing scopes: connectfile, companyinformation — /)
    expect(stored.status).toBe('scope_missing')
    // Not a refusal: the grant IS stored (encrypted), the destination flag taken.
    const secrets = decryptSecrets<OAuth2Secrets>(row.secrets_ciphertext!, row.secrets_key_version)
    expect(secrets.scope).toBe(NARROW_SCOPE)
    expect(toConnectionSummary(row).missingScopes).toEqual(['connectfile', 'companyinformation'])
    // What `GET /accounting/feed/status` reads: the destination row, whatever its status.
    expect(await getDestinationSummary(userId)).toMatchObject({ status: 'scope_missing', missingScopes: ['connectfile', 'companyinformation'] })

    // Re-consent with the full scope set: the same row, `connected`, nothing missing.
    f.state.tokenScope = FORTNOX_SCOPE
    const again = await connect(f, userId, 'code-full')
    expect(again).toMatchObject({ id: row.id, status: 'connected', status_reason: null, granted_scope: FORTNOX_SCOPE })
    expect(toConnectionSummary((await getConnection(userId, 'fortnox'))!).missingScopes).toEqual([])
    expect(await listConnections(userId)).toHaveLength(1)
  })

  it('POST-push: an attachment-step [2000663] flips the connection and leaves the row pushed with its note; after reconnect the sweep does NOT re-push — exactly ONE supplier-invoice POST', async () => {
    const { userId, agentId } = await seedUser()
    const f = fortnox()
    registerConnector(new FortnoxConnector(f.impl))
    await connect(f, userId, 'code-1')
    await new Promise((r) => setTimeout(r, 20))

    // The grant looked complete, but the file connection is refused.
    f.state.refuseFileConnection = true
    const pid = await seedSettled(userId, agentId)
    expect(await syncUser(userId)).toEqual({ fed: 1 })
    const pushed = (await getSyncState(userId, 'fortnox', pid))!
    expect(pushed).toMatchObject({ status: 'pushed', attempts: 1 })
    expect(pushed.external_ref).toMatch(/^fortnox:supplierinvoice:\d+$/)
    expect(pushed.error).toMatch(/receipt attachment failed: .*\[2000663\]/)
    expect(f.state.invoicePosts).toBe(1)

    const degraded = (await getConnection(userId, 'fortnox'))!
    expect(degraded).toMatchObject({ status: 'scope_missing', is_active_destination: true })
    expect(degraded.status_reason).toMatch(/^missing scopes: connectfile — receipt attachment failed/)
    expect(toConnectionSummary(degraded).missingScopes).toEqual(['connectfile'])

    // While scope_missing: no destination — a new payment is not fed, the sweep sees no due row.
    const second = await seedSettled(userId, agentId)
    expect(await feedSettledPayment(userId, second)).toEqual({ outcome: 'not_fed' })
    expect(await getSyncState(userId, 'fortnox', second)).toBeNull()
    expect(await listDueRetrySyncs(later(), 200)).toEqual([])

    // Re-consent (Fortnox now honours the file connection), then the sweep.
    f.state.refuseFileConnection = false
    const reconnected = await connect(f, userId, 'code-2')
    expect(reconnected).toMatchObject({ id: degraded.id, status: 'connected', status_reason: null, is_active_destination: true })
    const sleeps: number[] = []
    const sweep = await runRetrySweep({ now: later, sleep: async (ms) => { sleeps.push(ms) } })
    // MUTATION TARGET (`feedSettledPayment`, post-push branch): marking the
    // row `skipped` makes it due here and the sweep creates a SECOND invoice.
    expect(sweep).toMatchObject({ considered: 0, pushed: 0 })
    expect(await getSyncState(userId, 'fortnox', pid)).toMatchObject({ status: 'pushed', external_ref: pushed.external_ref, attempts: 1 })
    expect(f.state.invoicePosts).toBe(1)
    expect(f.state.creates).toBe(1)

    // Positive control: the sweep and the backfill DO deliver the payment that
    // was never fed — a different invoice, the first one untouched.
    expect(await syncUser(userId)).toEqual({ fed: 1 })
    expect(await getSyncState(userId, 'fortnox', second)).toMatchObject({ status: 'pushed' })
    expect(f.state.invoicePosts).toBe(2)
    expect(await getSyncState(userId, 'fortnox', pid)).toMatchObject({ status: 'pushed', external_ref: pushed.external_ref })
  })

  it('PRE-push: an invoice POST refused for scope marks the row skipped and flips the connection; the sweep skips it while scope_missing; reconnect keeps settings/feed_from byte-equal and the next sweep feeds it once', async () => {
    const { userId, agentId } = await seedUser()
    const f = fortnox()
    registerConnector(new FortnoxConnector(f.impl))
    const first = await connect(f, userId, 'code-1')
    // The user's configuration and an earlier switch log — what a re-consent must not lose.
    await db.query(
      `UPDATE accounting_connections SET settings = $2::jsonb WHERE user_id = $1 AND provider = 'fortnox'`,
      [userId, JSON.stringify({ autoFeed: false, suggestedAccount: '6540', companySwitches: [{ at: '2026-09-01T00:00:00.000Z', fromCompanyId: '111', fromCompanyName: 'Old AB', toCompanyId: '777', toCompanyName: 'Scope AB' }] })],
    )
    await new Promise((r) => setTimeout(r, 20))

    f.state.refuseInvoice = true
    const pid = await seedSettled(userId, agentId)
    expect(await syncUser(userId)).toEqual({ fed: 1 })
    const skipped = (await getSyncState(userId, 'fortnox', pid))!
    expect(skipped).toMatchObject({ status: 'skipped', external_ref: null, attempts: 1 })
    expect(skipped.error).toMatch(/^scope refused before the invoice was created: .*\[2000663\]/)
    expect(f.state.creates).toBe(0)
    expect(f.state.invoicePosts).toBe(1)
    // MUTATION TARGET (`feedSettledPayment` skipped branch / the catch in
    // `pushWithToken`): without the flip the connection stays `connected`,
    // the row is due, and the sweep repeats the refusal until exhausted.
    const before = (await getConnection(userId, 'fortnox'))!
    expect(before).toMatchObject({ status: 'scope_missing', is_active_destination: true })
    expect(before.status_reason).toMatch(/^missing scopes: supplierinvoice — scope refused before the invoice was created/)
    expect(toConnectionSummary(before).missingScopes).toEqual(['supplierinvoice'])

    // The sweep leaves the skipped row alone while the connection is scope_missing.
    expect(await runRetrySweep({ now: later, sleep: async () => {} })).toMatchObject({ considered: 0 })
    expect(await getSyncState(userId, 'fortnox', pid)).toMatchObject({ status: 'skipped', attempts: 1 })
    expect(f.state.invoicePosts).toBe(1)

    // Re-consent: Fortnox now honours the invoice POST.
    f.state.refuseInvoice = false
    await new Promise((r) => setTimeout(r, 20))
    const after = await connect(f, userId, 'code-2')
    const rows = await listConnections(userId)
    expect(rows).toHaveLength(1)
    const reconnected = rows[0]
    expect(reconnected).toMatchObject({ id: first.id, status: 'connected', status_reason: null, is_active_destination: true, external_company_id: '777' })
    expect(after.status).toBe('connected')
    // MUTATION TARGET (`UPSERT_ACCOUNTING_CONNECTION_SQL`): resetting
    // `settings` or `feed_from` on the conflict path loses the user's
    // configuration, the switch log and the feed-from floor.
    expect(JSON.stringify(reconnected.settings)).toBe(JSON.stringify(before.settings))
    expect(reconnected.settings).toMatchObject({ autoFeed: false, suggestedAccount: '6540' })
    expect(companySwitchLog(reconnected)).toEqual(companySwitchLog(before))
    expect(new Date(reconnected.feed_from!).toISOString()).toBe(new Date(first.feed_from!).toISOString())
    expect(new Date(reconnected.feed_from!).toISOString()).toBe(new Date(before.feed_from!).toISOString())
    // The sync history is untouched by the re-consent: still one row, still skipped.
    expect(await getSyncState(userId, 'fortnox', pid)).toMatchObject({ id: skipped.id, status: 'skipped', attempts: 1 })

    // Now the skipped row is due, and the sweep delivers it exactly once.
    const sweep = await runRetrySweep({ now: later, sleep: async () => {} })
    expect(sweep).toMatchObject({ considered: 1, pushed: 1 })
    expect(await getSyncState(userId, 'fortnox', pid)).toMatchObject({ status: 'pushed', attempts: 2, external_ref: expect.stringMatching(/^fortnox:supplierinvoice:\d+$/) })
    expect(f.state.creates).toBe(1)
    expect((await getConnection(userId, 'fortnox'))!.status).toBe('connected')
    // And a second sweep has nothing left to do.
    expect(await runRetrySweep({ now: later, sleep: async () => {} })).toMatchObject({ considered: 0 })
    expect(f.state.creates).toBe(1)
  })
})
