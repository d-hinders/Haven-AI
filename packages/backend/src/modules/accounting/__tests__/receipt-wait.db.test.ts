/**
 * #4876 on the REAL database: the retry sweep feeds an x402 payment that the
 * merchant-receipt wait held and whose receipt never arrived.
 *
 * The feed holds an eip3009 or erc7710 payment with no merchant receipt for
 * `MERCHANT_RECEIPT_WAIT_MIN` (owner decision 1 of 2026-11-17 on #4874) and
 * writes no sync row while it waits, so only the sweep's second arm
 * (`LIST_DUE_RETRY_SYNCS_SQL`) can find it afterwards:
 *
 * - erc7710, past the window → due; inside the window → not yet;
 * - eip3009 with its settlement RECORDED, past the window → due (before #4876
 *   such a payment was fed at settlement and never needed the sweep);
 * - eip3009 with no settlement → still waits for #3767's grace, unchanged;
 * - a payment that already has a sync row → left to the first arm.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { beforeAll, beforeEach, expect, it, vi } from 'vitest'

vi.mock('../../agents/index.js', () => ({ accountingFeedAvailable: vi.fn(async () => true) }))

import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { upsertConnection } from '../../../infra/repositories/accounting-connections.js'
import { listDueRetrySyncs } from '../../../infra/repositories/accounting-feed-syncs.js'
import { SECRETS_KEY_ENV, encryptSecrets } from '../../../infra/secrets.js'
import { MERCHANT_RECEIPT_WAIT_MIN } from '../../../domain/merchant-receipt-wait.js'
import { activateProvider } from '../connections.js'

const CHAIN = 84532
const TOKEN = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const PAYER = '0x00000000000000000000000000000000000000f1'
const MERCHANT = '0x00000000000000000000000000000000000000aa'
const GRACE_MIN = 15
const PAST_WINDOW = MERCHANT_RECEIPT_WAIT_MIN * 60 + 60
const INSIDE_WINDOW = 30

let seq = 0

async function seedUserWithDestination(): Promise<{ userId: string; agentId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`receipt-wait-${++seq}-${Date.now()}@test.example`],
  )
  const userId = user.rows[0].id
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'receipt-wait agent') RETURNING id`,
    [userId],
  )
  const { ciphertext, keyVersion } = encryptSecrets({ apiKey: 'memory-key' })
  await upsertConnection(userId, {
    provider: 'memory', authKind: 'api_key', secretsCiphertext: ciphertext, secretsKeyVersion: keyVersion,
    grantedScope: null, tokenExpiresAt: null,
  })
  await activateProvider(userId, 'memory')
  // No feed-from floor: the payments below settled before "now".
  await db.query(`UPDATE accounting_connections SET feed_from = NULL WHERE user_id = $1`, [userId])
  return { userId, agentId: agent.rows[0].id }
}

/** A settled, FX-ready x402 payment confirmed `agoSeconds` ago, with the given intent metadata. */
async function seedX402(
  userId: string,
  agentId: string,
  agoSeconds: number,
  metadata: Record<string, unknown>,
): Promise<string> {
  const id = randomUUID()
  await db.query(
    `INSERT INTO payment_intents
       (id, agent_id, user_id, account_address, chain_id, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash, status, tx_hash,
        confirmed_at, expires_at, machine_metadata, created_at)
     VALUES ($1, $2, $3, $4, ${CHAIN}, 'USDC', $5, $6, '100000', '0.10',
             '0x00000000000000000000000000000000000000d1', 0, $7, 'confirmed', $8,
             NOW() - ($9 * interval '1 second'), NOW() + interval '10 minutes', $10::jsonb,
             NOW() - ($9 * interval '1 second'))`,
    [
      id, agentId, userId, PAYER, TOKEN, MERCHANT,
      `0x${String(++seq).padStart(64, 'c')}`.slice(0, 66), `0x${'30'.repeat(32)}`,
      agoSeconds, JSON.stringify(metadata),
    ],
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

const due = async () => (await listDueRetrySyncs(new Date(), GRACE_MIN, 200)).map((r) => r.payment_id).sort()

describeDb('the sweep feeds a payment the merchant-receipt wait held (#4876)', () => {
  beforeAll(async () => {
    process.env[SECRETS_KEY_ENV] = randomBytes(32).toString('base64')
    await initDbHarness()
  })
  beforeEach(resetDb)

  it('an erc7710 payment with no sync row is due once the receipt window has passed, not before', async () => {
    const { userId, agentId } = await seedUserWithDestination()
    const past = await seedX402(userId, agentId, PAST_WINDOW, { settlement_scheme: 'erc7710' })
    await seedX402(userId, agentId, INSIDE_WINDOW, { settlement_scheme: 'erc7710' })
    expect(await due()).toEqual([past])
  })

  it('an eip3009 payment with its settlement recorded is due once the receipt window has passed', async () => {
    const { userId, agentId } = await seedUserWithDestination()
    const settled = await seedX402(userId, agentId, PAST_WINDOW, {
      settlement_scheme: 'eip3009',
      merchant_settlement_tx_hash: `0x${'5e'.repeat(32)}`,
    })
    expect(await due()).toEqual([settled])
  })

  it("an eip3009 payment with no settlement still waits for #3767's grace", async () => {
    const { userId, agentId } = await seedUserWithDestination()
    await seedX402(userId, agentId, PAST_WINDOW, { settlement_scheme: 'eip3009' })
    expect(await due()).toEqual([])
    const afterGrace = await seedX402(userId, agentId, GRACE_MIN * 60 + 60, { settlement_scheme: 'eip3009' })
    expect(await due()).toEqual([afterGrace])
  })

  it('a payment with no settlement scheme, or one already pinned or synced, is not selected by this arm', async () => {
    const { userId, agentId } = await seedUserWithDestination()
    await seedX402(userId, agentId, PAST_WINDOW, {})
    await seedX402(userId, agentId, PAST_WINDOW, {
      settlement_scheme: 'erc7710',
      accounting_booked_tx_hash: `0x${'77'.repeat(32)}`,
    })
    const synced = await seedX402(userId, agentId, PAST_WINDOW, { settlement_scheme: 'erc7710' })
    await db.query(
      `INSERT INTO accounting_feed_syncs (user_id, provider, payment_id, status, attempts)
       VALUES ($1, 'memory', $2, 'pushed', 1)`,
      [userId, synced],
    )
    expect(await due()).toEqual([])
  })
})
