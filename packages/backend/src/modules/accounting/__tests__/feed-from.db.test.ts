/**
 * The feed-from rule on the REAL database (#2862, epic #2858).
 *
 * Activating a second connection sets its `feed_from` to now, and the next
 * sync feeds nothing settled before it. Three real things are proven here
 * that a `db.js` mock cannot: `activateProvider` stamps the column in the
 * same transaction as the flag; the backfill selection SQL honours the
 * floor; and a settlement AFTER the floor still flows. Mutation target: drop
 * the timestamp from `activateProvider` (or the `$4` predicate from the
 * selection SQL) and the "feeds nothing" assertion goes red.
 *
 * `buildAccountingEntryForPayment` is stubbed (it reads a join the seed
 * below does not fully populate); the selection SQL and the connection rows
 * are real.
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
import { getConnection, upsertConnection } from '../../../infra/repositories/accounting-connections.js'
import { listUnpushedPaymentIds } from '../../../infra/repositories/accounting-feed-syncs.js'
import { SECRETS_KEY_ENV, encryptSecrets } from '../../../infra/secrets.js'
import { InMemoryConnector, clearConnectors, registerConnector } from '../connector.js'
import { activateProvider } from '../connections.js'
import { syncUser } from '../feed-orchestrator.js'
import { accountingEntry } from './connector-conformance.js'

const KEY = randomBytes(32).toString('base64')
const CHAIN = 84532
const TOKEN = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const PAYER = '0x00000000000000000000000000000000000000f1'
const MERCHANT = '0x00000000000000000000000000000000000000aa'

let seq = 0

async function seedUser(): Promise<{ userId: string; agentId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`feed-from-${++seq}-${Date.now()}@test.example`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'feed-from agent') RETURNING id`,
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

async function seedConnection(userId: string, provider: string): Promise<void> {
  const { ciphertext, keyVersion } = encryptSecrets({ apiKey: `${provider}-key` })
  await upsertConnection(userId, {
    provider, authKind: 'api_key', secretsCiphertext: ciphertext, secretsKeyVersion: keyVersion,
    grantedScope: null, tokenExpiresAt: null,
  })
}

describeDb('feed-from on activate (#2862)', () => {
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
      // The entry's settledAt is what the orchestrator's own floor compares;
      // mirror the row so the in-process check and the SQL agree.
      const row = await db.query<{ confirmed_at: Date }>(`SELECT confirmed_at FROM machine_payment_evidence WHERE payment_intent_id = $1`, [paymentId])
      return { ...accountingEntry(paymentId), settledAt: row.rows[0].confirmed_at.toISOString() }
    })
  })
  afterEach(() => {
    delete process.env[SECRETS_KEY_ENV]
  })

  it('activating a second connection stamps feed_from = now in the same transaction as the flag', async () => {
    const { userId } = await seedUser()
    await seedConnection(userId, 'fortnox') // first connection takes the active flag
    await seedConnection(userId, 'memory')
    expect((await getConnection(userId, 'fortnox'))!.is_active_destination).toBe(true)
    expect((await getConnection(userId, 'memory'))!.feed_from).toBeNull()

    const before = Date.now()
    const summary = await activateProvider(userId, 'memory')
    const after = Date.now()

    const memory = (await getConnection(userId, 'memory'))!
    const fortnox = (await getConnection(userId, 'fortnox'))!
    expect(memory.is_active_destination).toBe(true)
    expect(fortnox.is_active_destination).toBe(false)
    expect(memory.feed_from).not.toBeNull()
    const stamped = new Date(memory.feed_from!).getTime()
    expect(stamped).toBeGreaterThanOrEqual(before - 1000)
    expect(stamped).toBeLessThanOrEqual(after + 1000)
    expect(summary).toMatchObject({ provider: 'memory', isActiveDestination: true, feedFrom: memory.feed_from!.toISOString() })
    // A history the user explicitly asked for (#2867's backfill) is a different call.
    await activateProvider(userId, 'fortnox', { feedFrom: new Date('2026-01-01T00:00:00.000Z') })
    expect((await getConnection(userId, 'fortnox'))!.feed_from!.toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })

  it('the next sync feeds NOTHING settled before the switch — and everything after it', async () => {
    const { userId, agentId } = await seedUser()
    connector.connect(userId)
    const history = await seedSettled(userId, agentId, 2 * 86_400) // two days ago
    await seedConnection(userId, 'fortnox')
    await seedConnection(userId, 'memory')

    // The selection with no floor sees the historical payment — the positive
    // control for the assertion below.
    expect(await listUnpushedPaymentIds(userId, 'memory', 200, null)).toEqual([history])

    await activateProvider(userId, 'memory')
    const feedFrom = (await getConnection(userId, 'memory'))!.feed_from!

    // MUTATION TARGET: with the timestamp dropped, the floor is null and the
    // historical payment is enumerated and pushed.
    expect(await listUnpushedPaymentIds(userId, 'memory', 200, feedFrom)).toEqual([])
    expect(await syncUser(userId)).toEqual({ fed: 0 })
    expect(connector.pushed).toHaveLength(0)
    const rows = await db.query(`SELECT * FROM accounting_feed_syncs WHERE user_id = $1`, [userId])
    expect(rows.rows).toHaveLength(0)

    // A settlement AFTER the floor flows — the floor is a floor, not a wall.
    await new Promise((r) => setTimeout(r, 20))
    const fresh = await seedSettled(userId, agentId, 0)
    expect(await syncUser(userId)).toEqual({ fed: 1 })
    expect(connector.pushed.map((p) => p.tx.paymentId)).toEqual([fresh])
    const synced = await db.query<{ payment_id: string; status: string }>(
      `SELECT payment_id, status FROM accounting_feed_syncs WHERE user_id = $1`, [userId],
    )
    expect(synced.rows).toEqual([{ payment_id: fresh, status: 'pushed' }])
  })
})
