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
import { expirePendingIntent } from '../payment-intents.js'

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
       (agent_id, user_id, account_address, token_symbol, token_address, to_address,
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

  // ── #3045: a duplicated key with the NEWEST row expired must not strand ──

  it('#3045 two rows one key, newest expired: the OLDER live row wins the lookup (409-forever regression)', async () => {
    // The #3045 trap state, seeded at the data layer exactly as dev holds it
    // for `b2-probe-2026-09-16-k1` (rows 6866bc97 / 9835d550, both
    // `pending_signature` at creation, newest now lazily expired): the insert
    // fills BOTH key columns (machine_idempotency_key = x402_idempotency_key,
    // payment-intents.ts), so the second row for the key rides the OTHER
    // column and the partial unique index does not refuse it. Under the old
    // `ORDER BY created_at DESC` the lookup always answered the newest row;
    // with that row expired the key could never be freed or replayed — the
    // insert conflicted with the older live row the lookup never reached.
    const { agentId, userId } = await seedAgent()
    const older = await seedIntent({
      agentId,
      userId,
      x402Key: 'dup-key-1',
      status: 'pending_signature',
      createdAt: '2026-08-08T00:00:00Z', // older by created_at — the row the key really belongs to
    })
    const newer = await seedIntent({
      agentId,
      userId,
      machineKey: 'dup-key-1', // the OTHER column — a legacy duplicate, not an insert the current tools could make
      status: 'expired', // the NEWEST row (default created_at = NOW), already lazily expired
    })
    expect(newer).toBeTruthy()

    // With the newest row dead, the lookup must surface the OLDER LIVE row —
    // pre-fix `created_at DESC` alone returned the expired newest row here,
    // which is the whole 409-forever mechanism.
    const found = await findX402IntentByIdempotencyKey(agentId, 'dup-key-1')
    expect(found?.id).toBe(older)
    expect(found?.status).toBe('pending_signature')

    // And that row is LIVE: re-inserting for the key must still violate the
    // partial unique index — the exact 23505 the pre-fix retry hit after
    // lazily expiring the newest row (the 409-forever mechanism).
    await expect(seedIntent({ agentId, userId, x402Key: 'dup-key-1' })).rejects.toMatchObject({
      code: '23505',
    })
  })

  it('#3045 walking a duplicated key: each retry reaches a live row until the key is truly free', async () => {
    // Two pending rows, the NEWER one past its quote window. First retry: the
    // lookup finds the newer row (live beats live → newest first), the caller
    // lazily expires it (delegationReplay's freeing path — the same
    // expirePendingIntent the module calls). Second retry: the older live row
    // is now the newest live match and is FOUND — under the pre-fix ordering
    // the lookup would have returned the just-expired row again and the key
    // would strand on 409 forever.
    const { agentId, userId } = await seedAgent()
    const older = await seedIntent({
      agentId,
      userId,
      x402Key: 'dup-key-2',
      createdAt: '2026-08-08T00:00:00Z', // older by created_at
    })
    const newer = await seedIntent({
      agentId,
      userId,
      machineKey: 'dup-key-2',
      // NEWEST row (default created_at = NOW), past its quote window: the
      // retry lazily expires THIS one first — the #961 freeing path.
      expiresAt: '2020-01-01T00:10:00Z',
    })

    const first = await findX402IntentByIdempotencyKey(agentId, 'dup-key-2')
    expect(first?.id).toBe(newer)
    expect(first?.status).toBe('pending_signature')
    // The caller's freeing step: flip the stale pending row to expired.
    await expirePendingIntent(newer, agentId)

    // The NEXT retry (what pre-fix returned null to, then 409'd): the older
    // row must surface so the caller can replay it — or lazily expire it in
    // turn, after which the key is free for a fresh mint.
    const second = await findX402IntentByIdempotencyKey(agentId, 'dup-key-2')
    expect(second?.id).toBe(older)
    expect(second?.status).toBe('pending_signature')
    await expirePendingIntent(older, agentId)

    // Both rows dead: the lookup still finds the newest EXPIRED row (the
    // #961 lone-stale freeing path is unchanged — expired stays visible), the
    // caller expires nothing, returns null, and the fresh insert succeeds.
    const third = await findX402IntentByIdempotencyKey(agentId, 'dup-key-2')
    expect(third?.id).toBe(newer)
    expect(third?.status).toBe('expired')
    await expect(seedIntent({ agentId, userId, x402Key: 'dup-key-2' })).resolves.toBeTruthy()
  })

  it('#3045 a lone expired row is still FOUND — the lazy-expiry freeing path is unchanged (#961)', async () => {
    // The WHERE predicate was deliberately NOT touched: with only an expired
    // row for the key, the lookup must still return it so delegationReplay
    // can expire nothing and return null, freeing the key for a fresh create.
    // (The CASE ordering only ranks expired BELOW live rows; with no live row
    // the expired row is the match, exactly as before.)
    const { agentId, userId } = await seedAgent()
    const expired = await seedIntent({
      agentId,
      userId,
      x402Key: 'lone-expired-1',
      status: 'expired',
    })

    const found = await findX402IntentByIdempotencyKey(agentId, 'lone-expired-1')
    expect(found?.id).toBe(expired)
    expect(found?.status).toBe('expired')
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
