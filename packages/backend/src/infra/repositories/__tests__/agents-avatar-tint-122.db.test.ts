/**
 * Real-Postgres proof for migration 122's RULES — a superseded agent keeps
 * holding its tint until it is archived (#4448, epic #4428 finding B1). No
 * mocks: every claim below is about what POSTGRES does, so it belongs on the
 * #1220 harness.
 *
 * The migration's own test
 * (`db/migrations/__tests__/122_agents_avatar_tint_superseded_holds.test.ts`)
 * pins the schema shape and the down/up cycle. This file pins the BEHAVIOUR:
 *
 *   - the backfill removes the collisions 121's rule left behind — an
 *     inherited pair, and a predecessor whose released tint a later agent
 *     took — recolouring the NEWER agent of each pair;
 *   - the backfill leaves a user with more than six non-archived agents alone;
 *   - unarchive gives a free tint when the stored tint is now held by another
 *     non-archived agent, and keeps it otherwise.
 *
 * The backfill cases seed the pre-122 world by reverting 122 (which restores
 * 121's inheritance trigger), recording the supersession, then letting 122's
 * `up()` run the backfill — the only way to reproduce rows written under 121.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import db from '../../../db.js'
import { down as down122, up as up122 } from '../../../db/migrations/122_agents_avatar_tint_superseded_holds.js'
import { unarchiveAgent } from '../agents.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'

async function run(step: typeof up122): Promise<void> {
  const client = await db.connect()
  try {
    await step(client)
  } finally {
    client.release()
  }
}

/** Run `body` with 122 reverted (121's inheritance trigger back), then re-apply 122. */
async function with122Reverted<T>(body: () => Promise<T>): Promise<T> {
  await run(down122)
  try {
    return await body()
  } finally {
    await run(up122)
  }
}

async function insertUser(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`${randomUUID()}@example.com`],
  )
  return rows[0].id
}

interface InsertAgentOptions {
  /** Days before now; larger = older. Defaults to 0 (newest). */
  ageDays?: number
  /** Explicit tint — the insert trigger keeps it. */
  tint?: number
}

async function insertAgent(userId: string, options: InsertAgentOptions = {}): Promise<string> {
  const columns = ['user_id', 'name', 'created_at']
  const values: unknown[] = [
    userId,
    `agent ${randomUUID().slice(0, 8)}`,
    new Date(Date.now() - (options.ageDays ?? 0) * 86_400_000),
  ]
  if (options.tint !== undefined) {
    columns.push('avatar_tint')
    values.push(options.tint)
  }
  const placeholders = values.map((_, i) => `$${i + 1}`).join(', ')
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO agents (${columns.join(', ')}) VALUES (${placeholders}) RETURNING id`,
    values,
  )
  return rows[0].id
}

async function tintOf(agentId: string): Promise<number> {
  const { rows } = await db.query<{ avatar_tint: number }>(
    `SELECT avatar_tint FROM agents WHERE id = $1`,
    [agentId],
  )
  return rows[0].avatar_tint
}

async function tintsOf(agentIds: string[]): Promise<number[]> {
  const out: number[] = []
  for (const id of agentIds) out.push(await tintOf(id))
  return out
}

describeDb('agents.avatar_tint — superseded agents hold their tint (#4448)', () => {
  beforeAll(async () => {
    await initDbHarness()
    // Defensive: whatever an earlier file left behind, head is 122.
    await resetDb()
    await run(up122)
  })

  beforeEach(async () => {
    await resetDb()
  })

  // ── Backfill ─────────────────────────────────────────────────────────────

  it('backfill removes an inherited pair, recolouring the newer agent', async () => {
    const userId = await insertUser()
    const predecessor = await insertAgent(userId, { ageDays: 2 })
    const replacement = await insertAgent(userId, { ageDays: 1 })
    expect(await tintsOf([predecessor, replacement])).toEqual([1, 2])

    await with122Reverted(async () => {
      // 121's inheritance trigger recolours the replacement to the
      // predecessor's tint — the B1 pair.
      await db.query(`UPDATE agents SET superseded_by_agent_id = $1 WHERE id = $2`, [
        replacement,
        predecessor,
      ])
      expect(await tintsOf([predecessor, replacement])).toEqual([1, 1])
    })

    // 122's up() ran the backfill: the older agent keeps the tint, the newer
    // one moves to a free tint.
    expect(await tintOf(predecessor)).toBe(1)
    expect(await tintOf(replacement)).toBe(2)
  })

  it('backfill removes a released-and-retaken collision, recolouring the newer agent', async () => {
    const userId = await insertUser()
    const predecessor = await insertAgent(userId, { ageDays: 3, tint: 1 })
    const replacement = await insertAgent(userId, { ageDays: 2, tint: 2 })
    // 121 released the predecessor's tint on supersession, so a later agent
    // took it while the predecessor was still visible.
    await db.query(`UPDATE agents SET superseded_by_agent_id = $1 WHERE id = $2`, [
      replacement,
      predecessor,
    ])
    const later = await insertAgent(userId, { ageDays: 1, tint: 1 })
    expect(await tintsOf([predecessor, later])).toEqual([1, 1])

    await run(up122)

    expect(await tintOf(predecessor)).toBe(1)
    expect(await tintOf(replacement)).toBe(2)
    expect(await tintOf(later)).toBe(3)
  })

  it('backfill leaves a user with more than six non-archived agents alone', async () => {
    const userId = await insertUser()
    const ids: string[] = []
    for (let i = 0; i < 6; i += 1) ids.push(await insertAgent(userId, { ageDays: 7 - i, tint: i + 1 }))
    // The seventh repeats tint 1 — unavoidable past six, and not the
    // backfill's business.
    ids.push(await insertAgent(userId, { ageDays: 1, tint: 1 }))

    await run(up122)

    expect(await tintsOf(ids)).toEqual([1, 2, 3, 4, 5, 6, 1])
  })

  // ── Unarchive ────────────────────────────────────────────────────────────

  it('unarchive gives a free tint when the stored tint is held by another non-archived agent', async () => {
    const userId = await insertUser()
    const archived = await insertAgent(userId)
    const other = await insertAgent(userId)
    expect(await tintsOf([archived, other])).toEqual([1, 2])

    await db.query(`UPDATE agents SET archived_at = NOW() WHERE id = $1`, [archived])
    // The archived agent released tint 1, so a new agent took it.
    const taker = await insertAgent(userId)
    expect(await tintOf(taker)).toBe(1)

    expect(await unarchiveAgent(archived, userId)).toBe(true)

    expect(await tintOf(archived)).toBe(3)
    expect(await tintOf(taker)).toBe(1)
    expect(await tintOf(other)).toBe(2)
  })

  it('unarchive keeps the stored tint when no other non-archived agent holds it', async () => {
    const userId = await insertUser()
    const archived = await insertAgent(userId)
    await db.query(`UPDATE agents SET archived_at = NOW() WHERE id = $1`, [archived])

    expect(await unarchiveAgent(archived, userId)).toBe(true)

    expect(await tintOf(archived)).toBe(1)
  })
})
