/**
 * Real-Postgres proof for the #4429 assignment rules — `agents.avatar_tint`
 * (epic #4428 slice 1). No mocks: every claim below is about what POSTGRES
 * does, so it belongs on the #1220 harness.
 *
 * The migration's own test (`db/migrations/__tests__/121_agents_avatar_tint.test.ts`)
 * pins the schema shape and the down/up cycle. This file pins the BEHAVIOUR:
 *
 *   - the backfill (held first, oldest first per user, then released by
 *     least-used/lowest number, per user);
 *   - the BEFORE INSERT trigger (a plain insert that does not name the column
 *     still gets a tint — 127 insert sites and old replicas depend on it);
 *   - held / released / inherited (archived and superseded agents free their
 *     tint, pending_approval and revoked agents keep it, and setting
 *     `superseded_by_agent_id` hands the predecessor's tint to the
 *     replacement unless another held agent holds it).
 *
 * The backfill cases run with the column ABSENT (`down()`), insert their
 * fixture, then let `up()` do the backfill — the only way to reproduce rows
 * that predate the migration.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import db from '../../../db.js'
import { down, up } from '../../../db/migrations/121_agents_avatar_tint.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'

async function run(step: typeof up): Promise<void> {
  const client = await db.connect()
  try {
    await step(client)
  } finally {
    client.release()
  }
}

/**
 * Run `body` with migration 121 reverted, then restore it. `up()` is what
 * performs the backfill, so the fixture inserted inside `body` is exactly the
 * "rows that predate the migration" case.
 */
