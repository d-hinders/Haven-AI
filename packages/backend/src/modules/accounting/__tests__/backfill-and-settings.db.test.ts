/**
 * Backfill choice and per-connection settings on the REAL database (#2867,
 * epic #2858, slice 9).
 *
 * Proven here with the real repositories, the real orchestrator and the
 * in-memory connector (the Fortnox payload half — the hint lands in
 * `YourReference` and `Account` is banned — is `fortnox-connector.test.ts`):
 *
 *   - with `feed_from` set, a payment settled before it is never claimed — not
 *     by the settlement hook, not by Sync now;
 *   - `backfillConnection` with an EARLIER `since` moves the floor, records
 *     the choice under `settings.backfill`, and the same payment is claimed
 *     and pushed; a LATER `since` is refused and the floor does not move;
 *   - `auto_feed = false` makes the settlement hook a no-op (no claim row at
 *     all) while `syncUser` — the manual path — still pushes; and the retry
 *     sweep's selection does not enumerate that connection's rows;
 *   - `suggested_account` reaches the connector on the transaction's
 *     `suggestedAccount` field and nowhere else; a per-merchant override wins;
 *   - the settings write is a merge: `companySwitches` and `backfill` survive.
 *
 * Mutation targets, each named at its site: the `feed_from > $3` guard in
 * `RECORD_BACKFILL_SQL` ("a LATER since is refused" goes red); the
 * `auto_feed` early return in `feedSettledPayment` ("the settlement hook is a
 * no-op" goes red); the `auto_feed` predicate in `LIST_DUE_RETRY_SYNCS_SQL`
 * ("the retry sweep does not enumerate" goes red).
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { mocks } = vi.hoisted(() => ({
  mocks: { accountingFeedAvailable: vi.fn(async () => true), buildAccountingEntryForPayment: vi.fn() },
}))
vi.mock('../../agents/index.js', () => ({ accountingFeedAvailable: mocks.accountingFeedAvailable }))
vi.mock('../entry.js', () => ({ buildAccountingEntryForPayment: mocks.buildAccountingEntryForPayment }))

import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import {
  backfillChoice,
  companySwitchLog,
  connectionSettings,
  getConnection,
  recordCompanySwitch,
  upsertConnection, recordBackfill } from '../../../infra/repositories/accounting-connections.js'
import { listDueRetrySyncs, listUnpushedPaymentIds } from '../../../infra/repositories/accounting-feed-syncs.js'
import { SECRETS_KEY_ENV, encryptSecrets } from '../../../infra/secrets.js'
import { InMemoryConnector, clearConnectors, registerConnector } from '../connector.js'
import { BackfillRefusedError, activateProvider, backfillConnection, updateConnectionSettings } from '../connections.js'
import { feedSettledPayment, feedSettledPaymentBestEffort, syncUser } from '../feed-orchestrator.js'
import { accountingEntry } from './connector-conformance.js'

const KEY = randomBytes(32).toString('base64')
const CHAIN = 84532
const TOKEN = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const PAYER = '0x00000000000000000000000000000000000000f1'
const MERCHANT = '0x00000000000000000000000000000000000000aa'
const DAY = 86_400

let seq = 0

async function seedUser(): Promise<{ userId: string; agentId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`backfill-${++seq}-${Date.now()}@test.example`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'backfill agent') RETURNING id`,
    [user.rows[0].id],
  )
  return { userId: user.rows[0].id, agentId: agent.rows[0].id }
}

/** A settled, FX-ready payment confirmed `agoSeconds` ago (the feed-from.db.test.ts seed). */
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

async function seedConnection(userId: string, provider: string): Promise<void> {
  const { ciphertext, keyVersion } = encryptSecrets({ apiKey: `${provider}-key` })
  await upsertConnection(userId, {
    provider, authKind: 'api_key', secretsCiphertext: ciphertext, secretsKeyVersion: keyVersion,
    grantedScope: null, tokenExpiresAt: null,
  })
}

