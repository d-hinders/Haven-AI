/**
 * Real-DB tests for the x402-authorizations repository (#1222, epic #1219).
 *
 * The x402 authorize → settle lifecycle over `payment_intents`, proven
 * against Postgres on the #1220 harness. Zero mocks. Follows the #1221
 * reference; row builders are local per the harness's domain-free rule.
 *
 * The correctness at stake: can an authorization be settled twice, settled
 * after expiry, revived after it progressed, or found under the wrong
 * agent's key. Each guard is exercised on BOTH sides — the row that must
 * transition and the row that must not.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import {
  confirmX402Intent,
  failPendingX402Intent,
  findSettleIntent,
  findX402IntentByIdempotencyKey,
  getX402HourlyUsage,
  markIntentSubmittedForSettlement,
  recordX402Signature,
} from '../x402-authorizations.js'

let seq = 0

async function seedAgent(maxX402PerHour?: number): Promise<{ agentId: string; userId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`x402-${++seq}-${Date.now()}@test.example`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, max_x402_per_hour) VALUES ($1, 'x402 agent', $2) RETURNING id`,
    [user.rows[0].id, maxX402PerHour ?? null],
  )
  return { agentId: agent.rows[0].id, userId: user.rows[0].id }
}

interface IntentSeed {
  agentId: string
  userId: string
  status?: string
  source?: string
  paymentRail?: string | null
  x402Key?: string | null
  machineKey?: string | null
  expiresAt?: string // SQL expression fragment is NOT accepted — a timestamptz literal
  allowanceNonce?: number
  signHash?: string
  signature?: string | null
  txHash?: string | null
  createdAt?: string | null
  executionRail?: string | null
}

async function seedIntent(seed: IntentSeed): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO payment_intents
       (agent_id, user_id, safe_address, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
        status, expires_at, source, payment_rail, x402_idempotency_key,
        machine_idempotency_key, signature, tx_hash, created_at, execution_rail)
     VALUES ($1, $2, '0x00000000000000000000000000000000000000f1', 'USDC',
             '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
             '0x00000000000000000000000000000000000000aa',
             '100000', '0.10', '0x00000000000000000000000000000000000000d1',
             $3, $4, $5, COALESCE($6::timestamptz, NOW() + interval '10 minutes'),
             $7, $8, $9, $10, $11, $12, COALESCE($13::timestamptz, NOW()), $14)
     RETURNING id`,
    [
      seed.agentId,
      seed.userId,
      seed.allowanceNonce ?? 1,
      seed.signHash ?? `0x${String(++seq).padStart(64, 'a')}`.slice(0, 66),
      seed.status ?? 'pending_signature',
      seed.expiresAt ?? null,
      seed.source ?? 'x402',
      seed.paymentRail ?? null,
      seed.x402Key ?? null,
      seed.machineKey ?? null,
      seed.signature ?? null,
      seed.txHash ?? null,
      seed.createdAt ?? null,
      seed.executionRail ?? null,
    ],
  )
  return result.rows[0].id
}

async function readIntent(id: string) {
  const r = await db.query(`SELECT * FROM payment_intents WHERE id = $1`, [id])
  return r.rows[0]
}

describeDb('x402-authorizations repository (#1222)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  // ── Hourly cap (#961) ──────────────────────────────────────────────────

  it('hourly usage counts only the last hour and only x402 rows, and defaults the cap to 100', async () => {
    const { agentId, userId } = await seedAgent()
    await seedIntent({ agentId, userId }) // in-window x402
    await seedIntent({ agentId, userId, createdAt: '2026-08-01T00:00:00Z' }) // out of window
    await seedIntent({ agentId, userId, source: 'direct' }) // wrong source

    const usage = await getX402HourlyUsage(agentId)
    expect(usage).toEqual({ maxPerHour: 100, recentCount: 1 })

    const { agentId: cappedAgent } = await seedAgent(7)
    expect((await getX402HourlyUsage(cappedAgent)).maxPerHour).toBe(7)
  })

  // ── Idempotency lookups (#961) ─────────────────────────────────────────

  it('replay lookup matches EITHER key column, excludes only failed, newest first', async () => {
    const { agentId, userId } = await seedAgent()
    await seedIntent({ agentId, userId, x402Key: 'key-1', status: 'failed' })
    const expired = await seedIntent({
      agentId,
      userId,
      machineKey: 'key-1', // the OTHER key column — x402 fills both, either must match
      status: 'expired',
      createdAt: '2026-08-08T00:00:00Z',
    })

    // failed is invisible; expired is deliberately FOUND (the caller lazily
    // frees the key) — this asymmetry is the #961 semantics.
    const found = await findX402IntentByIdempotencyKey(agentId, 'key-1')
    expect(found?.id).toBe(expired)

    const newest = await seedIntent({ agentId, userId, x402Key: 'key-1', status: 'confirmed' })
    expect((await findX402IntentByIdempotencyKey(agentId, 'key-1'))?.id).toBe(newest)
  })

  it('lookups are tenant-scoped: another agent never finds the key', async () => {
    const { agentId, userId } = await seedAgent()
    const other = await seedAgent()
    await seedIntent({ agentId, userId, x402Key: 'key-3' })

    expect(await findX402IntentByIdempotencyKey(other.agentId, 'key-3')).toBeNull()
  })

  it('the partial unique index dedupes a replayed ACTIVE key but frees it after failure/expiry', async () => {
    // The behaviour the #961 flow leans on, exercised as real double-writes:
    // a second ACTIVE row for (agent, x402_idempotency_key) must violate,
    // while failed/expired rows release the key for a fresh attempt.
    const { agentId, userId } = await seedAgent()
    await seedIntent({ agentId, userId, x402Key: 'key-4' })

    await expect(seedIntent({ agentId, userId, x402Key: 'key-4' })).rejects.toMatchObject({
      code: '23505',
    })

    await db.query(`UPDATE payment_intents SET status = 'failed' WHERE x402_idempotency_key = 'key-4'`)
    await expect(seedIntent({ agentId, userId, x402Key: 'key-4' })).resolves.toBeTruthy()
  })

  // ── Rail scoping (#1288) ────────────────────────────────────────────────

  it('the rail-scoping clause excludes a same-key direct-source row from x402 lookups', async () => {
    // x402 row seeded FIRST (older) so the assertion below is meaningful:
    // without the rail-scoping clause, `ORDER BY created_at DESC LIMIT 1`
    // would pick the NEWER direct row instead, not just an unscoped one.
    const { agentId, userId } = await seedAgent()
    const x402 = await seedIntent({ agentId, userId, source: 'x402', x402Key: 'rail-key-1' })
    // Same agent, same idempotency key VALUE shared across the two different
    // key columns the lookup ORs together — this is exactly the collision the
    // issue describes: a direct-payment row (payment_rail NULL, source
    // 'direct') that happens to share a key with an x402 replay. A different
    // column so the two rows don't 23505 on the same partial unique index.
    await seedIntent({
      agentId,
      userId,
      source: 'direct',
      paymentRail: null,
      machineKey: 'rail-key-1',
      expiresAt: '2020-01-01T00:00:00Z',
      allowanceNonce: 1,
      signHash: `0x${'1'.repeat(64)}`,
    })

    // The lookup must find ONLY the x402 row — even though the direct row is
    // NEWER (so it would win the `ORDER BY` unscoped) and matches via the
    // OTHER key column. (#2469: the same-scenario refresh-guard assertion went
    // with the deleted refreshStaleX402Intent.)
    expect((await findX402IntentByIdempotencyKey(agentId, 'rail-key-1'))?.id).toBe(x402)
  })

  // ── One-shot execute transitions ─────────────────────────────────────────

  it('recordX402Signature stores the signature WITHOUT leaving pending_signature, exactly once', async () => {
    const { agentId, userId } = await seedAgent()
    const id = await seedIntent({ agentId, userId })

    expect(await recordX402Signature('0xsig-1', id, agentId)).toBe(true)
    const row = await readIntent(id)
    expect(row.signature).toBe('0xsig-1')
    expect(row.status).toBe('pending_signature') // deliberately NOT submitted
    expect(row.signed_at).not.toBeNull()

    // The wrong agent cannot sign it, and a progressed row refuses:
    const other = await seedAgent()
    expect(await recordX402Signature('0xsig-2', id, other.agentId)).toBe(false)
    await db.query(`UPDATE payment_intents SET tx_hash = '0xdead' WHERE id = $1`, [id])
    expect(await recordX402Signature('0xsig-3', id, agentId)).toBe(false)
    expect((await readIntent(id)).signature).toBe('0xsig-1')
  })

  it('confirmX402Intent settles pending_signature → confirmed exactly once — the double-settle guard', async () => {
    const { agentId, userId } = await seedAgent()
    const id = await seedIntent({ agentId, userId })

    expect(
      await confirmX402Intent({ txHash: `0x${'f'.repeat(64)}`, intentId: id, usdValue: '0.10', eurValue: '0.09', agentId }),
    ).toBe(true)
    const row = await readIntent(id)
    expect(row.status).toBe('confirmed')
    expect(row.confirmed_at).not.toBeNull()
    expect(Number(row.usd_value)).toBeCloseTo(0.1)

    // The second settle attempt — same call, row already confirmed with a
    // tx_hash — must be refused, leaving the FIRST tx_hash in place.
    expect(
      await confirmX402Intent({ txHash: `0x${'9'.repeat(64)}`, intentId: id, usdValue: '0.10', eurValue: '0.09', agentId }),
    ).toBe(false)
    expect((await readIntent(id)).tx_hash).toBe(`0x${'f'.repeat(64)}`)
  })

  it('failPendingX402Intent fails only an unprogressed pending row', async () => {
    const { agentId, userId } = await seedAgent()
    const pending = await seedIntent({ agentId, userId })
    const confirmed = await seedIntent({ agentId, userId, status: 'confirmed', txHash: `0x${'1'.repeat(64)}` })

    await failPendingX402Intent('rpc exploded', pending, agentId)
    expect((await readIntent(pending)).status).toBe('failed')
    expect((await readIntent(pending)).error_message).toBe('rpc exploded')

    await failPendingX402Intent('must not apply', confirmed, agentId)
    expect((await readIntent(confirmed)).status).toBe('confirmed')
  })

  // ── erc7710 settle handoff (#830/#976) ─────────────────────────────────

  it('findSettleIntent is tenant-scoped and carries the settle columns', async () => {
    const { agentId, userId } = await seedAgent()
    const other = await seedAgent()
    const id = await seedIntent({ agentId, userId, executionRail: 'delegation' })

    const row = await findSettleIntent(id, agentId)
    expect(row).not.toBeNull()
    expect(row!.execution_rail).toBe('delegation')
    expect(row!.amount_raw).toBe('100000')
    expect(await findSettleIntent(id, other.agentId)).toBeNull()
  })

  it('markIntentSubmittedForSettlement flips exactly once — the retry 409s on the status guard (#976)', async () => {
    const { agentId, userId } = await seedAgent()
    const id = await seedIntent({ agentId, userId })

    await markIntentSubmittedForSettlement('0xchild-sig', id, agentId)
    const row = await readIntent(id)
    expect(row.status).toBe('submitted')
    expect(row.signature).toBe('0xchild-sig')
    expect(row.submitted_at).not.toBeNull()

    // The retry: status is no longer pending_signature, so the second write
    // matches nothing and the FIRST signature survives — the property that
    // makes the X-PAYMENT header single-emission.
    await markIntentSubmittedForSettlement('0xreplay-sig', id, agentId)
    expect((await readIntent(id)).signature).toBe('0xchild-sig')
  })
})
