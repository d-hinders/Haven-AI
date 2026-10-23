/**
 * Real-DB proof for the agent stats "today" window (#3977).
 *
 * The claim under test is a claim about what Postgres COUNTS — a
 * `confirmed_at >= start AND confirmed_at < end` window whose bounds the
 * route derives from an injected clock in the CALLER's zone and passes as
 * parameters — so it belongs on the #1220 harness, not on the
 * `vi.mock('db.js')` dispatcher the characterization suite uses (which
 * proves only what the caller does with the rows). Zero mocks.
 *
 * Nothing sets the session time zone here — no `SET TIME ZONE`, no `PGTZ`:
 * the search_path options the harness appends to `DATABASE_URL` never touch
 * `timezone`. The pre-#3977 `CURRENT_DATE` predicate was UTC on the server
 * default; that is exactly the behavior this file pins OUT.
 *
 * The clock is fixed at 2026-03-08T22:30Z — 2026-03-08 23:30 in
 * Europe/Stockholm (CET), so "today" is local day 2026-03-08, i.e.
 * `[2026-03-07T23:00Z, 2026-03-08T23:00Z)`. Seeded:
 *
 *   A: confirmed 2026-03-07T23:30Z — 00:30 local on D   → counts;
 *   B: confirmed 2026-03-06T22:30Z — 23:30 local on D−1 → does not;
 *   C: created 2026-03-07T22:50Z (23:50 local D−1), confirmed 2026-03-07T23:10Z
 *      (00:10 local D) — the confirmed_at straddle → counts (the window
 *      counts on `confirmed_at`, the same column the dashboard counts,
 *      #3803 §4);
 *   D: confirmed inside the window but status 'pending' → never counts.
 *
 * Reverting the route to the pre-#3977 `CURRENT_DATE` predicate turns the A
 * and C assertions red on a UTC session — that is the recorded mutation.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import db from '../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'
import agentActivityRoutes from '../agent-activity.js'

let seq = 0

/** The clock the route is registered with: 23:30 CET on 2026-03-08. */
const FIXED_NOW = new Date('2026-03-08T22:30:00Z')

