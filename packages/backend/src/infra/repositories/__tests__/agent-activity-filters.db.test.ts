/**
 * Real-DB tests for the filtered agent-payment read (#4229).
 *
 * The claim under test is a claim about what Postgres FILTERS — the
 * `($n IS NULL OR …)` predicate set behind `GET /agent-activity/:id/activity?kind=payments`
 * — so it belongs on the #1220 harness, not on a `vi.mock('db.js')`
 * dispatcher (which proves only what the caller does with the rows). Zero
 * mocks; row builders are local per #1220's domain-free-harness rule.
 *
 * Coverage: every filter arm (status sent/pending/failed/needs_attention,
 * from/to bounds, q over merchant/recipient/contact, paymentId), the paging
 * edges (limit slicing, offset past the end), and a failed payment that
 * never reached the chain (`tx_hash` null — it must still be listable).
 */
import { beforeEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import {
  countAgentPaymentsFiltered,
  listAgentPaymentsFiltered,
  type AgentPaymentActivityFilter,
} from '../agent-activity.js'
import {
  countToolInvocationsForAgentFiltered,
  listToolInvocationsForAgentFiltered,
  type AgentToolInvocationFilter,
} from '../agent-tool-invocations.js'

let seq = 0

async function seedUserWithAgent(): Promise<{ userId: string; agentId: string }> {
  const n = ++seq
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`activity-filters-${n}-${randomUUID()}@test.example`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'activity filters agent') RETURNING id`,
    [user.rows[0].id],
  )
  return { userId: user.rows[0].id, agentId: agent.rows[0].id }
}

interface IntentSeed {
  status: string
  createdAt: string
  toAddress?: string
  x402ResourceUrl?: string | null
  merchantAddress?: string | null
  paymentRail?: string | null
  source?: string
}

/**
 * A payment intent with explicit `created_at` plus the table's required
 * columns — the insert shape the 090/091 migration suite's
 * `seedConfirmedIntent` proves (and the stats local-day test mirrors).
 */
async function seedIntent(
  seed: { userId: string; agentId: string },
  opts: IntentSeed,
): Promise<string> {
  const n = ++seq
  const result = await db.query<{ id: string }>(
    `INSERT INTO payment_intents (
       agent_id, user_id, account_address, token_symbol, token_address,
       to_address, amount_raw, amount_human, delegate_address,
       allowance_nonce, sign_hash, status, created_at, confirmed_at, expires_at,
       chain_id, source, payment_rail, execution_rail,
       x402_resource_url, merchant_address,
       usd_value, eur_value, sek_value
     ) VALUES (
       $1, $2, $3, 'USDC',
       '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
       $4, $5, $6,
       '0x00000000000000000000000000000000000000d1', 1, $7,
       $8, $9::timestamptz, $10::timestamptz, NOW() + INTERVAL '10 minutes', 84532,
       $11, $12, 'delegation',
       $13, $14,
       '1', '0.9', '10.76'
     ) RETURNING id`,
    [
      seed.agentId,
      seed.userId,
      `0x${String(2e12 + n).padStart(40, '0').slice(-40)}`,
      opts.toAddress ?? `0x${String(n).padStart(40, '1').slice(-40)}`,
      `${2000000 + n}`,
      String(n),
      `0x${String(n).padStart(64, 'c')}`,
      opts.status,
      opts.createdAt,
      opts.status === 'confirmed' ? opts.createdAt : null,
      opts.source ?? 'api',
      opts.paymentRail ?? null,
      opts.x402ResourceUrl ?? null,
      opts.merchantAddress ?? null,
    ],
  )
  return result.rows[0].id
}

/**
 * The `needs_attention` derivation's two rows: a machine_payment_evidence
 * record and an OPEN `merchant_retry_rejected_after_payment` reconciliation
 * event on the payment. The route's lifecycle mapping reads attention from
 * exactly this shape (x402 rail + confirmed status + open event).
 */
async function seedAttention(
  seed: { userId: string; agentId: string },
  paymentId: string,
): Promise<void> {
  await db.query(
    `INSERT INTO machine_payment_evidence (
       payment_intent_id, agent_id, user_id, rail, proof_status, tx_hash, chain_id,
       resource_url, payer_address, settlement_address, token_symbol, token_address,
       amount_raw, amount_human
     ) VALUES ($1, $2, $3, 'x402', 'payment_confirmed', $4, 84532,
       'https://api.example.dev/reports', $5, $5, 'USDC',
       '0x036cbd53842c5426634e7929541ec2318f3dcf7e', '1000000', '1')`,
    [
      paymentId,
      seed.agentId,
      seed.userId,
      `0x${randomUUID().replaceAll('-', '')}`,
      `0x${String(3e12 + seq).padStart(40, '0').slice(-40)}`,
    ],
  )
  await db.query(
    `INSERT INTO machine_payment_reconciliation_events (agent_id, user_id, payment_intent_id, rail, event_type, status)
     VALUES ($1, $2, $3, 'x402', 'merchant_retry_rejected_after_payment', 'open')`,
    [seed.agentId, seed.userId, paymentId],
  )
}

async function seedContact(userId: string, name: string, address: string): Promise<void> {
  await db.query(`INSERT INTO contacts (user_id, name, address) VALUES ($1, $2, $3)`, [
    userId,
    name,
    address,
  ])
}

async function seedInvocation(
  seed: { userId: string; agentId: string },
  opts: { toolName: string; paymentId: string | null; resultStatus: string; errorCode?: string | null },
): Promise<void> {
  await db.query(
    `INSERT INTO agent_tool_invocations (agent_id, user_id, tool_name, payment_id, result_status, next_action, error_code, status_code)
     VALUES ($1, $2, $3, $4, $5, NULL, $6, 200)`,
    [seed.agentId, seed.userId, opts.toolName, opts.paymentId, opts.resultStatus, opts.errorCode ?? null],
  )
}

const NO_FILTER: AgentPaymentActivityFilter = { status: null, rails: ['x402', 'mpp_demo', 'mpp_crypto', 'spt'], from: null, to: null, q: null, paymentId: null, token: null }

const NO_TOOL_FILTER: AgentToolInvocationFilter = { status: null, from: null, to: null, q: null, paymentId: null }

function filterWith(overrides: Partial<typeof NO_FILTER>) {
  return { ...NO_FILTER, ...overrides }
}

describeDb('filtered agent payments read (#4229, real DB)', () => {
  beforeEach(async () => {
    await resetDb()
    seq = 0
  })

  it('with every filter null, returns the whole population — same rows the legacy read serves', async () => {
    const seed = await seedUserWithAgent()
    await seedIntent(seed, { status: 'confirmed', createdAt: '2026-07-10T08:18:00Z' })
    await seedIntent(seed, { status: 'failed', createdAt: '2026-07-09T10:00:00Z' })

    const rows = await listAgentPaymentsFiltered(seed.agentId, NO_FILTER, 30, 0, db)
    expect(rows).toHaveLength(2)
    expect(await countAgentPaymentsFiltered(seed.agentId, NO_FILTER, db)).toBe(2)
  })

  it('status sent → confirmed only', async () => {
    const seed = await seedUserWithAgent()
    await seedIntent(seed, { status: 'confirmed', createdAt: '2026-07-10T08:18:00Z' })
    await seedIntent(seed, { status: 'pending_signature', createdAt: '2026-07-10T09:18:00Z' })
    await seedIntent(seed, { status: 'failed', createdAt: '2026-07-10T10:18:00Z' })

    const rows = await listAgentPaymentsFiltered(seed.agentId, filterWith({ status: 'confirmed' }), 30, 0, db)
    expect(rows.map((r) => r.status)).toEqual(['confirmed'])
  })

  it('status pending → awaiting signature and submitted, never failed or expired', async () => {
    const seed = await seedUserWithAgent()
    await seedIntent(seed, { status: 'pending_signature', createdAt: '2026-07-10T09:18:00Z' })
    await seedIntent(seed, { status: 'submitted', createdAt: '2026-07-10T08:18:00Z' })
    await seedIntent(seed, { status: 'failed', createdAt: '2026-07-10T07:18:00Z' })
    await seedIntent(seed, { status: 'expired', createdAt: '2026-07-10T06:18:00Z' })

    const rows = await listAgentPaymentsFiltered(seed.agentId, filterWith({ status: 'pending' }), 30, 0, db)
    expect(rows.map((r) => r.status).sort()).toEqual(['pending_signature', 'submitted'])
    expect(await countAgentPaymentsFiltered(seed.agentId, filterWith({ status: 'pending' }), db)).toBe(2)
  })

  it('status failed returns exactly the failed rows — including one that never reached the chain', async () => {
    const seed = await seedUserWithAgent()
    const failedId = await seedIntent(seed, { status: 'failed', createdAt: '2026-07-10T07:18:00Z' })
    await seedIntent(seed, { status: 'confirmed', createdAt: '2026-07-10T08:18:00Z' })

    const rows = await listAgentPaymentsFiltered(seed.agentId, filterWith({ status: 'failed' }), 30, 0, db)
    expect(rows.map((r) => r.id)).toEqual([failedId])
    // Never reached the chain: no funding hash, hence no explorer link —
    // the row is still listable and shaped for the UI.
    expect(rows[0].tx_hash).toBeNull()
    expect(rows[0].confirmed_at).toBeNull()
  })

  it('status needs_attention returns exactly the machine-rail confirmed payments with an open merchant-retry-rejected event', async () => {
    const seed = await seedUserWithAgent()
    const attended = await seedIntent(seed, {
      status: 'confirmed',
      createdAt: '2026-07-10T08:18:00Z',
      paymentRail: 'x402',
    })
    await seedAttention(seed, attended)
    // Confirmed x402 WITHOUT an event — the common case, not attention.
    await seedIntent(seed, { status: 'confirmed', createdAt: '2026-07-10T07:18:00Z', paymentRail: 'x402' })
    // An event on a NON-machine-rail payment — lifecycle derives null there.
    const nonRail = await seedIntent(seed, { status: 'confirmed', createdAt: '2026-07-10T06:18:00Z', source: 'api' })
    await seedAttention(seed, nonRail)

    const rows = await listAgentPaymentsFiltered(seed.agentId, filterWith({ status: 'needs_attention' }), 30, 0, db)
    expect(rows.map((r) => r.id)).toEqual([attended])
    expect(rows[0].payment_reconciliation_event_type).toBe('merchant_retry_rejected_after_payment')
  })

  it('from is inclusive, to is exclusive — adjacent windows tile without overlap', async () => {
    const seed = await seedUserWithAgent()
    await seedIntent(seed, { status: 'confirmed', createdAt: '2026-07-08T12:00:00Z' })
    const atFrom = await seedIntent(seed, { status: 'confirmed', createdAt: '2026-07-09T12:00:00Z' })
    await seedIntent(seed, { status: 'confirmed', createdAt: '2026-07-10T12:00:00Z' })

    const window = await listAgentPaymentsFiltered(
      seed.agentId,
      filterWith({ from: '2026-07-09T12:00:00Z', to: '2026-07-10T12:00:00Z' }),
      30,
      0,
      db,
    )
    expect(window.map((r) => r.id)).toEqual([atFrom])

    // Date-only bounds work too: the whole `from` day, up to `to` midnight.
    const dayWindow = await listAgentPaymentsFiltered(
      seed.agentId,
      filterWith({ from: '2026-07-09', to: '2026-07-11' }),
      30,
      0,
      db,
    )
    expect(dayWindow).toHaveLength(2)
  })

  it('q matches the merchant resource URL, the merchant and recipient addresses, and the owner contact name', async () => {
    const seed = await seedUserWithAgent()
    const viaResource = await seedIntent(seed, {
      status: 'confirmed',
      createdAt: '2026-07-10T08:18:00Z',
      x402ResourceUrl: 'https://vpn.example.dev/reports',
    })
    const viaMerchant = await seedIntent(seed, {
      status: 'confirmed',
      createdAt: '2026-07-10T07:18:00Z',
      merchantAddress: '0xabc0000000000000000000000000000000000abc',
    })
    const contactAddress = '0xdef0000000000000000000000000000000000def'
    const viaContact = await seedIntent(seed, {
      status: 'confirmed',
      createdAt: '2026-07-10T06:18:00Z',
      toAddress: contactAddress,
    })
    await seedContact(seed.userId, 'Nordshield AB', contactAddress.toUpperCase())
    await seedIntent(seed, { status: 'confirmed', createdAt: '2026-07-10T05:18:00Z' })

    const byResource = await listAgentPaymentsFiltered(seed.agentId, filterWith({ q: 'vpn.example' }), 30, 0, db)
    expect(byResource.map((r) => r.id)).toEqual([viaResource])
    // Addresses match case-insensitively.
    const byMerchant = await listAgentPaymentsFiltered(seed.agentId, filterWith({ q: '0xABC00000' }), 30, 0, db)
    expect(byMerchant.map((r) => r.id)).toEqual([viaMerchant])
    // A saved contact's NAME stands in for its address.
    const byContact = await listAgentPaymentsFiltered(seed.agentId, filterWith({ q: 'nordshield' }), 30, 0, db)
    expect(byContact.map((r) => r.id)).toEqual([viaContact])
  })

  it('paymentId narrows to exactly that one payment', async () => {
    const seed = await seedUserWithAgent()
    const wanted = await seedIntent(seed, { status: 'confirmed', createdAt: '2026-07-10T08:18:00Z' })
    await seedIntent(seed, { status: 'confirmed', createdAt: '2026-07-10T07:18:00Z' })

    const rows = await listAgentPaymentsFiltered(seed.agentId, filterWith({ paymentId: wanted }), 30, 0, db)
    expect(rows.map((r) => r.id)).toEqual([wanted])
    expect(await countAgentPaymentsFiltered(seed.agentId, filterWith({ paymentId: wanted }), db)).toBe(1)
  })

  it('limit slices the newest first and offset past the end serves an empty page — but the total survives', async () => {
    const seed = await seedUserWithAgent()
    await seedIntent(seed, { status: 'confirmed', createdAt: '2026-07-10T08:18:00Z' })
    await seedIntent(seed, { status: 'confirmed', createdAt: '2026-07-10T07:18:00Z' })
    await seedIntent(seed, { status: 'confirmed', createdAt: '2026-07-10T06:18:00Z' })

    const page = await listAgentPaymentsFiltered(seed.agentId, NO_FILTER, 2, 0, db)
    expect(page).toHaveLength(2)

    const lastPage = await listAgentPaymentsFiltered(seed.agentId, NO_FILTER, 2, 2, db)
    expect(lastPage).toHaveLength(1)

    const past = await listAgentPaymentsFiltered(seed.agentId, NO_FILTER, 2, 10, db)
    expect(past).toEqual([])
    expect(await countAgentPaymentsFiltered(seed.agentId, NO_FILTER, db)).toBe(3)
  })

  it('another agent of the same owner never leaks into the read', async () => {
    const seed = await seedUserWithAgent()
    await seedIntent(seed, { status: 'confirmed', createdAt: '2026-07-10T08:18:00Z' })
    const other = await seedUserWithAgent()
    await seedIntent(other, { status: 'confirmed', createdAt: '2026-07-10T09:18:00Z' })

    const rows = await listAgentPaymentsFiltered(seed.agentId, NO_FILTER, 30, 0, db)
    expect(rows).toHaveLength(1)
  })
})

describeDb('filtered agent tool-invocation read (#4229, real DB)', () => {
  beforeEach(async () => {
    await resetDb()
    seq = 0
  })

  it('filters by result_status, period, q (tool name / error code) and paymentId', async () => {
    const seed = await seedUserWithAgent()
    const paymentId = await seedIntent(seed, { status: 'confirmed', createdAt: '2026-07-10T08:18:00Z' })
    await seedInvocation(seed, { toolName: 'haven_pay_x402_quote', paymentId, resultStatus: 'ok' })
    await seedInvocation(seed, { toolName: 'haven_get_allowances', paymentId: null, resultStatus: 'error', errorCode: 'budget_exhausted' })
    await seedInvocation(seed, { toolName: 'haven_pay_settle', paymentId: null, resultStatus: 'denied' })

    const byStatus = await listToolInvocationsForAgentFiltered(
      seed.agentId,
      { ...NO_TOOL_FILTER, status: 'error' },
      30,
      0,
      db,
    )
    expect(byStatus.map((r) => r.result_status)).toEqual(['error'])

    const byQ = await listToolInvocationsForAgentFiltered(
      seed.agentId,
      { ...NO_TOOL_FILTER, q: 'allowances' },
      30,
      0,
      db,
    )
    expect(byQ.map((r) => r.tool_name)).toEqual(['haven_get_allowances'])

    const byQCode = await listToolInvocationsForAgentFiltered(
      seed.agentId,
      { ...NO_TOOL_FILTER, q: 'budget_exhausted' },
      30,
      0,
      db,
    )
    expect(byQCode).toHaveLength(1)

    const byPayment = await listToolInvocationsForAgentFiltered(
      seed.agentId,
      { ...NO_TOOL_FILTER, paymentId },
      30,
      0,
      db,
    )
    expect(byPayment.map((r) => r.tool_name)).toEqual(['haven_pay_x402_quote'])
  })

  it('the count pair: total honors every filter, error_count ignores the status filter', async () => {
    const seed = await seedUserWithAgent()
    await seedInvocation(seed, { toolName: 'a', paymentId: null, resultStatus: 'ok' })
    await seedInvocation(seed, { toolName: 'b', paymentId: null, resultStatus: 'error' })
    await seedInvocation(seed, { toolName: 'c', paymentId: null, resultStatus: 'error' })

    const all = await countToolInvocationsForAgentFiltered(seed.agentId, NO_TOOL_FILTER, db)
    expect(all).toEqual({ total: 3, errorCount: 2 })

    const okOnly = await countToolInvocationsForAgentFiltered(
      seed.agentId,
      { ...NO_TOOL_FILTER, status: 'ok' },
      db,
    )
    // The PAGE total honors the status filter; the summary-line error count does not.
    expect(okOnly).toEqual({ total: 1, errorCount: 2 })
  })
})

// #4346: `q` is a SUBSTRING search (the spec's "Case-insensitive substring
// search"), so `%`, `_` and `\` in the term are literal characters, never LIKE
// wildcards. Each case asserts the page AND the count, because the list and
// COUNT statements are separate texts and must agree on the population.
describeDb('search terms match literally — % _ and \\ are not wildcards (#4346, real DB)', () => {
  beforeEach(async () => {
    await resetDb()
    seq = 0
  })

  it('payments: `a_b` finds only a literal a_b — by resource URL and by contact name', async () => {
    const seed = await seedUserWithAgent()
    const literal = await seedIntent(seed, {
      status: 'confirmed',
      createdAt: '2026-07-10T08:00:00Z',
      x402ResourceUrl: 'https://shop.example/a_b',
    })
    await seedIntent(seed, {
      status: 'confirmed',
      createdAt: '2026-07-10T07:00:00Z',
      x402ResourceUrl: 'https://shop.example/axb',
    })
    const toLiteral = '0x00000000000000000000000000000000000000c1'
    const toOther = '0x00000000000000000000000000000000000000c2'
    const byContact = await seedIntent(seed, { status: 'confirmed', createdAt: '2026-07-10T06:00:00Z', toAddress: toLiteral })
    await seedIntent(seed, { status: 'confirmed', createdAt: '2026-07-10T05:00:00Z', toAddress: toOther })
    await seedContact(seed.userId, 'Team a_b', toLiteral)
    await seedContact(seed.userId, 'Team axb', toOther)

    const rows = await listAgentPaymentsFiltered(seed.agentId, filterWith({ q: 'a_b' }), 30, 0, db)
    expect(rows.map((r) => r.id).sort()).toEqual([literal, byContact].sort())
    expect(await countAgentPaymentsFiltered(seed.agentId, filterWith({ q: 'a_b' }), db)).toBe(2)
  })

  it('payments: `a\\b` finds only a literal backslash, not `ab`', async () => {
    const seed = await seedUserWithAgent()
    const literal = await seedIntent(seed, {
      status: 'confirmed',
      createdAt: '2026-07-10T08:00:00Z',
      x402ResourceUrl: 'https://shop.example/a\\b',
    })
    await seedIntent(seed, {
      status: 'confirmed',
      createdAt: '2026-07-10T07:00:00Z',
      x402ResourceUrl: 'https://shop.example/ab',
    })

    const rows = await listAgentPaymentsFiltered(seed.agentId, filterWith({ q: 'a\\b' }), 30, 0, db)
    expect(rows.map((r) => r.id)).toEqual([literal])
    expect(await countAgentPaymentsFiltered(seed.agentId, filterWith({ q: 'a\\b' }), db)).toBe(1)
  })

  it('payments: a lone `%` matches no row without a literal %', async () => {
    const seed = await seedUserWithAgent()
    await seedIntent(seed, {
      status: 'confirmed',
      createdAt: '2026-07-10T08:00:00Z',
      x402ResourceUrl: 'https://shop.example/plain',
    })

    expect(await listAgentPaymentsFiltered(seed.agentId, filterWith({ q: '%' }), 30, 0, db)).toEqual([])
    expect(await countAgentPaymentsFiltered(seed.agentId, filterWith({ q: '%' }), db)).toBe(0)
  })

  it('tool calls: `a_b`, `a\\b` and `%` are literal in the tool name — page and count agree', async () => {
    const seed = await seedUserWithAgent()
    await seedInvocation(seed, { toolName: 'tool a_b', paymentId: null, resultStatus: 'ok' })
    await seedInvocation(seed, { toolName: 'tool axb', paymentId: null, resultStatus: 'ok' })
    await seedInvocation(seed, { toolName: 'tool a\\b', paymentId: null, resultStatus: 'ok' })
    await seedInvocation(seed, { toolName: 'tool ab', paymentId: null, resultStatus: 'error', errorCode: 'plain' })

    const underscore = await listToolInvocationsForAgentFiltered(seed.agentId, { ...NO_TOOL_FILTER, q: 'a_b' }, 30, 0, db)
    expect(underscore.map((r) => r.tool_name)).toEqual(['tool a_b'])
    expect((await countToolInvocationsForAgentFiltered(seed.agentId, { ...NO_TOOL_FILTER, q: 'a_b' }, db)).total).toBe(1)

    const backslash = await listToolInvocationsForAgentFiltered(seed.agentId, { ...NO_TOOL_FILTER, q: 'a\\b' }, 30, 0, db)
    expect(backslash.map((r) => r.tool_name)).toEqual(['tool a\\b'])
    expect((await countToolInvocationsForAgentFiltered(seed.agentId, { ...NO_TOOL_FILTER, q: 'a\\b' }, db)).total).toBe(1)

    expect(await listToolInvocationsForAgentFiltered(seed.agentId, { ...NO_TOOL_FILTER, q: '%' }, 30, 0, db)).toEqual([])
    expect((await countToolInvocationsForAgentFiltered(seed.agentId, { ...NO_TOOL_FILTER, q: '%' }, db)).total).toBe(0)
  })
})
