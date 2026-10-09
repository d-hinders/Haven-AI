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
     VALUES ($1, 'budgetless-agent', 'hash', '0x${'d'.repeat(40)}')
     RETURNING id`,
    [userId],
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
})
