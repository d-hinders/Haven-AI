/**
 * Real-DB tests for the erc7710 settlement-observed transition (#2092).
 *
 * What is at stake: this is the ONE transition that turns an agent-reported
 * transaction hash into a `confirmed` payment intent, and therefore into a
 * line in the user's bookkeeping. Every conjunct of its WHERE clause is a
 * guard, so every guard is exercised on BOTH sides — the row that must
 * transition and the row that must not.
 *
 * Zero mocks; the harness is real Postgres (#1220), per
 * `docs/contributing/testing-strategy.md`.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import { confirmObservedSettlement } from '../x402-authorizations.js'

let seq = 0

const HASH_A = `0x${'a'.repeat(64)}`
const HASH_B = `0x${'b'.repeat(64)}`

async function seedAgent(): Promise<{ agentId: string; userId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`obs-${++seq}-${Date.now()}@test.example`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'observed agent') RETURNING id`,
    [user.rows[0].id],
  )
  return { agentId: agent.rows[0].id, userId: user.rows[0].id }
}

interface IntentSeed {
  agentId: string
  userId: string
  status?: string
  executionRail?: string | null
  scheme?: string | null
  txHash?: string | null
  source?: string
}

async function seedIntent(seed: IntentSeed): Promise<string> {
  const metadata =
    seed.scheme === null ? null : JSON.stringify({ settlement_scheme: seed.scheme ?? 'erc7710' })
  const result = await db.query<{ id: string }>(
    `INSERT INTO payment_intents
       (agent_id, user_id, safe_address, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
        status, expires_at, source, payment_rail, execution_rail, machine_metadata, tx_hash)
     VALUES ($1, $2, '0x00000000000000000000000000000000000000f1', 'USDC',
             '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
             '0x00000000000000000000000000000000000000aa',
             '100000', '0.10', '0x00000000000000000000000000000000000000d1',
             0, $3, $4, NOW() + interval '10 minutes', $5, $5, $6, $7::jsonb, $8)
     RETURNING id`,
    [
      seed.agentId,
      seed.userId,
      `0x${String(++seq).padStart(64, 'c')}`.slice(0, 66),
      seed.status ?? 'submitted',
      seed.source ?? 'x402',
      seed.executionRail === undefined ? 'delegation' : seed.executionRail,
      metadata,
      seed.txHash ?? null,
    ],
  )
  return result.rows[0].id
}

async function readIntent(id: string) {
  const r = await db.query(`SELECT * FROM payment_intents WHERE id = $1`, [id])
  return r.rows[0]
}

const confirm = (intentId: string, agentId: string, txHash = HASH_A) =>
  confirmObservedSettlement({ txHash, intentId, agentId, usdValue: 0.1, eurValue: 0.09 })

describeDb('erc7710 settlement-observed transition (#2092)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  // ── The happy transition ────────────────────────────────────────────────

  it('confirms a submitted erc7710 delegation-rail intent and records the settlement hash', async () => {
    const { agentId, userId } = await seedAgent()
    const intentId = await seedIntent({ agentId, userId })

    await expect(confirm(intentId, agentId)).resolves.toBe(true)

    const row = await readIntent(intentId)
    expect(row.status).toBe('confirmed')
    expect(row.tx_hash).toBe(HASH_A)
    expect(row.confirmed_at).not.toBeNull()
    expect(Number(row.usd_value)).toBeCloseTo(0.1)
  })

  // ── The status/hash CAS ─────────────────────────────────────────────────

  it('refuses an intent that is not submitted', async () => {
    const { agentId, userId } = await seedAgent()
    const intentId = await seedIntent({ agentId, userId, status: 'pending_signature' })

    await expect(confirm(intentId, agentId)).resolves.toBe(false)
    expect((await readIntent(intentId)).status).toBe('pending_signature')
  })

  it('refuses to re-point an intent that already carries a hash', async () => {
    const { agentId, userId } = await seedAgent()
    const intentId = await seedIntent({ agentId, userId, txHash: HASH_B })

    await expect(confirm(intentId, agentId, HASH_A)).resolves.toBe(false)
    expect((await readIntent(intentId)).tx_hash).toBe(HASH_B)
  })

  it('EXACTLY ONE of N concurrent reports on the same intent wins the CAS', async () => {
    const { agentId, userId } = await seedAgent()
    const intentId = await seedIntent({ agentId, userId })

    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () => confirm(intentId, agentId)),
    )
    expect(outcomes.filter(Boolean)).toHaveLength(1)
    expect((await readIntent(intentId)).status).toBe('confirmed')
  })

  // ── Scheme / rail scoping: other schemes keep their own transitions ─────

  it('refuses an eip3009 intent — that scheme confirms through its funding leg', async () => {
    const { agentId, userId } = await seedAgent()
    const intentId = await seedIntent({ agentId, userId, scheme: 'eip3009' })

    await expect(confirm(intentId, agentId)).resolves.toBe(false)
    expect((await readIntent(intentId)).status).toBe('submitted')
  })

  it('refuses an intent with no settlement scheme recorded (legacy rail)', async () => {
    const { agentId, userId } = await seedAgent()
    const intentId = await seedIntent({ agentId, userId, executionRail: null, scheme: null })

    await expect(confirm(intentId, agentId)).resolves.toBe(false)
    expect((await readIntent(intentId)).status).toBe('submitted')
  })

  it('refuses a non-delegation execution rail even when the scheme says erc7710', async () => {
    const { agentId, userId } = await seedAgent()
    const intentId = await seedIntent({ agentId, userId, executionRail: null })

    await expect(confirm(intentId, agentId)).resolves.toBe(false)
    expect((await readIntent(intentId)).status).toBe('submitted')
  })

  it('refuses a non-x402 rail', async () => {
    const { agentId, userId } = await seedAgent()
    const intentId = await seedIntent({ agentId, userId, source: 'mpp_demo' })

    await expect(confirm(intentId, agentId)).resolves.toBe(false)
    expect((await readIntent(intentId)).status).toBe('submitted')
  })

  // ── Tenant scope ────────────────────────────────────────────────────────

  it("refuses another agent's intent", async () => {
    const { agentId, userId } = await seedAgent()
    const other = await seedAgent()
    const intentId = await seedIntent({ agentId, userId })

    await expect(confirm(intentId, other.agentId)).resolves.toBe(false)
    expect((await readIntent(intentId)).status).toBe('submitted')
  })

  // ── Replay: one settlement transaction, at most one intent ──────────────

  it('refuses to confirm a SECOND intent with a hash that already confirms another', async () => {
    const { agentId, userId } = await seedAgent()
    const first = await seedIntent({ agentId, userId })
    const second = await seedIntent({ agentId, userId })

    await expect(confirm(first, agentId, HASH_A)).resolves.toBe(true)
    await expect(confirm(second, agentId, HASH_A)).resolves.toBe(false)

    const secondRow = await readIntent(second)
    expect(secondRow.status).toBe('submitted')
    expect(secondRow.tx_hash).toBeNull()
  })

  it('refuses a replay across agents — the guard is not tenant-scoped', async () => {
    const a = await seedAgent()
    const b = await seedAgent()
    const first = await seedIntent({ agentId: a.agentId, userId: a.userId })
    const second = await seedIntent({ agentId: b.agentId, userId: b.userId })

    await expect(confirm(first, a.agentId, HASH_A)).resolves.toBe(true)
    await expect(confirm(second, b.agentId, HASH_A)).resolves.toBe(false)
    expect((await readIntent(second)).status).toBe('submitted')
  })

  it('refuses a replay reported in different case — hashes compare case-insensitively', async () => {
    const { agentId, userId } = await seedAgent()
    const first = await seedIntent({ agentId, userId })
    const second = await seedIntent({ agentId, userId })

    await expect(confirm(first, agentId, HASH_A)).resolves.toBe(true)
    await expect(confirm(second, agentId, HASH_A.toUpperCase().replace('0X', '0x'))).resolves.toBe(
      false,
    )
    expect((await readIntent(second)).status).toBe('submitted')
  })

  it('EXACTLY ONE of N concurrent intents can be confirmed by the same hash', async () => {
    const { agentId, userId } = await seedAgent()
    const intentIds = await Promise.all(
      Array.from({ length: 6 }, () => seedIntent({ agentId, userId })),
    )

    const outcomes = await Promise.all(intentIds.map((id) => confirm(id, agentId, HASH_A)))
    expect(outcomes.filter(Boolean)).toHaveLength(1)

    const rows = await Promise.all(intentIds.map(readIntent))
    expect(rows.filter((r) => r.status === 'confirmed')).toHaveLength(1)
  })

  // ── A distinct hash is still fine ───────────────────────────────────────

  it('confirms two different intents with two different hashes', async () => {
    const { agentId, userId } = await seedAgent()
    const first = await seedIntent({ agentId, userId })
    const second = await seedIntent({ agentId, userId })

    await expect(confirm(first, agentId, HASH_A)).resolves.toBe(true)
    await expect(confirm(second, agentId, HASH_B)).resolves.toBe(true)
  })
})
