/**
 * Real-DB tests for agent supersession (#3772).
 *
 * Claims about POSTGRES: a replace stamps only the caller's own agents (another
 * user's agent is never marked), the replacement never marks itself, a later
 * replace overwrites, and an unmarked agent reads back null.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import { findAgentSupersession, markAgentsSuperseded } from '../agents.js'

async function insertUser(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`${randomBytes(8).toString('hex')}@example.com`],
  )
  return rows[0].id
}

async function insertAgent(userId: string, name = 'agent'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, status) VALUES ($1, $2, 'active') RETURNING id`,
    [userId, name],
  )
  return rows[0].id
}

describeDb('agent supersession (#3772, real DB)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
  })

  it('marks the caller\'s own agents and reads the stamp back as an ISO string', async () => {
    const user = await insertUser()
    const x1 = await insertAgent(user)
    const x2 = await insertAgent(user)
    const y = await insertAgent(user)

    const marked = await markAgentsSuperseded({ userId: user, replacementAgentId: y, agentIds: [x1, x2] })
    expect(marked.sort()).toEqual([x1, x2].sort())

    const stamp = await findAgentSupersession(x1)
    expect(stamp?.agent_id).toBe(y)
    expect(typeof stamp?.superseded_at).toBe('string')
    expect(new Date(stamp!.superseded_at).toISOString()).toBe(stamp!.superseded_at)
  })

  it('never marks another user\'s agent', async () => {
    const owner = await insertUser()
    const other = await insertUser()
    const y = await insertAgent(owner)
    const mine = await insertAgent(owner)
    const theirs = await insertAgent(other)

    const marked = await markAgentsSuperseded({ userId: owner, replacementAgentId: y, agentIds: [mine, theirs] })
    expect(marked).toEqual([mine])
    expect(await findAgentSupersession(theirs)).toBeNull()
  })

  it('excludes the replacement itself', async () => {
    const user = await insertUser()
    const y = await insertAgent(user)
    const x = await insertAgent(user)

    const marked = await markAgentsSuperseded({ userId: user, replacementAgentId: y, agentIds: [y, x] })
    expect(marked).toEqual([x])
    expect(await findAgentSupersession(y)).toBeNull()
  })

  it('overwrites on a later replace (latest wins)', async () => {
    const user = await insertUser()
    const x = await insertAgent(user)
    const y1 = await insertAgent(user)
    const y2 = await insertAgent(user)

    await markAgentsSuperseded({ userId: user, replacementAgentId: y1, agentIds: [x] })
    await markAgentsSuperseded({ userId: user, replacementAgentId: y2, agentIds: [x] })
    expect((await findAgentSupersession(x))?.agent_id).toBe(y2)
  })

  it('returns null for an unmarked agent and for an unknown id', async () => {
    const user = await insertUser()
    const x = await insertAgent(user)
    expect(await findAgentSupersession(x)).toBeNull()
    expect(await findAgentSupersession('99999999-9999-9999-9999-999999999999')).toBeNull()
  })

  it('reads null again when the replacement is hard-deleted (ON DELETE SET NULL)', async () => {
    const user = await insertUser()
    const x = await insertAgent(user)
    const y = await insertAgent(user)
    await markAgentsSuperseded({ userId: user, replacementAgentId: y, agentIds: [x] })
    await db.query(`DELETE FROM agents WHERE id = $1`, [y])
    expect(await findAgentSupersession(x)).toBeNull()
  })
})