async function withColumnAbsent<T>(body: () => Promise<T>): Promise<T> {
  await run(down)
  try {
    return await body()
  } finally {
    await run(up)
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
  status?: string
  archived?: boolean
  /** Explicit tint — only meaningful while the column exists. */
  tint?: number
}

/**
 * Insert an agent. `tint` is omitted from the statement unless given, which is
 * the "old replica / test helper" shape the trigger exists for.
 */
async function insertAgent(userId: string, options: InsertAgentOptions = {}): Promise<string> {
  const columns = ['user_id', 'name', 'created_at', 'status']
  const values: unknown[] = [
    userId,
    `agent ${randomUUID().slice(0, 8)}`,
    new Date(Date.now() - (options.ageDays ?? 0) * 86_400_000),
    options.status ?? 'active',
  ]
  if (options.archived) {
    columns.push('archived_at')
    values.push(new Date())
  }
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

describeDb('agents.avatar_tint assignment rules (#4429)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  // ── Backfill ─────────────────────────────────────────────────────────────

  it('backfills one user\'s 4 agents with tints 1-4 in age order', async () => {
    const userId = await insertUser()
    const ids = await withColumnAbsent(async () => [
      await insertAgent(userId, { ageDays: 4 }),
      await insertAgent(userId, { ageDays: 3 }),
      await insertAgent(userId, { ageDays: 2 }),
      await insertAgent(userId, { ageDays: 1 }),
    ])

    expect(await tintsOf(ids)).toEqual([1, 2, 3, 4])
  })

  it('backfills a user\'s 8 agents with the least-used, lowest-numbered tints for the 7th and 8th', async () => {
    const userId = await insertUser()
    const ids = await withColumnAbsent(async () => {
      const out: string[] = []
      for (let age = 8; age >= 1; age -= 1) out.push(await insertAgent(userId, { ageDays: age }))
      return out
    })

    // The first six take 1..6; with every tint held once, the fallback is the
    // least-used, lowest-numbered tint — 1, then 2.
    expect(await tintsOf(ids)).toEqual([1, 2, 3, 4, 5, 6, 1, 2])
  })

  it('backfills each user independently — another user\'s agents do not affect the assignment', async () => {
    const userA = await insertUser()
    const userB = await insertUser()
    const { a, b } = await withColumnAbsent(async () => ({
      a: [
        await insertAgent(userA, { ageDays: 4 }),
        await insertAgent(userA, { ageDays: 3 }),
        await insertAgent(userA, { ageDays: 2 }),
        await insertAgent(userA, { ageDays: 1 }),
      ],
      b: [
        await insertAgent(userB, { ageDays: 4 }),
        await insertAgent(userB, { ageDays: 3 }),
        await insertAgent(userB, { ageDays: 2 }),
        await insertAgent(userB, { ageDays: 1 }),
      ],
    }))

    expect(await tintsOf(a)).toEqual([1, 2, 3, 4])
    expect(await tintsOf(b)).toEqual([1, 2, 3, 4])
  })

  it('backfills held agents before released ones, so a released agent never takes a held agent\'s tint', async () => {
    const userId = await insertUser()
    const ids = await withColumnAbsent(async () => {
      // The released agents are the OLDEST rows: if the backfill coloured
      // them first they would take 1 and 2 and push the held agents up.
      const archived = await insertAgent(userId, { ageDays: 4, archived: true })
      const superseded = await insertAgent(userId, { ageDays: 3 })
      const heldOld = await insertAgent(userId, { ageDays: 2 })
      const heldNew = await insertAgent(userId, { ageDays: 1 })
      // Mark the second row superseded by the newest held agent. The inherit
      // trigger does not exist yet (the column is absent), so this only
      // records the release.
      await db.query(`UPDATE agents SET superseded_by_agent_id = $1 WHERE id = $2`, [heldNew, superseded])
      return { archived, superseded, heldOld, heldNew }
    })

    // Held first, oldest first: heldOld=1, heldNew=2. Then released by
    // least-used/lowest: archived=3, superseded=4.
    expect(await tintOf(ids.heldOld)).toBe(1)
    expect(await tintOf(ids.heldNew)).toBe(2)
    expect(await tintOf(ids.archived)).toBe(3)
    expect(await tintOf(ids.superseded)).toBe(4)
  })

  // ── BEFORE INSERT trigger ────────────────────────────────────────────────

  it('a plain INSERT that does not name avatar_tint gets the first free tint', async () => {
    const userId = await insertUser()
    const first = await insertAgent(userId)
    const second = await insertAgent(userId)

    expect(await tintOf(first)).toBe(1)
    expect(await tintOf(second)).toBe(2)
  })

  it('an explicit tint is kept', async () => {
    const userId = await insertUser()
    const agentId = await insertAgent(userId, { tint: 4 })

    expect(await tintOf(agentId)).toBe(4)
  })

  it('inserting a new agent never changes an existing agent\'s tint', async () => {
    const userId = await insertUser()
    const first = await insertAgent(userId)
    expect(await tintOf(first)).toBe(1)

    await insertAgent(userId)
    await insertAgent(userId)

    expect(await tintOf(first)).toBe(1)
  })

  it('spreads duplicates when all six tints are held', async () => {
    const userId = await insertUser()
    const ids: string[] = []
    for (let i = 0; i < 8; i += 1) ids.push(await insertAgent(userId))

    expect(await tintsOf(ids)).toEqual([1, 2, 3, 4, 5, 6, 1, 2])
  })

  // ── Held, released, inherited ────────────────────────────────────────────

  it('an archived agent\'s tint is free for the next new agent, and its own stored tint does not change', async () => {
    const userId = await insertUser()
    const archived = await insertAgent(userId)
    const other = await insertAgent(userId)
    expect(await tintsOf([archived, other])).toEqual([1, 2])

    await db.query(`UPDATE agents SET archived_at = NOW() WHERE id = $1`, [archived])

    const next = await insertAgent(userId)
    expect(await tintOf(next)).toBe(1)
    // Neither existing row was recoloured.
    expect(await tintOf(archived)).toBe(1)
    expect(await tintOf(other)).toBe(2)
  })

  it('a superseded agent\'s tint is free for the next new agent, and its own stored tint does not change', async () => {
    const userId = await insertUser()
    const predecessor = await insertAgent(userId)
    const replacement = await insertAgent(userId)
    expect(await tintsOf([predecessor, replacement])).toEqual([1, 2])

    // The replacement inherits the predecessor's tint (1), releasing its own
    // (2) for the next new agent. The predecessor's stored tint is untouched.
    await db.query(`UPDATE agents SET superseded_by_agent_id = $1 WHERE id = $2`, [
      replacement,
      predecessor,
    ])

    expect(await tintOf(predecessor)).toBe(1)
    expect(await tintOf(replacement)).toBe(1)

    const next = await insertAgent(userId)
    expect(await tintOf(next)).toBe(2)
  })

  it('a pending_approval agent and a revoked agent block their tint', async () => {
    const userId = await insertUser()
    const pending = await insertAgent(userId, { status: 'pending_approval' })
    const revoked = await insertAgent(userId, { status: 'revoked' })
    const active = await insertAgent(userId, { status: 'active' })

    // Neither status is archived or superseded, so both hold their tint.
    expect(await tintsOf([pending, revoked, active])).toEqual([1, 2, 3])
  })

  it('setting superseded_by_agent_id gives the replacement the predecessor\'s tint', async () => {
    const userId = await insertUser()
    const predecessor = await insertAgent(userId)
    const replacement = await insertAgent(userId)

    await db.query(`UPDATE agents SET superseded_by_agent_id = $1 WHERE id = $2`, [
      replacement,
      predecessor,
    ])

    expect(await tintOf(replacement)).toBe(1)
  })

  it('does not inherit when another held agent already holds the predecessor\'s tint', async () => {
    const userId = await insertUser()
    const predecessor = await insertAgent(userId, { tint: 1 })
    const replacement = await insertAgent(userId, { tint: 2 })
    // A third held agent holds tint 1 too, so the replacement must keep 2.
    const blocker = await insertAgent(userId, { tint: 1 })

    await db.query(`UPDATE agents SET superseded_by_agent_id = $1 WHERE id = $2`, [
      replacement,
      predecessor,
    ])

    expect(await tintOf(replacement)).toBe(2)
    expect(await tintOf(predecessor)).toBe(1)
    expect(await tintOf(blocker)).toBe(1)
  })

  it('inherits only once — a later unrelated update does not recolour the replacement', async () => {
    const userId = await insertUser()
    const predecessor = await insertAgent(userId)
    const replacement = await insertAgent(userId)

    await db.query(`UPDATE agents SET superseded_by_agent_id = $1 WHERE id = $2`, [
      replacement,
      predecessor,
    ])
    expect(await tintOf(replacement)).toBe(1)

    // A rename is not a supersession: the trigger is scoped to
    // `UPDATE OF superseded_by_agent_id`, so the tint stays put.
    await db.query(`UPDATE agents SET name = 'renamed' WHERE id = $1`, [replacement])
    expect(await tintOf(replacement)).toBe(1)
  })
})
