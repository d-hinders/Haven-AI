/**
 * Real-Postgres proof for migration 075 (#2263, epic #1440). No mocks —
 * #1219's rule.
 *
 * The harness applies the FULL migration set, so by the time a test body runs
 * the five inert objects are already gone and the `execution_rail` default
 * already points at `'delegation'`; that post-migration state is what
 * production will be in. Tests that need the pre-drop shape back call `down()`
 * first, which doubles as the structural-reversibility proof.
 *
 * The load-bearing test is the DEFAULT one. The five drops are inert by
 * construction — nothing reads them, so nothing can regress — but the default
 * is the live hazard the issue was filed for: an insert that omits
 * `execution_rail` is what a future caller writes by accident, and before this
 * migration that insert silently landed a brand-new account on the retired
 * AllowanceModule rail, which fail-closes at payment time (#1986). The test
 * writes exactly that omitting insert and asks what the row came out as.
 *
 * The no-rewrite test is its pair: repointing a DEFAULT must not touch
 * existing rows. A legacy account must keep resolving to its own tombstone,
 * because silently promoting retired accounts onto the live rail is the
 * opposite of fail-closed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { up, down, version } from '../075_drop_inert_safe_rail_schema.js'

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>(
    `SELECT to_regclass(current_schema() || '.' || $1) IS NOT NULL AS exists`,
    [name],
  )
  return rows[0].exists
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2
     ) AS exists`,
    [table, column],
  )
  return rows[0].exists
}

async function columnDefault(table: string, column: string): Promise<string | null> {
  const { rows } = await db.query<{ column_default: string | null }>(
    `SELECT column_default FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
    [table, column],
  )
  return rows[0]?.column_default ?? null
}

let seq = 0
async function seedUser(): Promise<string> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`drop075-${seq++}-${Date.now()}-${Math.random()}@test.example`],
  )
  return user.rows[0].id
}

const DROPPED_TABLES = ['agent_allowances', 'self_sign_agent_allowances'] as const
const DROPPED_COLUMNS = [
  ['agents', 'session_permission_id'],
  ['payment_intents', 'session_user_op'],
  ['payment_intents', 'session_permission_id'],
] as const

describeDb('migration 075: drop the inert Safe-rail schema (#2263)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  afterAll(async () => {
    // Leave the shared worker schema in the migrated (post-075) state,
    // whatever an individual test did — the #2020 leak lesson.
    const client = await db.connect()
    try {
      await up(client)
    } finally {
      client.release()
    }
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('is registered under its own version string', () => {
    expect(version).toBe('075_drop_inert_safe_rail_schema')
  })

  // ── The hazard this migration exists for ───────────────────────────────────

  it('an insert that OMITS execution_rail lands on the live delegation rail', async () => {
    const userId = await seedUser()
    const { rows } = await db.query<{ execution_rail: string }>(
      `INSERT INTO user_safes (user_id, safe_address, chain_id, account_type)
       VALUES ($1, '0x0000000000000000000000000000000000000075', 84532, 'delegator_hybrid')
       RETURNING execution_rail`,
      [userId],
    )
    expect(rows[0].execution_rail).toBe('delegation')
  })

  it('the column default itself is delegation, not just this one row', async () => {
    expect(await columnDefault('user_safes', 'execution_rail')).toContain('delegation')
  })

  // The mutation this pins: revert `up()`'s ALTER … SET DEFAULT and the two
  // tests above go red, because 036's `'allowance_module'` default comes back.
  it('down() restores the old default, proving the tests above are load-bearing', async () => {
    const client = await db.connect()
    try {
      await down(client)
      const userId = await seedUser()
      const { rows } = await db.query<{ execution_rail: string }>(
        `INSERT INTO user_safes (user_id, safe_address, chain_id, account_type)
         VALUES ($1, '0x0000000000000000000000000000000000000076', 84532, 'delegator_hybrid')
         RETURNING execution_rail`,
        [userId],
      )
      expect(rows[0].execution_rail).toBe('allowance_module')
    } finally {
      await up(client)
      client.release()
    }
  })

  it('does NOT rewrite an existing row — a legacy account keeps its retired rail', async () => {
    const userId = await seedUser()
    const safe = await db.query<{ id: string }>(
      `INSERT INTO user_safes (user_id, safe_address, chain_id, execution_rail)
       VALUES ($1, '0x0000000000000000000000000000000000000077', 84532, 'allowance_module')
       RETURNING id`,
      [userId],
    )

    const client = await db.connect()
    try {
      await up(client) // re-run over a schema that already carries a legacy row
    } finally {
      client.release()
    }

    const { rows } = await db.query<{ execution_rail: string }>(
      `SELECT execution_rail FROM user_safes WHERE id = $1`,
      [safe.rows[0].id],
    )
    expect(rows[0].execution_rail).toBe('allowance_module')
  })

  // ── The five inert drops ───────────────────────────────────────────────────

  it.each(DROPPED_TABLES)('%s is gone after the migration set runs', async (table) => {
    expect(await tableExists(table)).toBe(false)
  })

  it.each(DROPPED_COLUMNS)('%s.%s is gone after the migration set runs', async (table, column) => {
    expect(await columnExists(table, column)).toBe(false)
  })

  it('up() is idempotent — a second run over the dropped schema does not throw', async () => {
    const client = await db.connect()
    try {
      await up(client)
    } finally {
      client.release()
    }
    for (const table of DROPPED_TABLES) expect(await tableExists(table)).toBe(false)
    for (const [t, c] of DROPPED_COLUMNS) expect(await columnExists(t, c)).toBe(false)
  })

  it('down() restores every dropped object (structural reversibility)', async () => {
    const client = await db.connect()
    try {
      await down(client)
      for (const table of DROPPED_TABLES) expect(await tableExists(table)).toBe(true)
      for (const [t, c] of DROPPED_COLUMNS) expect(await columnExists(t, c)).toBe(true)

      // The restored shapes are usable, not just present — a `CREATE TABLE`
      // that named the wrong columns would still satisfy `tableExists`.
      const userId = await seedUser()
      const agent = await db.query<{ id: string }>(
        `INSERT INTO agents (user_id, name) VALUES ($1, 'drop075') RETURNING id`,
        [userId],
      )
      await db.query(
        `INSERT INTO agent_allowances (agent_id, token_address, token_symbol, allowance_amount)
         VALUES ($1, '0x0000000000000000000000000000000000000001', 'USDC', '1')`,
        [agent.rows[0].id],
      )
    } finally {
      await up(client)
      client.release()
    }
  })

  // ── What must NOT be dropped ───────────────────────────────────────────────

  it('spares self_sign_agents — the live sibling of the dropped allowance table', async () => {
    expect(await tableExists('self_sign_agents')).toBe(true)
  })

  it('keeps payment_intents.allowance_nonce — the #2263 decision, not an oversight', async () => {
    // DECIDED in #2263: kept for wire compatibility, because it is still
    // published as `sign_data.components.nonce` by `routes/payments.ts`.
    // Dropping it is a money-path RESPONSE-shape change, separable from this
    // migration's purely inert drops. This assertion is what makes the
    // decision fail loudly if someone later drops the column without also
    // reshaping that block.
    expect(await columnExists('payment_intents', 'allowance_nonce')).toBe(true)
  })

  it('keeps the columns the delegation rail actually uses', async () => {
    expect(await columnExists('payment_intents', 'prepared_user_op')).toBe(true)
    expect(await columnExists('payment_intents', 'execution_rail')).toBe(true)
    expect(await columnExists('payment_intents', 'delegation_hash')).toBe(true)
    expect(await columnExists('user_safes', 'execution_rail')).toBe(true)
  })

  it('deletes no evidence rows — machine_payment_evidence is untouched', async () => {
    const before = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM machine_payment_evidence`,
    )
    const client = await db.connect()
    try {
      await up(client)
    } finally {
      client.release()
    }
    const after = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM machine_payment_evidence`,
    )
    expect(after.rows[0].n).toBe(before.rows[0].n)
  })
})
