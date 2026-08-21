/**
 * `selectDelegationForPayment` after #1698's window fix.
 *
 * What this replaced is pinned in history rather than beside it: the commit
 * titled "characterize delegation selection's blindness to the time window"
 * added `delegation-selection-characterization.test.ts`, which asserted the
 * OLD behaviour — selection filtered on `status` and on nothing about time,
 * so a dormant or expired grant was selectable and, being newest, selected
 * first. That file is deleted here rather than inverted: a characterization
 * test's job ends when the behaviour it pinned is gone, and two files
 * asserting opposite things about one query is worse than one file and a
 * commit. Each assertion below has a counterpart in that commit.
 *
 * Real-DB, and it has to be: every assertion is about which row a SQL
 * predicate and ORDER BY return, including a comparison against the DATABASE
 * clock. Mocking the query would test the mock's opinion of `NOW()`.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import { selectDelegationForPayment } from '../delegation-budgets.js'

const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const RECIPIENT = '0x00000000000000000000000000000000000000aa'

let seq = 0

async function seedAgent(): Promise<string> {
  const n = ++seq
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`win${n}-${Date.now()}@test.example`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'Window agent') RETURNING id`,
    [user.rows[0].id],
  )
  return agent.rows[0].id
}

async function seedDelegation(
  agentId: string,
  over: {
    startDate?: number
    expiresAt?: number
    createdAt?: string
    recipient?: string | null
    carryRole?: string | null
  } = {},
): Promise<string> {
  const hash = `0x${String(++seq).padStart(64, '0')}`
  await db.query(
    `INSERT INTO agent_delegations
       (agent_id, chain_id, token_address, recipient_address, delegation_hash,
        delegation_json, version, status, budget_atomic, period_seconds,
        start_date, expires_at, created_at, carry_role)
     VALUES ($1, 84532, $2, $3, $4, '{}', 1, 'active', '1000000', 86400, $5, $6,
             COALESCE($7::timestamptz, NOW()), $8)`,
    [
      agentId,
      USDC,
      over.recipient ?? null,
      hash,
      over.startDate ?? 0,
      over.expiresAt ?? 9_999_999_999,
      over.createdAt ?? null,
      over.carryRole ?? null,
    ],
  )
  return hash
}

describeDb('selectDelegationForPayment respects the on-chain time window (#1698)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  const nowSec = () => Math.floor(Date.now() / 1000)

  it('MUTATION TARGET — never selects a grant whose first period has not opened', async () => {
    const agent = await seedAgent()
    await seedDelegation(agent, { startDate: nowSec() + 86_400 })
    // Dropping the `start_date <= NOW()` predicate makes this return the row.
    expect(await selectDelegationForPayment(agent, USDC, RECIPIENT)).toBeNull()
  })

  it('MUTATION TARGET — never selects a grant already past its expiry', async () => {
    const agent = await seedAgent()
    await seedDelegation(agent, { expiresAt: nowSec() - 60 })
    expect(await selectDelegationForPayment(agent, USDC, RECIPIENT)).toBeNull()
  })

  it('THE #1698 CASE — the live carry wins over the dormant steady in the same slot', async () => {
    const agent = await seedAgent()
    const boundary = nowSec() + 3600
    // Inserted in the order the issue step inserts them: carry, then steady.
    const carry = await seedDelegation(agent, {
      startDate: boundary - 86_400,
      expiresAt: boundary,
      createdAt: '2020-01-01T00:00:00Z',
      carryRole: 'carry',
    })
    await seedDelegation(agent, {
      startDate: boundary,
      expiresAt: nowSec() + 90 * 86_400,
      createdAt: '2020-01-02T00:00:00Z',
      carryRole: 'steady',
    })

    // Before the fix this returned the steady grant — newest by created_at,
    // and unusable on-chain for another hour.
    const row = await selectDelegationForPayment(agent, USDC, RECIPIENT)
    expect(row?.delegation_hash).toBe(carry)
  })

  it('prefers the soonest-expiring live grant — spend the perishable one first', async () => {
    const agent = await seedAgent()
    const soon = await seedDelegation(agent, {
      expiresAt: nowSec() + 3600,
      createdAt: '2020-01-01T00:00:00Z',
    })
    await seedDelegation(agent, {
      expiresAt: nowSec() + 90 * 86_400,
      createdAt: '2020-01-09T00:00:00Z',
    })
    const row = await selectDelegationForPayment(agent, USDC, RECIPIENT)
    expect(row?.delegation_hash).toBe(soon)
  })

  it('keeps the pinned-beats-open rule ahead of the expiry ordering (#829)', async () => {
    // The recipient pin is the owner's intent for that recipient and must
    // still win, even against an open grant that expires sooner.
    const agent = await seedAgent()
    const pinned = await seedDelegation(agent, {
      recipient: RECIPIENT,
      expiresAt: nowSec() + 90 * 86_400,
    })
    await seedDelegation(agent, { recipient: null, expiresAt: nowSec() + 3600 })

    const row = await selectDelegationForPayment(agent, USDC, RECIPIENT)
    expect(row?.delegation_hash).toBe(pinned)
    expect(row?.recipient_address).toBe(RECIPIENT)
  })

  it('still falls back to the open grant when the pin names someone else', async () => {
    const agent = await seedAgent()
    await seedDelegation(agent, { recipient: RECIPIENT })
    const open = await seedDelegation(agent, { recipient: null })
    const other = '0x00000000000000000000000000000000000000bb'
    expect((await selectDelegationForPayment(agent, USDC, other))?.delegation_hash).toBe(open)
  })

  it('still ignores non-active rows', async () => {
    const agent = await seedAgent()
    const hash = await seedDelegation(agent)
    await db.query(`UPDATE agent_delegations SET status = 'revoked' WHERE delegation_hash = $1`, [
      hash,
    ])
    expect(await selectDelegationForPayment(agent, USDC, RECIPIENT)).toBeNull()
  })

  it('compares against the DATABASE clock, not the caller\'s', async () => {
    // Two app instances disagreeing about "now" must not disagree about which
    // grant authorizes a payment. Proven by using the DB's own NOW() to build
    // a row that is live by exactly one second.
    const agent = await seedAgent()
    const hash = `0x${String(++seq).padStart(64, '0')}`
    await db.query(
      `INSERT INTO agent_delegations
         (agent_id, chain_id, token_address, recipient_address, delegation_hash,
          delegation_json, version, status, budget_atomic, period_seconds,
          start_date, expires_at)
       VALUES ($1, 84532, $2, NULL, $3, '{}', 1, 'active', '1000000', 86400,
               EXTRACT(EPOCH FROM NOW())::bigint - 1, EXTRACT(EPOCH FROM NOW())::bigint + 60)`,
      [agent, USDC, hash],
    )
    expect((await selectDelegationForPayment(agent, USDC, RECIPIENT))?.delegation_hash).toBe(hash)
  })
})