/** An active `memory` destination with `feed_from = now`, exactly as activate leaves it. */
async function activeMemory(userId: string): Promise<Date> {
  await seedConnection(userId, 'fortnox') // takes the flag first
  await seedConnection(userId, 'memory')
  await activateProvider(userId, 'memory')
  return (await getConnection(userId, 'memory'))!.feed_from!
}

async function syncRows(userId: string): Promise<Array<{ payment_id: string; status: string }>> {
  const r = await db.query<{ payment_id: string; status: string }>(
    `SELECT payment_id, status FROM accounting_feed_syncs WHERE user_id = $1 ORDER BY created_at`, [userId],
  )
  return r.rows
}

const daysAgo = (n: number) => new Date(Date.now() - n * DAY * 1000).toISOString()

describeDb('backfill choice and per-connection settings (#2867)', () => {
  let connector: InMemoryConnector

  beforeAll(initDbHarness)
  beforeEach(async () => {
    await resetDb()
    process.env[SECRETS_KEY_ENV] = KEY
    clearConnectors()
    connector = new InMemoryConnector()
    registerConnector(connector)
    mocks.accountingFeedAvailable.mockReset().mockResolvedValue(true)
    mocks.buildAccountingEntryForPayment.mockReset().mockImplementation(async (_u: string, paymentId: string) => {
      const row = await db.query<{ confirmed_at: Date }>(`SELECT confirmed_at FROM machine_payment_evidence WHERE payment_intent_id = $1`, [paymentId])
      // No per-merchant override by default, so the connection's hint is what the connector sees.
      return { ...accountingEntry(paymentId), settledAt: row.rows[0].confirmed_at.toISOString(), account: null }
    })
  })
  afterEach(() => {
    delete process.env[SECRETS_KEY_ENV]
  })

  describe('backfill', () => {
    it('a payment settled before feed_from is never claimed; an EARLIER since makes it claimable and feeds it', async () => {
      const { userId, agentId } = await seedUser()
      connector.connect(userId)
      const history = await seedSettled(userId, agentId, 2 * DAY)
      const floor = await activeMemory(userId)

      // Neither path touches it: no claim row, nothing pushed.
      expect(await feedSettledPayment(userId, history)).toEqual({ outcome: 'not_fed' })
      expect(await syncUser(userId)).toEqual({ fed: 0 })
      expect(await syncRows(userId)).toEqual([])
      expect(connector.pushed).toHaveLength(0)

      // The user chooses to include the last three days.
      const since = daysAgo(3)
      const result = await backfillConnection(userId, 'memory', since)
      expect(result).toEqual({ feedFrom: since, fed: 1 })
      const row = (await getConnection(userId, 'memory'))!
      expect(row.feed_from!.toISOString()).toBe(since)
      expect(new Date(row.feed_from!).getTime()).toBeLessThan(floor.getTime())
      expect(backfillChoice(row)).toMatchObject({ since })
      expect(new Date(backfillChoice(row)!.requestedAt).getTime()).toBeGreaterThanOrEqual(floor.getTime() - 1000)
      // Claimed and pushed — the real ledger and the real connector.
      expect(await syncRows(userId)).toEqual([{ payment_id: history, status: 'pushed' }])
      expect(connector.pushed.map((p) => p.tx.paymentId)).toEqual([history])
      // Resumable and idempotent: a second Sync now finds nothing new.
      expect(await syncUser(userId)).toEqual({ fed: 0 })
      expect(connector.pushed).toHaveLength(1)
    })

    it('a LATER since is refused with SINCE_NOT_EARLIER and the floor does not move; a second, even earlier backfill moves it again', async () => {
      const { userId, agentId } = await seedUser()
      connector.connect(userId)
      const old = await seedSettled(userId, agentId, 10 * DAY)
      await activeMemory(userId)
      // A floor in the past (what activate stamped five days ago), so that
      // "later than the floor" and "in the past" can both hold.
      const floor = new Date(daysAgo(5))
      await activateProvider(userId, 'memory', { feedFrom: floor })

      // MUTATION TARGET (`feed_from > $3` in RECORD_BACKFILL_SQL): without
      // the guard a later date moves the floor forward and is "accepted".
      await expect(backfillConnection(userId, 'memory', daysAgo(4)))
        .rejects.toMatchObject({ name: 'BackfillRefusedError', code: 'SINCE_NOT_EARLIER' })
      await expect(backfillConnection(userId, 'memory', floor.toISOString()))
        .rejects.toMatchObject({ code: 'SINCE_NOT_EARLIER' })
      const unchanged = (await getConnection(userId, 'memory'))!
      expect(unchanged.feed_from!.toISOString()).toBe(floor.toISOString())
      expect(backfillChoice(unchanged)).toBeNull()
      expect(await syncRows(userId)).toEqual([])

      // Earlier than the floor, but not far enough for the 10-day-old payment.
      await backfillConnection(userId, 'memory', daysAgo(7))
      expect(connector.pushed).toHaveLength(0)
      // Later than the NEW floor (7 days) is refused too — the rule is
      // against the current floor, not the activate-time one.
      await expect(backfillConnection(userId, 'memory', daysAgo(6))).rejects.toMatchObject({ code: 'SINCE_NOT_EARLIER' })
      // Earlier again: now the payment flows.
      const twelve = daysAgo(12)
      expect(await backfillConnection(userId, 'memory', twelve)).toEqual({ feedFrom: twelve, fed: 1 })
      expect(connector.pushed.map((p) => p.tx.paymentId)).toEqual([old])
      expect(backfillChoice((await getConnection(userId, 'memory'))!)!.since).toBe(twelve)
    })

    it('a connection with NO floor, a non-active one and an invalid since are refused before anything is written', async () => {
      const { userId } = await seedUser()
      connector.connect(userId)
      await seedConnection(userId, 'memory') // first connect: active, floor stamped
      await db.query(`UPDATE accounting_connections SET feed_from = NULL WHERE user_id = $1`, [userId]) // a pre-#2862 row
      await expect(backfillConnection(userId, 'memory', daysAgo(3))).rejects.toMatchObject({ code: 'SINCE_NOT_EARLIER' })
      expect((await getConnection(userId, 'memory'))!.feed_from).toBeNull()

      await seedConnection(userId, 'fortnox') // not the destination
      await expect(backfillConnection(userId, 'fortnox', daysAgo(3))).rejects.toMatchObject({ code: 'NOT_ACTIVE' })
      await expect(backfillConnection(userId, 'nope', daysAgo(3))).rejects.toMatchObject({ code: 'NOT_FOUND' })
      for (const bad of [undefined, '', 'soon', '2999-01-01', '2019-12-31T23:59:59Z']) {
        await expect(backfillConnection(userId, 'memory', bad)).rejects.toBeInstanceOf(BackfillRefusedError)
        await expect(backfillConnection(userId, 'memory', bad)).rejects.toMatchObject({ code: 'SINCE_INVALID' })
      }
      expect(backfillChoice((await getConnection(userId, 'memory'))!)).toBeNull()

      // The guard lives in the STATEMENT, not only in the caller (review on
      // #2901): a direct recordBackfill on a non-active / non-connected row
      // moves nothing. MUTATION TARGET: drop the is_active_destination /
      // status predicate from RECORD_BACKFILL_SQL.
      // Both rows get a floor LATER than `since`, so only the guard can refuse.
      await db.query(`UPDATE accounting_connections SET feed_from = NOW() WHERE user_id = $1`, [userId])
      expect(await recordBackfill(userId, 'fortnox', { since: new Date(daysAgo(3)), requestedAt: new Date() })).toBeNull() // not active
      await db.query(`UPDATE accounting_connections SET status = 'scope_missing' WHERE user_id = $1 AND provider = 'memory'`, [userId])
      expect(await recordBackfill(userId, 'memory', { since: new Date(daysAgo(3)), requestedAt: new Date() })).toBeNull() // active but not connected
      for (const provider of ['fortnox', 'memory']) {
        const row = (await getConnection(userId, provider))!
        expect(row.feed_from!.getTime()).toBeGreaterThan(Date.now() - 60_000)
        expect(backfillChoice(row)).toBeNull()
      }
    })

    it("a malformed settings.auto_feed value (direct DB edit) never fails the sweep's due-rows query (review on #2901)", async () => {
      const { userId } = await seedUser()
      connector.connect(userId)
      await seedConnection(userId, 'memory')
      await db.query(`UPDATE accounting_connections SET settings = settings || '{"auto_feed":"maybe"}' WHERE user_id = $1`, [userId])
      // MUTATION TARGET: a ::boolean cast throws "invalid input syntax" here and takes every user's tick down.
      await expect(listDueRetrySyncs(new Date(), 200)).resolves.toBeInstanceOf(Array)
    })
  })

  describe('auto_feed', () => {
    it('auto_feed=false: the settlement hook is a no-op (no claim row), manual sync still pushes', async () => {
      const { userId, agentId } = await seedUser()
      connector.connect(userId)
      await activeMemory(userId)
      await new Promise((r) => setTimeout(r, 20))
      const fresh = await seedSettled(userId, agentId, 0)
      const summary = await updateConnectionSettings(userId, 'memory', { auto_feed: false })
      expect(summary.settings).toEqual({ suggestedAccount: null, autoFeed: false })

      // The hook, both shapes: the fire-and-forget wrapper and the awaited call.
      // MUTATION TARGET (the `auto_feed` early return in feedSettledPayment):
      // without it the hook claims and pushes for a manual-only user.
      feedSettledPaymentBestEffort(userId, fresh)
      await new Promise((r) => setTimeout(r, 50))
      expect(await feedSettledPayment(userId, fresh)).toEqual({ outcome: 'not_fed' })
      expect(await syncRows(userId)).toEqual([])
      expect(connector.pushed).toHaveLength(0)
      // The selection still sees it — it is unclaimed, waiting for the user.
      expect(await listUnpushedPaymentIds(userId, 'memory', 200, null)).toEqual([fresh])

      // Sync now is the user's own action: it pushes.
      expect(await syncUser(userId)).toEqual({ fed: 1 })
      expect(await syncRows(userId)).toEqual([{ payment_id: fresh, status: 'pushed' }])
      expect(connector.pushed.map((p) => p.tx.paymentId)).toEqual([fresh])

      // Back on: the hook feeds again (positive control for the gate).
      await updateConnectionSettings(userId, 'memory', { auto_feed: true })
      const next = await seedSettled(userId, agentId, 0)
      expect(await feedSettledPayment(userId, next)).toEqual({ outcome: 'pushed' })
      expect(connector.pushed).toHaveLength(2)
    })

    it('auto_feed=false: the retry sweep does not enumerate the connection\'s failed rows; on again, it does', async () => {
      const { userId, agentId } = await seedUser()
      connector.connect(userId)
      await activeMemory(userId)
      const paymentId = await seedSettled(userId, agentId, 0)
      await db.query(
        `INSERT INTO accounting_feed_syncs (user_id, provider, payment_id, status, attempts, error, updated_at)
         VALUES ($1, 'memory', $2, 'failed', 1, 'provider 500', NOW() - interval '1 hour')`,
        [userId, paymentId],
      )
      // Positive control: due with the default setting.
      expect((await listDueRetrySyncs(new Date(), 200)).map((r) => r.payment_id)).toEqual([paymentId])
      await updateConnectionSettings(userId, 'memory', { auto_feed: false })
      // MUTATION TARGET (the `auto_feed` predicate in LIST_DUE_RETRY_SYNCS_SQL).
      expect(await listDueRetrySyncs(new Date(), 200)).toEqual([])
      await updateConnectionSettings(userId, 'memory', { auto_feed: true })
      expect((await listDueRetrySyncs(new Date(), 200)).map((r) => r.payment_id)).toEqual([paymentId])
    })
  })

  describe('suggested_account and the settings merge', () => {
    it('the hint reaches the connector as `suggestedAccount` only; a per-merchant override wins; null clears', async () => {
      const { userId, agentId } = await seedUser()
      connector.connect(userId)
      await activeMemory(userId)
      await new Promise((r) => setTimeout(r, 20))
      await updateConnectionSettings(userId, 'memory', { suggested_account: '6540' })

      const a = await seedSettled(userId, agentId, 0)
      expect(await feedSettledPayment(userId, a)).toEqual({ outcome: 'pushed' })
      const pushedA = connector.pushed.find((p) => p.tx.paymentId === a)!.tx
      expect(pushedA.suggestedAccount).toBe('6540')
      // The transaction shape carries it in ONE field and no asserting one.
      expect(Object.keys(pushedA)).not.toEqual(expect.arrayContaining(['account', 'Account', 'vatTreatment']))

      // A per-merchant override (entry.account) beats the connection default.
      mocks.buildAccountingEntryForPayment.mockImplementationOnce(async (_u: string, paymentId: string) => {
        const row = await db.query<{ confirmed_at: Date }>(`SELECT confirmed_at FROM machine_payment_evidence WHERE payment_intent_id = $1`, [paymentId])
        return { ...accountingEntry(paymentId), settledAt: row.rows[0].confirmed_at.toISOString(), account: '5410' }
      })
      const b = await seedSettled(userId, agentId, 0)
      expect(await feedSettledPayment(userId, b)).toEqual({ outcome: 'pushed' })
      expect(connector.pushed.find((p) => p.tx.paymentId === b)!.tx.suggestedAccount).toBe('5410')

      // Cleared: no hint at all.
      await updateConnectionSettings(userId, 'memory', { suggested_account: null })
      const c = await seedSettled(userId, agentId, 0)
      expect(await feedSettledPayment(userId, c)).toEqual({ outcome: 'pushed' })
      expect(connector.pushed.find((p) => p.tx.paymentId === c)!.tx.suggestedAccount).toBeNull()
    })

    it('the settings write is a JSONB merge: companySwitches and backfill survive, and the raw column holds the stored keys', async () => {
      const { userId, agentId } = await seedUser()
      connector.connect(userId)
      await seedSettled(userId, agentId, 5 * DAY)
      await activeMemory(userId)
      const switched = await recordCompanySwitch(userId, 'memory', {
        from: { externalCompanyId: 'mem-1', name: 'Memory AB' },
        to: { externalCompanyId: 'mem-2', name: 'Other AB', baseCurrency: 'SEK' },
        at: new Date(),
        reason: 'switched',
      })
      expect(companySwitchLog(switched!)).toHaveLength(1)
      const since = daysAgo(7)
      await backfillConnection(userId, 'memory', since)

      const summary = await updateConnectionSettings(userId, 'memory', { suggested_account: '4010', auto_feed: false })
      expect(summary.settings).toEqual({ suggestedAccount: '4010', autoFeed: false })
      const row = (await getConnection(userId, 'memory'))!
      expect(row.settings).toMatchObject({ suggested_account: '4010', auto_feed: false })
      expect(companySwitchLog(row)).toHaveLength(1)
      expect(companySwitchLog(row)[0]).toMatchObject({ fromCompanyId: 'mem-1', toCompanyId: 'mem-2' })
      expect(backfillChoice(row)).toMatchObject({ since })
      expect(connectionSettings(row)).toEqual({ suggestedAccount: '4010', autoFeed: false })

      // And the other direction: a later backfill keeps the settings.
      await backfillConnection(userId, 'memory', daysAgo(30))
      expect(connectionSettings((await getConnection(userId, 'memory'))!)).toEqual({ suggestedAccount: '4010', autoFeed: false })
    })
  })
})
