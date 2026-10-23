/**
 * Real-DB route tests for the agent ledger export (#4327):
 * `GET /agent-activity/:id/activity/export.csv`.
 *
 * The owner's decision (option (a)) is that the file IS the Activity tab's
 * ledger as shown — the agent's own `payment_intents`, failed and pending
 * included, under the tab's filters, and the refused attempts behind
 * `status=refused`. These are claims about what the route SERVES, so they
 * run on the #1220 harness with request validation ENFORCED exactly as
 * production wires it (#3030). One mock: the serve-time price read, so no
 * test dials CoinGecko (#4217); the file's fiat columns are asserted as the
 * outage answer (empty, never 0).
 */
vi.mock('../../infra/fiat-values.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../infra/fiat-values.js')>()),
  getServeTimeFiatValues: async () => ({ usd: null, eur: null, sek: null }),
}))
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import db from '../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'
import agentActivityRoutes, { AGENT_LEDGER_CSV_COLUMNS } from '../agent-activity.js'
import { installRequestValidation } from '../../openapi/request-validation.js'

let seq = 0

const MERCHANT = '0x00000000000000000000000000000000000000aa'

async function seedUserWithAgent(): Promise<{ userId: string; agentId: string }> {
  const n = ++seq
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`export-route-${n}-${randomUUID()}@test.example`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'export route agent') RETURNING id`,
    [user.rows[0].id],
  )
  return { userId: user.rows[0].id, agentId: agent.rows[0].id }
}

async function seedIntent(
  seed: { userId: string; agentId: string },
  opts: {
    status: string
    createdAt: string
    paymentRail?: string | null
    toAddress?: string
    resourceUrl?: string | null
    txHash?: string | null
  },
): Promise<string> {
  const n = ++seq
  const result = await db.query<{ id: string }>(
    `INSERT INTO payment_intents (
       agent_id, user_id, account_address, token_symbol, token_address,
       to_address, amount_raw, amount_human, delegate_address,
       allowance_nonce, sign_hash, status, created_at, confirmed_at, expires_at,
       chain_id, source, payment_rail, execution_rail, x402_resource_url, tx_hash
     ) VALUES (
       $1, $2, $3, 'USDC',
       '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
       $4, '1500000', '1.5',
       '0x00000000000000000000000000000000000000d1', 1, $5,
       $6, $7::timestamptz, $8::timestamptz, NOW() + INTERVAL '10 minutes', 84532,
       'api', $9, 'delegation', $10, $11
     ) RETURNING id`,
    [
      seed.agentId,
      seed.userId,
      `0x${String(6e12 + n).padStart(40, '0').slice(-40)}`,
      opts.toAddress ?? `0x${String(n).padStart(40, '3').slice(-40)}`,
      `0x${String(n).padStart(64, 'a')}`,
      opts.status,
      opts.createdAt,
      opts.status === 'confirmed' ? opts.createdAt : null,
      opts.paymentRail ?? null,
      opts.resourceUrl ?? null,
      opts.txHash ?? null,
    ],
  )
  return result.rows[0].id
}

async function seedAttention(seed: { userId: string; agentId: string }, paymentId: string): Promise<void> {
  await db.query(
    `INSERT INTO machine_payment_evidence (
       payment_intent_id, agent_id, user_id, rail, proof_status, tx_hash, chain_id,
       resource_url, payer_address, settlement_address, token_symbol, token_address,
       amount_raw, amount_human
     ) VALUES ($1, $2, $3, 'x402', 'payment_confirmed', $4, 84532,
       'https://api.example.dev/reports', $5, $5, 'USDC',
       '0x036cbd53842c5426634e7929541ec2318f3dcf7e', '1500000', '1.5')`,
    [
      paymentId,
      seed.agentId,
      seed.userId,
      `0x${randomUUID().replaceAll('-', '')}`,
      `0x${String(7e12 + seq).padStart(40, '0').slice(-40)}`,
    ],
  )
  await db.query(
    `INSERT INTO machine_payment_reconciliation_events (agent_id, user_id, payment_intent_id, rail, event_type, status)
     VALUES ($1, $2, $3, 'x402', 'merchant_retry_rejected_after_payment', 'open')`,
    [seed.agentId, seed.userId, paymentId],
  )
}

async function seedRefusal(
  seed: { userId: string; agentId: string },
  opts: { createdAt: string; reason: string },
): Promise<void> {
  await db.query(
    `INSERT INTO payment_refusals (
       user_id, agent_id, chain_id, token_symbol, amount_atomic,
       merchant_to, resource_url, reason, source, created_at
     ) VALUES ($1, $2, 84532, 'USDC', '25000', $3, 'https://research.example/report', $4,
       'x402_authorize', $5::timestamptz)`,
    [seed.userId, seed.agentId, MERCHANT, opts.reason, opts.createdAt],
  )
}

/** RFC 4180 reader for the test's own files (quoted fields, CRLF rows). */
function parseCsv(body: string): { header: string[]; records: Record<string, string>[] } {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (inQuotes) {
      if (ch === '"' && body[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') inQuotes = false
      else field += ch
      continue
    }
    if (ch === '"') inQuotes = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\r' && body[i + 1] === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i++
    } else field += ch
  }
  row.push(field)
  rows.push(row)
  const [header, ...data] = rows
  return {
    header,
    records: data.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']))),
  }
}

describeDb('GET /agent-activity/:id/activity/export.csv (#4327, real DB)', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    await initDbHarness()
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: 'test-secret' })
    installRequestValidation(app, { mode: 'enforce', enforcedModules: ['routes/agent-activity.ts'] })
    await app.register(agentActivityRoutes, { prefix: '/agent-activity' })
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
    return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } })
  }

  /** The tab's standing population: sent, pending, failed (never on chain), needs attention. */
  async function seedLedger() {
    const seed = await seedUserWithAgent()
    const sent = await seedIntent(seed, {
      status: 'confirmed',
      createdAt: '2026-10-04T10:00:00Z',
      toAddress: MERCHANT,
      txHash: `0x${'b'.repeat(64)}`,
    })
    const pending = await seedIntent(seed, { status: 'submitted', createdAt: '2026-10-03T10:00:00Z' })
    const failed = await seedIntent(seed, { status: 'failed', createdAt: '2026-10-02T10:00:00Z' })
    const attended = await seedIntent(seed, {
      status: 'confirmed',
      createdAt: '2026-10-01T10:00:00Z',
      paymentRail: 'x402',
      resourceUrl: 'https://api.example.dev/reports',
    })
    await seedAttention(seed, attended)
    return { seed, sent, pending, failed, attended }
  }

  it('writes the whole ledger — failed and pending included — newest first, under the column contract', async () => {
    const { seed, sent, pending, failed, attended } = await seedLedger()
    await db.query(`INSERT INTO contacts (user_id, name, address) VALUES ($1, 'Example Merchant', $2)`, [
      seed.userId,
      MERCHANT,
    ])

    const res = await get(seed.userId, `/agent-activity/${seed.agentId}/activity/export.csv`)

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="haven-agent-payments-\d{8}\.csv"$/,
    )
    expect(res.headers['x-export-row-count']).toBe('4')
    expect(res.body.charCodeAt(0)).toBe(0xfeff)

    const { header, records } = parseCsv(res.body.slice(1))
    expect(header).toEqual([...AGENT_LEDGER_CSV_COLUMNS])
    expect(records.map((r) => r.payment_id)).toEqual([sent, pending, failed, attended])
    expect(records.map((r) => r.status)).toEqual(['Sent', 'Pending', 'Failed', 'Needs attention'])

    expect(records[0]).toMatchObject({
      date: '2026-10-04T10:00:00.000Z',
      counterparty_name: 'Example Merchant',
      amount: '1.5',
      token: 'USDC',
      tx_hash: `0x${'b'.repeat(64)}`,
      reason: '',
      // The price read is stubbed to its outage answer: unknown is empty, never 0.
      approx_value: '',
    })
    // The canonical (checksummed) form, the activity read's own address form.
    expect(records[0].counterparty_address.toLowerCase()).toBe(MERCHANT)
    expect(records[2].tx_hash).toBe('')
    expect(records[3]).toMatchObject({
      reason: 'merchant_retry_rejected_after_payment',
      counterparty_name: 'api.example.dev',
    })
  })

  it('applies the status filter: status=failed exports exactly the failed rows the tab shows', async () => {
    const { seed, failed } = await seedLedger()

    const res = await get(seed.userId, `/agent-activity/${seed.agentId}/activity/export.csv?status=failed`)

    expect(res.statusCode).toBe(200)
    const { records } = parseCsv(res.body.slice(1))
    expect(records.map((r) => r.payment_id)).toEqual([failed])
    expect(res.headers['x-export-row-count']).toBe('1')
  })

  it('applies the period bounds: from inclusive, to exclusive', async () => {
    const { seed, pending, failed } = await seedLedger()

    const res = await get(
      seed.userId,
      `/agent-activity/${seed.agentId}/activity/export.csv?from=2026-10-02&to=2026-10-04`,
    )

    const { records } = parseCsv(res.body.slice(1))
    expect(records.map((r) => r.payment_id)).toEqual([pending, failed])
  })

  it('status=refused exports the refused attempts, with their reason and no payment', async () => {
    const { seed } = await seedLedger()
    await seedRefusal(seed, { createdAt: '2026-10-05T10:00:00Z', reason: 'delegation_budget_exceeded' })
    await seedRefusal(seed, { createdAt: '2026-10-06T10:00:00Z', reason: 'onchain_revert' })

    const res = await get(seed.userId, `/agent-activity/${seed.agentId}/activity/export.csv?status=refused`)

    expect(res.statusCode).toBe(200)
    const { records } = parseCsv(res.body.slice(1))
    expect(records.map((r) => r.reason)).toEqual(['onchain_revert', 'delegation_budget_exceeded'])
    expect(records.every((r) => r.status === 'Refused')).toBe(true)
    expect(records[0]).toMatchObject({
      counterparty_name: 'research.example',
      amount: '0.025',
      payment_id: '',
      tx_hash: '',
    })
    expect(records[0].counterparty_address.toLowerCase()).toBe(MERCHANT)
  })

  it('answers 404 for an agent that is not the caller’s, and writes nothing', async () => {
    const { seed } = await seedLedger()
    const stranger = await seedUserWithAgent()

    const res = await get(stranger.userId, `/agent-activity/${seed.agentId}/activity/export.csv`)

    expect(res.statusCode).toBe(404)
    expect(res.body).not.toContain('payment_id')
  })

  it('refuses a status outside the tab’s vocabulary with the 400 envelope', async () => {
    const { seed } = await seedLedger()

    const res = await get(seed.userId, `/agent-activity/${seed.agentId}/activity/export.csv?status=ok`)

    expect(res.statusCode).toBe(400)
  })

  it('refuses above the row cap with the agent tab’s own wording, never a truncated file', async () => {
    const seed = await seedUserWithAgent()
    // 10,001 failed intents in one statement — one more than the cap.
    await db.query(
      `INSERT INTO payment_intents (
         agent_id, user_id, account_address, token_symbol, token_address,
         to_address, amount_raw, amount_human, delegate_address,
         allowance_nonce, sign_hash, status, created_at, expires_at, chain_id, source, execution_rail
       )
       SELECT $1, $2, '0x00000000000000000000000000000000000000c1', 'USDC',
              '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
              '0x00000000000000000000000000000000000000c2', '1', '0.000001',
              '0x00000000000000000000000000000000000000d1', g,
              '0x' || lpad(to_hex(g), 64, '0'), 'failed',
              NOW() - make_interval(secs => g), NOW() + INTERVAL '10 minutes', 84532, 'api', 'delegation'
       FROM generate_series(1, 10001) AS g`,
      [seed.agentId, seed.userId],
    )

    const res = await get(seed.userId, `/agent-activity/${seed.agentId}/activity/export.csv`)

    expect(res.statusCode).toBe(413)
    expect(res.json()).toEqual({
      error: 'Export too large',
      statusCode: 413,
      details:
        'This export would contain more than 10,000 rows; the limit is 10,000. ' +
        'Narrow the filters — by status, token, search or period — and export again.',
    })
  }, 60_000)
})
