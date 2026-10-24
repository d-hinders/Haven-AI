/**
 * Real-DB tests for the attention-dismissals repository (#3813).
 *
 * Every claim here is a claim about POSTGRES: that a dismissal is stored
 * per account / per agent and scoped to the dismissing user, that a
 * re-dismiss is a no-op (same row, never a duplicate), that a dismissal for
 * an account or agent the caller does not own is never written, and that
 * the list read is the user's whole dismissal set. A positional mock would
 * assert only that `query` was called in the order the test already
 * assumed.
 */
import { beforeEach, expect, it } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import {
  acknowledgeAgentItem,
  acknowledgeUserItem,
  dismissBackupSigner,
  dismissNeedsSetup,
  listAttentionDismissals,
} from '../attention-dismissals.js'

async function insertTestUser(): Promise<string> {
  const email = `${randomBytes(8).toString('hex')}@example.com`
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [email],
  )
  return rows[0].id
}

async function insertTestAccount(userId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address) VALUES ($1, $2) RETURNING id`,
    // A distinct address per account: (user_id, account_address, chain_id)
    // is UNIQUE, so two fixture accounts of one user cannot share an address.
    [userId, `0x${randomUUID().replaceAll('-', '').padEnd(40, '0')}`],
  )
  return rows[0].id
}

async function insertTestAgent(userId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, api_key_hash, delegate_address)
     VALUES ($1, 'budgetless-agent', 'hash', $2)
     RETURNING id`,
    // A distinct delegate per agent: unique per user among non-revoked agents.
    [userId, `0x${randomUUID().replaceAll('-', '').padEnd(40, 'd')}`],
  )
  return rows[0].id
}

