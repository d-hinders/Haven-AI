/**
 * Real-DB tests for the funnel's last step written from the payment row
 * (#4354). The claims are about what Postgres does with one INSERT … SELECT —
 * the status gate, the owner join, the rail COALESCE and the partial unique
 * index — so they run on the #1220 harness with zero mocks.
 *
 * The three settled transitions that call it (the sign route, the erc7710
 * seam, the outcome reconciler) are wired in their own tests; here the
 * helper is called directly and awaited, because the emitter that wraps it is
 * fire-and-forget and would race the assertions.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import { recordFirstPaymentSettled } from '../onboarding-funnel.js'

let seq = 0

async function seedOwner(): Promise<{ userId: string; agentId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`first-payment-${++seq}-${Date.now()}@test.example`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'funnel agent') RETURNING id`,
    [user.rows[0].id],
  )
  return { userId: user.rows[0].id, agentId: agent.rows[0].id }
}

interface IntentOptions {
  status: 'confirmed' | 'submitted' | 'failed' | 'pending_signature'
  /** `payment_rail` and `source`; null for the direct rail. */
  rail: string | null
  settlementScheme?: 'erc7710' | 'eip3009'
}

/**
 * A machine row carries `source` and `payment_rail` as `insertMachineIntent`
 * writes them (both the rail). A direct row leaves BOTH unset, as the direct
 * inserts do, so `source` takes the column default ('direct', migration 000)
 * exactly as it does in production.
 */
async function seedIntent(owner: { userId: string; agentId: string }, opts: IntentOptions): Promise<string> {
  const n = ++seq
  const railColumns = opts.rail === null ? '' : ', source, payment_rail'
  const railValues = opts.rail === null ? '' : ', $7, $7'
  const result = await db.query<{ id: string }>(
    `INSERT INTO payment_intents
       (agent_id, user_id, account_address, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
        status, tx_hash, expires_at, machine_metadata${railColumns})
     VALUES ($1, $2, '0x00000000000000000000000000000000000000f1', 'USDC',
             '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
             '0x00000000000000000000000000000000000000c1',
             '100000', '0.10', '0x00000000000000000000000000000000000000d1',
             0, $3, $4, $5, NOW() + interval '1 hour', $6::jsonb${railValues})
     RETURNING id`,
    [
      owner.agentId,
      owner.userId,
      `0xsign${n}`,
      opts.status,
      opts.status === 'confirmed' ? `0x${n.toString(16).padStart(64, '0')}` : null,
      opts.settlementScheme ? JSON.stringify({ settlement_scheme: opts.settlementScheme }) : null,
      ...(opts.rail === null ? [] : [opts.rail]),
    ],
  )
  return result.rows[0].id
}

async function funnelRows(userId: string) {
  const result = await db.query<{ metadata: Record<string, unknown> }>(
    `SELECT metadata FROM onboarding_events WHERE user_id = $1 AND event = 'first_payment_settled'`,
    [userId],
  )
  return result.rows.map((r) => r.metadata)
}

describeDb('recordFirstPaymentSettled — real Postgres (#4354)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
  })

  it('an erc7710 settlement writes one row, for the agent\'s owner, labelled with its rail and scheme', async () => {
    const owner = await seedOwner()
    const paymentId = await seedIntent(owner, { status: 'confirmed', rail: 'x402', settlementScheme: 'erc7710' })
    // A second user created AFTER the owner, so a writer that picked the
    // wrong user (the newest, say) would put the row on them instead.
    const bystander = await seedOwner()

    expect(await recordFirstPaymentSettled(paymentId)).toBe(true)

    expect(await funnelRows(owner.userId)).toEqual([
      { payment_id: paymentId, rail: 'x402', settlement_scheme: 'erc7710' },
    ])
    expect(await funnelRows(bystander.userId)).toEqual([])
  })

  it('an EIP-3009 funding leg is labelled x402 / eip3009, not manual', async () => {
    const owner = await seedOwner()
    const paymentId = await seedIntent(owner, { status: 'confirmed', rail: 'x402', settlementScheme: 'eip3009' })

    await recordFirstPaymentSettled(paymentId)

    expect(await funnelRows(owner.userId)).toEqual([
      { payment_id: paymentId, rail: 'x402', settlement_scheme: 'eip3009' },
    ])
  })

  it('a direct payment keeps the manual label the sign route always wrote, with no scheme key', async () => {
    const owner = await seedOwner()
    const paymentId = await seedIntent(owner, { status: 'confirmed', rail: null })
    // The seed matches production: no rail, and `source` at its column
    // default. A label read from `source` would say 'direct' here.
    const row = await db.query<{ source: string | null; payment_rail: string | null }>(
      'SELECT source, payment_rail FROM payment_intents WHERE id = $1',
      [paymentId],
    )
    expect(row.rows[0]).toEqual({ source: 'direct', payment_rail: null })

    await recordFirstPaymentSettled(paymentId)

    expect(await funnelRows(owner.userId)).toEqual([{ payment_id: paymentId, rail: 'manual' }])
  })

  it('a row that is not confirmed writes nothing — submitted, failed or still pending', async () => {
    const owner = await seedOwner()
    for (const status of ['submitted', 'failed', 'pending_signature'] as const) {
      const paymentId = await seedIntent(owner, { status, rail: 'x402', settlementScheme: 'erc7710' })
      expect(await recordFirstPaymentSettled(paymentId)).toBe(false)
    }
    expect(await funnelRows(owner.userId)).toEqual([])
  })

  it('a second settled payment writes no second row: the first one stays', async () => {
    const owner = await seedOwner()
    const first = await seedIntent(owner, { status: 'confirmed', rail: null })
    const second = await seedIntent(owner, { status: 'confirmed', rail: 'x402', settlementScheme: 'erc7710' })

    expect(await recordFirstPaymentSettled(first)).toBe(true)
    // A throw is captured into the value, so a unique violation fails the
    // assertion below instead of ending the test before it asserts anything.
    const outcome = await recordFirstPaymentSettled(second).then(
      (written) => written,
      (err: Error) => `threw: ${err.message}`,
    )
    expect(outcome).toBe(false)

    expect(await funnelRows(owner.userId)).toEqual([{ payment_id: first, rail: 'manual' }])
  })

  it('an unknown payment id writes nothing', async () => {
    const owner = await seedOwner()
    expect(await recordFirstPaymentSettled('66666666-6666-4666-8666-666666666666')).toBe(false)
    expect(await funnelRows(owner.userId)).toEqual([])
  })
})
