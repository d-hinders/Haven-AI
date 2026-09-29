/**
 * Real-Postgres proof for migration 102 — per-agent x402 tax declaration
 * opt-in (#3426). No mocks — #1219's rule.
 *
 * Pins: the column exists on `agents` with DEFAULT false, `down()` drops
 * exactly what `up()` created, `up()` is idempotent, and the default is OFF
 * for EXISTING agents (a row that predates the column) and for NEW agents
 * (an insert that never mentions the column).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../../db.js'
import {
  assertWorkerSchemaAtHead,
  describeDb,
  initDbHarness,
  resetDb,
} from '../../../infra/__tests__/helpers/db-harness.js'
import { down, up, version } from '../102_agent_tax_declaration_opt_in.js'

async function runUp(): Promise<void> {
  const client = await db.connect()
  try {
    await up(client)
  } finally {
    client.release()
  }
}

async function runDown(): Promise<void> {
  const client = await db.connect()
  try {
    await down(client)
  } finally {
    client.release()
  }
}

let seq = 0

async function seedUser(): Promise<string> {
  seq += 1
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`tax-mig-${seq}-${Date.now()}@test.example`],
  )
  return rows[0].id
}

/** A live-rail account (the only shape the dashboard lists, #2413). */
async function seedAccount(userId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, account_type)
     VALUES ($1, $2, 8453, 'delegator_hybrid')
     RETURNING id`,
    [userId, `0x${'b'.repeat(36)}${String(seq).padStart(4, '0')}`],
  )
  return rows[0].id
}

/** A minimal agent; `api_key_hash`/`api_key_prefix` NOT NULL since the rotation work. */
async function seedAgent(userId: string, accountId: string, name = 'Tax agent'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, api_key_hash, api_key_prefix, account_id)
     VALUES ($1, $2, $3, 'sk_agent_', $4)
     RETURNING id`,
    [userId, name, `hash-${name}-${seq}-${Date.now()}`, accountId],
  )
  return rows[0].id
}

async function columnDefault(): Promise<string | null> {
  const { rows } = await db.query<{ column_default: string | null }>(
    `SELECT column_default FROM information_schema.columns
     WHERE table_name = 'agents' AND column_name = 'tax_declaration_enabled'
       AND table_schema = current_schema()`,
  )
  return rows[0]?.column_default ?? null
}

async function columnExists(): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT count(*) AS count FROM information_schema.columns
     WHERE table_name = 'agents' AND column_name = 'tax_declaration_enabled'
       AND table_schema = current_schema()`,
  )
  return Number(rows[0].count)
}

describeDb('migration 102_agent_tax_declaration_opt_in', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
  })
  afterAll(async () => {
    await assertWorkerSchemaAtHead()
  })

  it('declares the migration version', () => {
    expect(version).toBe('102_agent_tax_declaration_opt_in')
  })

  it('defaults the column OFF for EXISTING agents (a row that predates the column)', async () => {
    const userId = await seedUser()
    const accountId = await seedAccount(userId)
    const agentId = await seedAgent(userId, accountId)

    // Drop and re-apply so the seeded row genuinely predates the column.
    await runDown()
    expect(await columnExists()).toBe(0)
    await runUp()

    const { rows } = await db.query<{ tax_declaration_enabled: boolean }>(
      `SELECT tax_declaration_enabled FROM agents WHERE id = $1`,
      [agentId],
    )
    expect(rows[0].tax_declaration_enabled).toBe(false)
  })

  it('defaults the column OFF for NEW agents that never mention it', async () => {
    const userId = await seedUser()
    const accountId = await seedAccount(userId)
    await seedAgent(userId, accountId)
    const { rows } = await db.query<{ tax_declaration_enabled: boolean }>(
      `INSERT INTO agents (user_id, name, api_key_hash, api_key_prefix, account_id)
       VALUES ($1, 'Fresh agent', 'hash-fresh', 'sk_agent_', $2)
       RETURNING tax_declaration_enabled`,
      [userId, accountId],
    )
    expect(rows[0].tax_declaration_enabled).toBe(false)
    expect(await columnDefault()).toContain('false')
  })

  it('up() is idempotent', async () => {
    await runUp()
    await runUp()
    const userId = await seedUser()
    const accountId = await seedAccount(userId)
    const agentId = await seedAgent(userId, accountId)
    const { rows } = await db.query<{ tax_declaration_enabled: boolean }>(
      `SELECT tax_declaration_enabled FROM agents WHERE id = $1`,
      [agentId],
    )
    expect(rows[0].tax_declaration_enabled).toBe(false)
  })

  it('down() drops exactly the column; up() recreates it with the false default', async () => {
    await runDown()
    expect(await columnExists()).toBe(0)
    await runUp()
    expect(await columnExists()).toBe(1)
    expect(await columnDefault()).toContain('false')
  })

  it('deleting the owner cascades the agent row with its opt-in bit (no residue)', async () => {
    const userId = await seedUser()
    const accountId = await seedAccount(userId)
    await seedAgent(userId, accountId)
    await db.query(`DELETE FROM users WHERE id = $1`, [userId])
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*) AS count FROM agents WHERE user_id = $1`,
      [userId],
    )
    expect(rows[0].count).toBe('0')
  })
})