describeDb('attention-dismissals repository (#3813)', () => {
  beforeEach(async () => {
    await initDbHarness()
    await resetDb()
  })

  it('stores a backup dismissal per account and reads it back', async () => {
    const userId = await insertTestUser()
    const accountId = await insertTestAccount(userId)

    const row = await dismissBackupSigner(userId, accountId)
    expect(row).not.toBeNull()
    expect(row?.item_kind).toBe('no-backup')
    expect(row?.account_id).toBe(accountId)
    expect(row?.agent_id).toBeNull()

    const listed = await listAttentionDismissals(userId)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ item_kind: 'no-backup', account_id: accountId })
  })

  it('a dismissal on one account does not touch another account of the same user', async () => {
    const userId = await insertTestUser()
    const accountA = await insertTestAccount(userId)
    const accountB = await insertTestAccount(userId)

    await dismissBackupSigner(userId, accountA)

    const listed = await listAttentionDismissals(userId)
    expect(listed).toHaveLength(1)
    expect(listed[0].account_id).toBe(accountA)
    // Account B is absent — it still raises its own backup item, because
    // the dismissal belongs to the account it was made on.
    expect(listed.some((row) => row.account_id === accountB)).toBe(false)
  })

  it('a dismissal is invisible to another user — per user, not global', async () => {
    const userA = await insertTestUser()
    const userB = await insertTestUser()
    const accountA = await insertTestAccount(userA)

    await dismissBackupSigner(userA, accountA)

    expect(await listAttentionDismissals(userB)).toEqual([])
    expect(await listAttentionDismissals(userA)).toHaveLength(1)
  })

  it('a re-dismiss is idempotent — the stored row, never a duplicate', async () => {
    const userId = await insertTestUser()
    const accountId = await insertTestAccount(userId)

    const first = await dismissBackupSigner(userId, accountId)
    const second = await dismissBackupSigner(userId, accountId)

    expect(first?.id).toBe(second?.id)
    expect(await listAttentionDismissals(userId)).toHaveLength(1)
  })

  it('stores a needs-setup dismissal per agent, coexisting with backup rows', async () => {
    const userId = await insertTestUser()
    const accountId = await insertTestAccount(userId)
    const agentId = await insertTestAgent(userId)

    const row = await dismissNeedsSetup(userId, agentId)
    expect(row).not.toBeNull()
    expect(row?.item_kind).toBe('needs-setup')
    expect(row?.agent_id).toBe(agentId)
    expect(row?.account_id).toBeNull()

    await dismissBackupSigner(userId, accountId)

    const listed = await listAttentionDismissals(userId)
    expect(listed).toHaveLength(2)
    expect(listed.filter((r) => r.item_kind === 'needs-setup')).toHaveLength(1)
    expect(listed.filter((r) => r.item_kind === 'no-backup')).toHaveLength(1)

    // Idempotent for agents too.
    const again = await dismissNeedsSetup(userId, agentId)
    expect(again?.id).toBe(row?.id)
    expect(await listAttentionDismissals(userId)).toHaveLength(2)
  })

  it('a foreign or unknown account/agent writes nothing and answers null', async () => {
    const owner = await insertTestUser()
    const outsider = await insertTestUser()
    const foreignAccount = await insertTestAccount(owner)
    const foreignAgent = await insertTestAgent(owner)

    expect(await dismissBackupSigner(outsider, foreignAccount)).toBeNull()
    expect(await dismissNeedsSetup(outsider, foreignAgent)).toBeNull()
    expect(await dismissBackupSigner(outsider, '00000000-0000-0000-0000-000000000000')).toBeNull()
    expect(await dismissNeedsSetup(outsider, '00000000-0000-0000-0000-000000000000')).toBeNull()

    expect(await listAttentionDismissals(outsider)).toEqual([])
    expect(await listAttentionDismissals(owner)).toEqual([])
  })

  // ── #4324: acknowledgements ──────────────────────────────────────────────

  it('#4324: an agent acknowledgement upserts — one row, acknowledged_at moved forward, never a duplicate', async () => {
    const userId = await insertTestUser()
    const agentId = await insertTestAgent(userId)

    const first = await acknowledgeAgentItem(userId, 'budget-reached', agentId, null)
    expect(first).toMatchObject({ item_kind: 'budget-reached', agent_id: agentId, account_id: null, acknowledged_period_end: null })
    // Age the stored acknowledgement so the second write is measurably later.
    await db.query(`UPDATE attention_dismissals SET acknowledged_at = acknowledged_at - INTERVAL '1 hour' WHERE id = $1`, [first?.id])

    const second = await acknowledgeAgentItem(userId, 'budget-reached', agentId, null)
    expect(second?.id).toBe(first?.id)
    const listed = await listAttentionDismissals(userId)
    expect(listed).toHaveLength(1)
    // The aged hour is gone: the second acknowledgement stamped now.
    expect(Date.now() - new Date(listed[0].acknowledged_at).getTime()).toBeLessThan(60_000)
  })

  it('#4324: each per-agent kind is its own row; budget-usage stores and moves its period end', async () => {
    const userId = await insertTestUser()
    const agentId = await insertTestAgent(userId)

    await acknowledgeAgentItem(userId, 'budget-reached', agentId, null)
    await acknowledgeAgentItem(userId, 'budget-scope', agentId, null)
    await acknowledgeAgentItem(userId, 'payments-failed', agentId, null)
    const usage = await acknowledgeAgentItem(userId, 'budget-usage', agentId, '2026-11-01T00:00:00.000Z')
    expect(new Date(usage!.acknowledged_period_end as string).toISOString()).toBe('2026-11-01T00:00:00.000Z')
    const moved = await acknowledgeAgentItem(userId, 'budget-usage', agentId, '2026-12-01T00:00:00.000Z')
    expect(moved?.id).toBe(usage?.id)
    expect(new Date(moved!.acknowledged_period_end as string).toISOString()).toBe('2026-12-01T00:00:00.000Z')

    const kinds = (await listAttentionDismissals(userId)).map((row) => row.item_kind).sort()
    expect(kinds).toEqual(['budget-reached', 'budget-scope', 'budget-usage', 'payments-failed'])
  })

  it('#4324: an agent acknowledgement never touches the agent\'s permanent needs-setup dismissal', async () => {
    const userId = await insertTestUser()
    const agentId = await insertTestAgent(userId)
    const setup = await dismissNeedsSetup(userId, agentId)
    await acknowledgeAgentItem(userId, 'budget-reached', agentId, null)
    const listed = await listAttentionDismissals(userId)
    expect(listed).toHaveLength(2)
    expect(listed.find((row) => row.item_kind === 'needs-setup')?.id).toBe(setup?.id)
  })

  it('#4324: user-level acknowledgements upsert per (user, kind) and stay per user', async () => {
    const userA = await insertTestUser()
    const userB = await insertTestUser()
    const agentId = await insertTestAgent(userA)

    const paused = await acknowledgeUserItem(userA, 'haven-paused')
    const again = await acknowledgeUserItem(userA, 'haven-paused')
    expect(again.id).toBe(paused.id)
    const unattributed = await acknowledgeUserItem(userA, 'payments-failed')
    expect(unattributed).toMatchObject({ item_kind: 'payments-failed', agent_id: null, account_id: null })
    // The agent-attributed payments-failed is a separate row from the unattributed one.
    const attributed = await acknowledgeAgentItem(userA, 'payments-failed', agentId, null)
    expect(attributed?.id).not.toBe(unattributed.id)

    expect(await listAttentionDismissals(userA)).toHaveLength(3)
    expect(await listAttentionDismissals(userB)).toEqual([])
  })

  for (const kind of ['haven-paused', 'payments-failed'] as const) {
    it(`#4324: re-acknowledging the user-level ${kind} item moves acknowledged_at forward`, async () => {
      const userId = await insertTestUser()
      const first = await acknowledgeUserItem(userId, kind)
      // Age the stored acknowledgement so the second write is measurably later.
      await db.query(`UPDATE attention_dismissals SET acknowledged_at = acknowledged_at - INTERVAL '1 hour' WHERE id = $1`, [first.id])

      const second = await acknowledgeUserItem(userId, kind)
      expect(second.id).toBe(first.id)
      // The aged hour is gone: the second acknowledgement stamped now.
      expect(Date.now() - new Date(second.acknowledged_at).getTime()).toBeLessThan(60_000)
      const listed = await listAttentionDismissals(userId)
      expect(listed).toHaveLength(1)
      expect(Date.now() - new Date(listed[0].acknowledged_at).getTime()).toBeLessThan(60_000)
    })
  }

  it('#4324: an acknowledgement for a foreign or unknown agent writes nothing and answers null', async () => {
    const owner = await insertTestUser()
    const outsider = await insertTestUser()
    const foreignAgent = await insertTestAgent(owner)
    expect(await acknowledgeAgentItem(outsider, 'budget-reached', foreignAgent, null)).toBeNull()
    expect(await acknowledgeAgentItem(outsider, 'budget-usage', foreignAgent, '2026-11-01T00:00:00.000Z')).toBeNull()
    expect(await acknowledgeAgentItem(outsider, 'budget-scope', '00000000-0000-0000-0000-000000000000', null)).toBeNull()
    expect(await listAttentionDismissals(outsider)).toEqual([])
    expect(await listAttentionDismissals(owner)).toEqual([])
  })

  it('#4324: the table refuses budget-usage without its period end even through the repository', async () => {
    const userId = await insertTestUser()
    const agentId = await insertTestAgent(userId)
    await expect(acknowledgeAgentItem(userId, 'budget-usage', agentId, null)).rejects.toMatchObject({ code: '23514' })
  })
})
