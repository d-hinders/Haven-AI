/**
 * The owner's own-address set on the real database (#4897, epic #4885).
 *
 * `listOwnAccountAddresses` is the one set the index-time flag
 * (`inbound_transfers.sender_is_own_address`) and a merchant sale row's own-sender
 * accounting are both decided against. The first block pins what it answered
 * BEFORE #4897 (every smart account of the user, any network — the
 * characterization); the second block pins the widened set the owner decided on
 * 2026-11-16: it also holds every agent's delegate address (revoked agents
 * included) and every delegate address a key rotation replaced.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import { listOwnAccountAddresses } from '../inbound-transfers.js'

function addr(): string {
  return '0x' + randomUUID().replace(/-/g, '').padEnd(40, 'a').slice(0, 40)
}

async function seedUser(): Promise<string> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`own-addr-${randomUUID()}@test.example`],
  )
  return user.rows[0].id
}

async function seedAccount(userId: string, chainId: number, address: string): Promise<void> {
  await db.query(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type, is_default)
     VALUES ($1, $2, $3, 'delegation', 'delegator_hybrid', false)`,
    [userId, address, chainId],
  )
}

async function seedAgent(
  userId: string,
  delegate: string | null,
  status: string = 'active',
): Promise<string> {
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, delegate_address, status) VALUES ($1, 'a', $2, $3) RETURNING id`,
    [userId, delegate, status],
  )
  return agent.rows[0].id
}

describeDb('listOwnAccountAddresses (#4897)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
  })

  describe('characterization: the smart-account set', () => {
    it('holds every smart account of the user on any network, lower-cased, and no other user\'s', async () => {
      const user = await seedUser()
      const other = await seedUser()
      const a = addr().toUpperCase().replace('0X', '0x')
      const b = addr()
      const foreign = addr()
      await seedAccount(user, 84532, a)
      await seedAccount(user, 8453, b)
      await seedAccount(other, 84532, foreign)

      const set = await listOwnAccountAddresses(user)
      expect(new Set(set)).toEqual(new Set([a.toLowerCase(), b.toLowerCase()]))
      expect(set).not.toContain(foreign.toLowerCase())
    })

    it('is empty for a user with nothing', async () => {
      expect(await listOwnAccountAddresses(await seedUser())).toEqual([])
    })
  })

  describe('the widened set', () => {
    it('adds every agent delegate address of the user, revoked agents included, and not another user\'s', async () => {
      const user = await seedUser()
      const other = await seedUser()
      const live = addr()
      const revoked = addr()
      const foreign = addr()
      await seedAgent(user, live)
      await seedAgent(user, revoked, 'revoked')
      await seedAgent(user, null)
      await seedAgent(other, foreign)

      const set = await listOwnAccountAddresses(user)
      expect(set).toContain(live.toLowerCase())
      expect(set).toContain(revoked.toLowerCase())
      expect(set).not.toContain(foreign.toLowerCase())
    })

    it('adds a delegate address replaced by rotation, which the agent row no longer holds', async () => {
      const user = await seedUser()
      const oldDelegate = addr()
      const newDelegate = addr()
      const agentId = await seedAgent(user, newDelegate)
      await db.query(
        `INSERT INTO agent_rekeys (agent_id, initiated_by_user_id, old_delegate_address, new_delegate_address)
         VALUES ($1, $2, $3, $4)`,
        [agentId, user, oldDelegate.toUpperCase().replace('0X', '0x'), newDelegate],
      )

      const set = await listOwnAccountAddresses(user)
      expect(set).toContain(oldDelegate.toLowerCase())
      expect(set).toContain(newDelegate.toLowerCase())
    })

    it('does not take another user\'s rotated delegate', async () => {
      const user = await seedUser()
      const other = await seedUser()
      const otherAgent = await seedAgent(other, addr())
      const otherOld = addr()
      await db.query(
        `INSERT INTO agent_rekeys (agent_id, initiated_by_user_id, old_delegate_address, new_delegate_address)
         VALUES ($1, $2, $3, $4)`,
        [otherAgent, other, otherOld, addr()],
      )
      expect(await listOwnAccountAddresses(user)).not.toContain(otherOld.toLowerCase())
    })

    it('answers one address once however many sources hold it', async () => {
      const user = await seedUser()
      const shared = addr()
      await seedAccount(user, 84532, shared)
      await seedAgent(user, shared)
      const set = await listOwnAccountAddresses(user)
      expect(set.filter((a) => a === shared.toLowerCase())).toHaveLength(1)
    })
  })
})