async function seedUserWithAgent(): Promise<{ userId: string; agentId: string }> {
  const n = ++seq
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`stats-local-day-${n}-${randomUUID()}@test.example`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'local-day agent') RETURNING id`,
    [user.rows[0].id],
  )
  return { userId: user.rows[0].id, agentId: agent.rows[0].id }
}

/**
 * A payment intent with explicit `created_at` / `confirmed_at` — the columns
 * the window reads — plus the table's required ones (the same insert shape
 * the 090/091 migration suite's `seedConfirmedIntent` proves).
 */
async function seedIntent(
  seed: { userId: string; agentId: string },
  opts: { status: string; createdAt: string; confirmedAt: string | null },
): Promise<void> {
  const n = ++seq
  await db.query(
    `INSERT INTO payment_intents (
       agent_id, user_id, account_address, token_symbol, token_address,
       to_address, amount_raw, amount_human, delegate_address,
       allowance_nonce, sign_hash, status, created_at, confirmed_at, expires_at,
       chain_id, source, payment_rail, execution_rail, machine_metadata,
       usd_value, eur_value, sek_value
     ) VALUES (
       $1, $2, $3, 'USDC',
       '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
       '0x00000000000000000000000000000000000000aa', $4, $5,
       '0x00000000000000000000000000000000000000d1', 1, $6,
       $7, $8::timestamptz, $9::timestamptz, NOW() + INTERVAL '10 minutes', 84532,
       'x402', 'x402', 'delegation',
       '{"settlement_scheme":"erc7710"}'::jsonb, '1', '0.9', '10.76'
     )`,
    [
      seed.agentId,
      seed.userId,
      `0x${String(1e12 + n).padStart(40, '0').slice(-40)}`,
      `${1000000 + n}`,
      '1',
      `0x${String(n).padStart(64, 'a')}`,
      opts.status,
      opts.createdAt,
      opts.confirmedAt,
    ],
  )
}

describeDb('GET /agent-activity/:id/stats — today is the caller local day (real DB, #3977)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    await initDbHarness()
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    await app.register(agentActivityRoutes, {
      prefix: '/agent-activity',
      now: () => FIXED_NOW,
    })
  })
  afterAll(async () => {
    await app?.close()
  })
  beforeEach(async () => {
    await resetDb()
    seq = 0
  })

  async function get(userId: string, url: string) {
    const token = app.jwt.sign({ sub: userId, email: 'u@example.com' }, { expiresIn: '1h' })
    return app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${token}` },
    })
  }

  /** The A/B/C/D fixture: three confirmed intents across the local midnight, one pending. */
  async function seedStraddle(): Promise<{ userId: string; agentId: string }> {
    const seed = await seedUserWithAgent()
    // A — 00:30 local on the local day D (2026-03-08).
    await seedIntent(seed, { status: 'confirmed', createdAt: '2026-03-07T23:30:00Z', confirmedAt: '2026-03-07T23:30:00Z' })
    // B — 23:30 local on D−1 (2026-03-07).
    await seedIntent(seed, { status: 'confirmed', createdAt: '2026-03-06T22:30:00Z', confirmedAt: '2026-03-06T22:30:00Z' })
    // C — created 23:50 local on D−1, confirmed 00:10 local on D.
    await seedIntent(seed, { status: 'confirmed', createdAt: '2026-03-07T22:50:00Z', confirmedAt: '2026-03-07T23:10:00Z' })
    // D — inside the window but not spend.
    await seedIntent(seed, { status: 'pending', createdAt: '2026-03-08T10:00:00Z', confirmedAt: null })
    return seed
  }

  it('counts a payment confirmed 00:30 local on D and the confirmed_at straddle, not the 23:30 D−1 one', async () => {
    const seed = await seedStraddle()

    const res = await get(seed.userId, '/agent-activity/' + seed.agentId + '/stats?tz=Europe%2FStockholm')

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.today).toEqual([{ token: 'USDC', total_spent: '2', tx_count: 2 }])
    // all_time still sees B — it exists, it is just not in the local today.
    expect(body.all_time).toEqual([{ token: 'USDC', total_spent: '3', tx_count: 3 }])
    expect(body.pending_approvals).toBe(0)
  })

  it('counts on created_at NEVER — a pending intent inside the window does not appear', async () => {
    const seed = await seedStraddle()

    const res = await get(seed.userId, '/agent-activity/' + seed.agentId + '/stats?tz=Europe%2FStockholm')

    const today = res.json().today as { tx_count: number }[]
    expect(today[0].tx_count).toBe(2)
  })

  it('without tz the window is the UTC day — the zone actually decides, not the session', async () => {
    const seed = await seedStraddle()

    // The same rows, no `tz`: the UTC day 2026-03-08 window
    // ([2026-03-08T00:00Z, 2026-03-09T00:00Z)) contains A (23:30Z on the 7th)
    // and C (23:10Z on the 7th) in NEITHER day — they confirmed before the
    // UTC day began. Only the caller's zone puts them in "today".
    const res = await get(seed.userId, '/agent-activity/' + seed.agentId + '/stats')

    expect(res.statusCode).toBe(200)
    expect(res.json().today).toEqual([])
    expect(res.json().all_time).toEqual([{ token: 'USDC', total_spent: '3', tx_count: 3 }])
  })

  it('refuses an invalid tz with 400 before any read', async () => {
    const seed = await seedUserWithAgent()

    const res = await get(seed.userId, '/agent-activity/' + seed.agentId + '/stats?tz=Mars%2FOlympus')

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('unsupported tz')
  })

  it("404s another user's agent without reading any aggregate", async () => {
    const seed = await seedStraddle()
    const other = await seedUserWithAgent()

    const res = await get(other.userId, '/agent-activity/' + seed.agentId + '/stats?tz=Europe%2FStockholm')

    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('Agent not found')
  })
})
