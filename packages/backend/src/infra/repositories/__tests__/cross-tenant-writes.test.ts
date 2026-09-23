/**
 * Cross-tenant writes are refused by the repository itself (#3227), not only by
 * the route's ownership pre-check in another file.
 *
 * Each case calls a repository write directly with an ATTACKER's `userId`
 * against a VICTIM's rows, on the real database, and asserts the owner's
 * decision for #3227: a silent no-op — the function returns its existing "not
 * found" value and changes no row, with no new error type. The
 * `renameAccountForUser` case is the control: its SQL was already user-scoped,
 * so it shows the harness can tell a scoped write from an unscoped one.
 *
 * At `fd7b1289` (before #3227) the control passed and the other three failed:
 * the delete returned `true` and removed the victim's account, the set-default
 * left the victim with two defaults, and the attacker's label landed on the
 * victim's agent.
 */
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import db from '../../../db.js'
import { assertWorkerSchemaAtHead, describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import { deleteAccountForUser, renameAccountForUser, setDefaultAccountForUser } from '../smart-accounts.js'
import { replaceAgentLabels } from '../agent-labels.js'

let seq = 0
async function seedUser(accountAddress: string | null = null): Promise<string> {
  seq += 1
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, account_address) VALUES ($1, 'x', $2) RETURNING id`,
    [`cross-tenant-${seq}-${Date.now()}@test.example`, accountAddress],
  )
  return rows[0].id
}

async function seedAccount(userId: string, byte: string, isDefault: boolean): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type, is_default, name)
     VALUES ($1, $2, 84532, 'delegation', 'delegator_hybrid', $3, 'orig') RETURNING id`,
    [userId, '0x' + byte.repeat(20), isDefault],
  )
  return rows[0].id
}

async function seedAgent(userId: string, accountId: string, byte: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, delegate_address, status, account_id)
     VALUES ($1, 'victim agent', $2, 'active', $3) RETURNING id`,
    [userId, '0x' + byte.repeat(20), accountId],
  )
  return rows[0].id
}

async function seedLabel(userId: string, name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO agent_labels (user_id, name, color) VALUES ($1, $2, 'blue') RETURNING id`,
    [userId, name],
  )
  return rows[0].id
}

async function defaultsOf(userId: string): Promise<Map<string, boolean>> {
  const { rows } = await db.query<{ id: string; is_default: boolean }>(
    `SELECT id, is_default FROM smart_accounts WHERE user_id = $1`,
    [userId],
  )
  return new Map(rows.map((r) => [r.id, r.is_default]))
}

async function mirrorOf(userId: string): Promise<string | null> {
  const { rows } = await db.query<{ account_address: string | null }>(
    `SELECT account_address FROM users WHERE id = $1`,
    [userId],
  )
  return rows[0].account_address
}

describeDb('cross-tenant repository writes are silent no-ops (#3227)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  afterEach(async () => {
    await resetDb()
  })
  afterAll(async () => {
    await assertWorkerSchemaAtHead()
  })

  it('CONTROL renameAccountForUser: an attacker cannot rename the victim account', async () => {
    const victim = await seedUser()
    const attacker = await seedUser()
    const account = await seedAccount(victim, 'a1', true)

    expect(await renameAccountForUser('pwned', account, attacker)).toBeNull()

    const { rows } = await db.query<{ name: string }>(`SELECT name FROM smart_accounts WHERE id = $1`, [account])
    expect(rows[0].name).toBe('orig')
  })

  it('deleteAccountForUser: an attacker gets false and neither deletes the account nor orphans its agents', async () => {
    const victim = await seedUser()
    const attacker = await seedUser()
    const account = await seedAccount(victim, 'b2', true)
    const agent = await seedAgent(victim, account, 'c3')

    expect(await deleteAccountForUser(account, attacker, false)).toBe(false)

    const accounts = await db.query(`SELECT id FROM smart_accounts WHERE id = $1`, [account])
    const agents = await db.query<{ account_id: string | null }>(`SELECT account_id FROM agents WHERE id = $1`, [agent])
    expect(accounts.rows).toHaveLength(1)
    expect(agents.rows[0].account_id).toBe(account)
  })

  it("deleteAccountForUser: the owner's own unlink still orphans, deletes and promotes", async () => {
    const owner = await seedUser('0x' + 'd1'.repeat(20))
    const gone = await seedAccount(owner, 'd1', true)
    const next = await seedAccount(owner, 'd2', false)
    const agent = await seedAgent(owner, gone, 'd3')

    expect(await deleteAccountForUser(gone, owner, true)).toBe(true)

    expect((await db.query(`SELECT id FROM smart_accounts WHERE id = $1`, [gone])).rows).toHaveLength(0)
    const agents = await db.query<{ account_id: string | null }>(`SELECT account_id FROM agents WHERE id = $1`, [agent])
    expect(agents.rows[0].account_id).toBeNull()
    expect((await defaultsOf(owner)).get(next)).toBe(true)
    expect(await mirrorOf(owner)).toBe('0x' + 'd2'.repeat(20))
  })

  it("setDefaultAccountForUser: an attacker changes neither the victim's defaults nor their own", async () => {
    const victim = await seedUser()
    const victimDefault = await seedAccount(victim, 'e4', true)
    const victimOther = await seedAccount(victim, 'e5', false)
    const attackerMirror = '0x' + 'f7'.repeat(20)
    const attacker = await seedUser(attackerMirror)
    const attackerDefault = await seedAccount(attacker, 'f7', true)

    await setDefaultAccountForUser(victimOther, '0x' + 'e5'.repeat(20), attacker)

    const victimDefaults = await defaultsOf(victim)
    expect(victimDefaults.get(victimDefault)).toBe(true)
    expect(victimDefaults.get(victimOther)).toBe(false)
    // The clear is conditional on ownership, and the mirror is skipped when
    // the set matched nothing: the attacker keeps their own default and mirror.
    expect((await defaultsOf(attacker)).get(attackerDefault)).toBe(true)
    expect(await mirrorOf(attacker)).toBe(attackerMirror)
  })

  it("setDefaultAccountForUser: the owner's own re-default still moves the default and the mirror", async () => {
    const owner = await seedUser('0x' + 'a7'.repeat(20))
    const first = await seedAccount(owner, 'a7', true)
    const second = await seedAccount(owner, 'a8', false)

    await setDefaultAccountForUser(second, '0x' + 'a8'.repeat(20), owner)

    const defaults = await defaultsOf(owner)
    expect(defaults.get(first)).toBe(false)
    expect(defaults.get(second)).toBe(true)
    expect(await mirrorOf(owner)).toBe('0x' + 'a8'.repeat(20))
  })

  it("replaceAgentLabels: an attacker can neither clear nor add labels on the victim's agent", async () => {
    const victim = await seedUser()
    const attacker = await seedUser()
    const account = await seedAccount(victim, 'b6', true)
    const agent = await seedAgent(victim, account, '17')
    const victimLabel = await seedLabel(victim, 'victim-label')
    await replaceAgentLabels(agent, victim, [victimLabel])
    const attackerLabel = await seedLabel(attacker, 'attacker-label')

    await replaceAgentLabels(agent, attacker, [attackerLabel])

    const { rows } = await db.query<{ name: string }>(
      `SELECT l.name FROM agent_label_assignments a JOIN agent_labels l ON l.id = a.label_id WHERE a.agent_id = $1`,
      [agent],
    )
    expect(rows.map((r) => r.name)).toEqual(['victim-label'])
  })
})
