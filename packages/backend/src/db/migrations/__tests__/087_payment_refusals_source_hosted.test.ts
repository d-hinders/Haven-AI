/**
 * Real-Postgres proof for migration 087 — the `hosted_prepare` source
 * widening on `payment_refusals` (#3054, slice 3 of epic #3056). No mocks —
 * #1219's rule. Same convention as the 086 file this sits beside: the
 * harness applies the FULL migration set, so the table already exists at
 * head shape; tests that need the pre-087 state back call `down()` first
 * (or wrap with `withMigrationReverted`).
 *
 * What this file pins, per the issue's acceptance criteria:
 *  - the `source` CHECK is the closed FOUR-value set, `'hosted_prepare'`
 *    accepted and every unnamed value still rejected (23514);
 *  - a `hosted_prepare` row lands through the real writer
 *    (`recordPaymentRefusal`) and reads back — the row slice 3's
 *    budget-precheck route books is representable at head shape;
 *  - the dedupe fold key is UNCHANGED (epic decision 4): a
 *    `x402_authorize` row and a `hosted_prepare` row on the same
 *    `(agent_id, reason, resource_url)` inside the 60-second window fold
 *    into ONE row with `attempts = 2` and `source = 'hosted_prepare'`;
 *  - `down()` refuses LOUDLY while `hosted_prepare` rows exist (#1139
 *    structural-down() rule — audit rows are never deleted or rewritten),
 *    and reverses exactly once they are gone.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../../db.js'
import { assertWorkerSchemaAtHead, describeDb, initDbHarness, resetDb, withMigrationReverted } from '../../../infra/__tests__/helpers/db-harness.js'
import { recordPaymentRefusal } from '../../../infra/repositories/payment-refusals.js'
import { up, down, version } from '../087_payment_refusals_source_hosted.js'

let seq = 0
async function seedUser(): Promise<string> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`refusals087-${seq++}-${Date.now()}-${Math.random()}@test.example`],
  )
  return user.rows[0].id
}

async function seedAgent(userId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, $2) RETURNING id`,
    [userId, `refusals087-agent-${seq}`],
  )
  return rows[0].id
}

async function insertRefusal(overrides: Record<string, unknown> = {}): Promise<void> {
  const userId = overrides.user_id ?? (await seedUser())
  const agentId = overrides.agent_id ?? (await seedAgent(userId as string))
  await db.query(
    `INSERT INTO payment_refusals
       (user_id, agent_id, chain_id, token_symbol, amount_atomic, reason, source)
     VALUES ($1, $2, 84532, 'USDC', '10000', $3, $4)`,
    [
      userId,
      agentId,
      overrides.reason ?? 'onchain_revert',
      overrides.source ?? 'x402_authorize',
    ],
  )
}

interface RefusalRow {
  source: string
  attempts: number
  resource_url: string | null
}

async function refusalRows(agentId: string): Promise<RefusalRow[]> {
  const { rows } = await db.query<RefusalRow>(
    `SELECT source, attempts, resource_url FROM payment_refusals WHERE agent_id = $1 ORDER BY created_at, id`,
    [agentId],
  )
  return rows
}

describeDb('migration 087: payment_refusals source widens with hosted_prepare (#3054)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  // This file hand-drives down()/up() below; the guard catches a leaked
  // schema mutation from this file or an earlier one. CHECK-constraint
  // content mutations are its documented blind spot — every reverting test
  // restores through withMigrationReverted or its own try/finally.
  afterAll(assertWorkerSchemaAtHead)

  beforeEach(async () => {
    await resetDb()
  })

  it('is registered under its own version string', () => {
    expect(version).toBe('087_payment_refusals_source_hosted')
  })

  // ── The closed source enum: four values, hosted_prepare live ────────────

  it('the source CHECK accepts exactly the four writers and rejects the rest', async () => {
    for (const source of ['x402_authorize', 'payment', 'redeem', 'hosted_prepare']) {
      await expect(insertRefusal({ source })).resolves.toBeUndefined()
    }
    await expect(insertRefusal({ source: 'settle' })).rejects.toMatchObject({ code: '23514' })
    await expect(insertRefusal({ source: 'agent_report' })).rejects.toMatchObject({ code: '23514' })
  })

  it('a hosted_prepare refusal lands through the real writer and reads back', async () => {
    const userId = await seedUser()
    const agentId = await seedAgent(userId)
    const { id, inserted, attempts } = await recordPaymentRefusal({
      userId,
      agentId,
      chainId: 84532,
      tokenSymbol: 'USDC',
      amountAtomic: '2000000',
      usdValue: null,
      eurValue: null,
      sekValue: null,
      resourceUrl: 'https://merchant.example/3054',
      reason: 'delegation_budget_exceeded',
      source: 'hosted_prepare',
      detail: {
        error_code: 'delegation_budget_exceeded',
        phase: 'insufficient_funds',
        next_action: 'fund_safe_or_raise_allowance',
      },
    })
    expect(inserted).toBe(true)
    expect(attempts).toBe(1)
    expect(id).toBeTruthy()

    const rows = await refusalRows(agentId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      source: 'hosted_prepare',
      attempts: 1,
      resource_url: 'https://merchant.example/3054',
    })
  })

  // ── The dedupe fold key is UNCHANGED (epic decision 4) ──────────────────

  it('a hosted_prepare pre-check on the same URL folds into the earlier row as attempts = 2', async () => {
    const userId = await seedUser()
    const agentId = await seedAgent(userId)
    const url = 'https://merchant.example/3054-fold'

    // The hosted refusal lands first…
    const first = await recordPaymentRefusal({
      userId,
      agentId,
      chainId: 84532,
      tokenSymbol: 'USDC',
      amountAtomic: '2000000',
      usdValue: null,
      eurValue: null,
      sekValue: null,
      resourceUrl: url,
      reason: 'delegation_budget_exceeded',
      source: 'hosted_prepare',
    })
    expect(first.inserted).toBe(true)

    // …and the backend pre-check on the same URL within the window folds in.
    const second = await recordPaymentRefusal({
      userId,
      agentId,
      chainId: 84532,
      tokenSymbol: 'USDC',
      amountAtomic: '2000000',
      usdValue: null,
      eurValue: null,
      sekValue: null,
      resourceUrl: url,
      reason: 'delegation_budget_exceeded',
      source: 'hosted_prepare',
    })
    expect(second.inserted).toBe(false)
    expect(second.attempts).toBe(2)

    const rows = await refusalRows(agentId)
    expect(rows).toHaveLength(1)
    expect(rows[0].attempts).toBe(2)
    expect(rows[0].source).toBe('hosted_prepare')
  })

  // ── down(): refuses loudly on hosted_prepare rows (#1139), exact otherwise ─

  it('down() refuses loudly while hosted_prepare rows exist, and leaves them intact', async () => {
    const userId = await seedUser()
    const agentId = await seedAgent(userId)
    await insertRefusal({ user_id: userId, agent_id: agentId, source: 'hosted_prepare' })

    await expect(down(db as never)).rejects.toThrow(/hosted_prepare/)

    // The refusal to roll back must not have consumed the audit rows.
    const rows = await refusalRows(agentId)
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe('hosted_prepare')
  })

  it('down() reverses exactly once no hosted_prepare rows remain, and up() restores the head shape', async () => {
    const client = await db.connect()
    try {
      const userId = await seedUser()
      await insertRefusal({ user_id: userId, source: 'x402_authorize' })

      await withMigrationReverted(
        () => down(client),
        async () => {
          // Pre-087 shape: the old three-value set is back.
          await expect(insertRefusal({ user_id: userId, source: 'hosted_prepare' })).rejects.toMatchObject({ code: '23514' })
          await expect(insertRefusal({ user_id: userId, source: 'x402_authorize' })).resolves.toBeUndefined()
        },
        () => up(client),
      )

      // Head shape restored: hosted_prepare is accepted again.
      await expect(insertRefusal({ user_id: userId, source: 'hosted_prepare' })).resolves.toBeUndefined()
    } finally {
      client.release()
    }
  })
})
