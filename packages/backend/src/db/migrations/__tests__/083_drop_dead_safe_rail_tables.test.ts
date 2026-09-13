/**
 * Real-Postgres proof for migration 083 (#2851, epic #1440's final slice).
 * No mocks — #1219's rule.
 *
 * The harness applies the FULL migration set, so by the time a test body runs
 * the three dead tables are already gone and `user_safes.account_type`
 * already defaults to `'delegator_hybrid'`; that post-migration state is what
 * production will be in. Tests that need the pre-drop shape back call
 * `down()` first, which doubles as the structural-reversibility proof.
 *
 * The load-bearing test is the DEFAULT one, same shape as 075's: an insert
 * that omits BOTH `execution_rail` and `account_type` is what a future
 * caller writes by accident, and before this migration that insert landed a
 * self-contradictory row (`execution_rail='delegation'`,
 * `account_type='safe'`). The three drops are inert by construction —
 * nothing reads them, so nothing can regress — proven by the absence checks.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { assertWorkerSchemaAtHead, describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { up, down, version } from '../083_drop_dead_safe_rail_tables.js'

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
    [`drop083-${seq++}-${Date.now()}-${Math.random()}@test.example`],
  )
  return user.rows[0].id
}

describeDb('migration 083: drop the last dead Safe-rail tables (#2851)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  // #2616: this file hand-drives up()/down(), which mutates SCHEMA — and
  // nothing else in the harness undoes that. Fail HERE if the schema is left
  // off head, rather than letting the next file on this worker inherit it as
  // an unexplained table-existence failure.
  afterAll(assertWorkerSchemaAtHead)

  afterAll(async () => {
    // Leave the shared worker schema in the migrated (post-083) state,
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
    expect(version).toBe('083_drop_dead_safe_rail_tables')
  })

  // ── The three dead tables ───────────────────────────────────────────────

  it.each(['self_sign_agents', 'self_sign_payment_intents', 'owner_aliases'])(
    '%s is absent after the migration set runs',
    async (table) => {
      expect(await tableExists(table)).toBe(false)
    },
  )

  it('up() is idempotent — a second run over the already-dropped schema does not throw', async () => {
    const client = await db.connect()
    try {
      await up(client)
    } finally {
      client.release()
    }
    for (const table of ['self_sign_agents', 'self_sign_payment_intents', 'owner_aliases']) {
      expect(await tableExists(table)).toBe(false)
    }
  })

  it('down() restores every dropped table (structural reversibility)', async () => {
    const client = await db.connect()
    try {
      await down(client)
      for (const table of ['self_sign_agents', 'self_sign_payment_intents', 'owner_aliases']) {
        expect(await tableExists(table)).toBe(true)
      }

      // Restored shapes are usable, not just present, and the child/parent FK
      // (self_sign_payment_intents.agent_id -> self_sign_agents(id)) works.
      const userId = await seedUser()
      const agent = await db.query<{ id: string }>(
        `INSERT INTO self_sign_agents (user_id, name, delegate_address)
         VALUES ($1, 'drop083', '0x0000000000000000000000000000000000000083')
         RETURNING id`,
        [userId],
      )
      await db.query(
        `INSERT INTO self_sign_payment_intents
           (agent_id, user_id, safe_address, chain_id, token_symbol, token_address, to_address, amount_raw, amount_human, delegate_address, expires_at)
         VALUES ($1, $2, '0x0000000000000000000000000000000000000abc', 84532, 'USDC',
                 '0x0000000000000000000000000000000000000001',
                 '0x0000000000000000000000000000000000000002', '1', '1',
                 '0x0000000000000000000000000000000000000083', NOW() + interval '1 hour')`,
        [agent.rows[0].id, userId],
      )
      await db.query(
        `INSERT INTO owner_aliases (user_id, owner_address, name)
         VALUES ($1, '0x0000000000000000000000000000000000000004', 'alias')`,
        [userId],
      )
    } finally {
      await up(client)
      client.release()
    }
  })

  // ── The account_type default fix ────────────────────────────────────────

  it("the column default is 'delegator_hybrid', not the retired 'safe'", async () => {
    const value = await columnDefault('user_safes', 'account_type')
    expect(value).toBe("'delegator_hybrid'::character varying")
  })

  it('an insert that omits BOTH execution_rail and account_type is self-consistent on the live rail', async () => {
    const userId = await seedUser()
    const { rows } = await db.query<{ execution_rail: string; account_type: string }>(
      `INSERT INTO user_safes (user_id, safe_address, chain_id)
       VALUES ($1, '0x0000000000000000000000000000000000000083', 84532)
       RETURNING execution_rail, account_type`,
      [userId],
    )
    expect(rows[0].execution_rail).toBe('delegation')
    expect(rows[0].account_type).toBe('delegator_hybrid')
  })

  it("down() restores the 'safe' default, proving the default test above is load-bearing", async () => {
    const client = await db.connect()
    try {
      await down(client)
      const userId = await seedUser()
      const { rows } = await db.query<{ account_type: string }>(
        `INSERT INTO user_safes (user_id, safe_address, chain_id)
         VALUES ($1, '0x0000000000000000000000000000000000000085', 84532)
         RETURNING account_type`,
        [userId],
      )
      expect(rows[0].account_type).toBe('safe')
    } finally {
      await up(client)
      client.release()
    }
  })

  // ── What must NOT be touched (the recorded keeps) ───────────────────────

  it('keeps user_safes, user_passkeys and payment_intents.allowance_nonce', async () => {
    expect(await tableExists('user_safes')).toBe(true)
    expect(await tableExists('user_passkeys')).toBe(true)
    expect(await columnExists('payment_intents', 'allowance_nonce')).toBe(true)
  })

  it('does not rewrite an existing user_safes row (default-only change)', async () => {
    const userId = await seedUser()
    const safe = await db.query<{ id: string }>(
      `INSERT INTO user_safes (user_id, safe_address, chain_id, account_type)
       VALUES ($1, '0x0000000000000000000000000000000000000086', 84532, 'safe')
       RETURNING id`,
      [userId],
    )

    const client = await db.connect()
    try {
      await up(client) // re-run over a schema that already carries a legacy row
    } finally {
      client.release()
    }

    const { rows } = await db.query<{ account_type: string }>(
      `SELECT account_type FROM user_safes WHERE id = $1`,
      [safe.rows[0].id],
    )
    expect(rows[0].account_type).toBe('safe')
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
