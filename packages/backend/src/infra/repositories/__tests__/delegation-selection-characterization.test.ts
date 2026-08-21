/**
 * Characterization of `selectDelegationForPayment`'s ordering BEFORE #1698
 * changes it (money-path rule).
 *
 * Found by the independent review of #1698, and it is the good kind of
 * finding: a latent defect the re-key would have made reachable rather than
 * one the re-key introduces.
 *
 * Today the selection is:
 *
 *     WHERE ... status = 'active' AND (recipient_address = LOWER($3) OR recipient_address IS NULL)
 *     ORDER BY (recipient_address IS NULL), created_at DESC
 *
 * It filters on `status` and on the recipient, and on NOTHING about time. So
 * an ACTIVE delegation whose `start_date` is in the future — a grant the
 * period enforcer will not honour yet — is selectable today, and being the
 * most recently created row it is selected FIRST. The same is true of an
 * active row already past `expires_at`.
 *
 * That was harmless while every grant started ~60 s in the past (the build
 * route's only anchor), so a future `start_date` could not occur. #1698's
 * carry introduces one deliberately: the "steady" grant starts at the old
 * period boundary and is dormant until then, sitting alongside the live
 * "carry" grant in the same (token, recipient) slot. Under today's ordering
 * the dormant grant wins every payment for exactly the window the carry
 * exists to cover.
 *
 * These tests pin the current behaviour so the fix is visibly a change, and
 * so nobody later reads the fix as the way it always was.
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
    [`sel${n}-${Date.now()}@test.example`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'Selection agent') RETURNING id`,
    [user.rows[0].id],
  )
  return agent.rows[0].id
}

async function seedDelegation(
  agentId: string,
  over: { startDate?: number; expiresAt?: number; createdAt?: string; label?: string } = {},
): Promise<string> {
  const hash = `0x${String(++seq).padStart(64, '0')}`
  await db.query(
    `INSERT INTO agent_delegations
       (agent_id, chain_id, token_address, recipient_address, delegation_hash,
        delegation_json, version, status, budget_atomic, period_seconds,
        start_date, expires_at, created_at)
     VALUES ($1, 84532, $2, NULL, $3, $4, 1, 'active', '1000000', 86400, $5, $6,
             COALESCE($7::timestamptz, NOW()))`,
    [
      agentId,
      USDC,
      hash,
      JSON.stringify({ label: over.label ?? 'grant' }),
      over.startDate ?? 0,
      over.expiresAt ?? 9_999_999_999,
      over.createdAt ?? null,
    ],
  )
  return hash
}

describeDb('#1698 characterization — delegation selection ignores the time window', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('selects an active grant whose start_date is in the FUTURE', async () => {
    const agent = await seedAgent()
    const future = Math.floor(Date.now() / 1000) + 86_400
    const dormant = await seedDelegation(agent, { startDate: future, label: 'dormant' })

    const row = await selectDelegationForPayment(agent, USDC, RECIPIENT)
    // Today: yes. The period enforcer would revert this redemption, so the
    // payment fails on-chain rather than being routed to a usable grant.
    expect(row?.delegation_hash).toBe(dormant)
  })

  it('prefers the NEWEST row, so a dormant grant beats a live one in the same slot', async () => {
    const agent = await seedAgent()
    const nowSec = Math.floor(Date.now() / 1000)
    const live = await seedDelegation(agent, {
      startDate: nowSec - 3600,
      expiresAt: nowSec + 3600,
      createdAt: '2020-01-01T00:00:00Z',
      label: 'live',
    })
    const dormant = await seedDelegation(agent, {
      startDate: nowSec + 3600,
      createdAt: '2020-01-02T00:00:00Z',
      label: 'dormant',
    })

    const row = await selectDelegationForPayment(agent, USDC, RECIPIENT)
    // This is the shape #1698's carry+steady pair would land in. The dormant
    // one wins purely on created_at.
    expect(row?.delegation_hash).toBe(dormant)
    expect(row?.delegation_hash).not.toBe(live)
  })

  it('selects an active grant that is already past expires_at', async () => {
    const agent = await seedAgent()
    const expired = await seedDelegation(agent, {
      expiresAt: Math.floor(Date.now() / 1000) - 60,
      label: 'expired',
    })

    const row = await selectDelegationForPayment(agent, USDC, RECIPIENT)
    // The timestamp caveat would refuse this on-chain. Selection does not
    // know that; only `status` keeps rows out today.
    expect(row?.delegation_hash).toBe(expired)
  })
})
