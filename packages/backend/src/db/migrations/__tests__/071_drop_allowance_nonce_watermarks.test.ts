/**
 * Real-Postgres proof for the `allowance_nonce_watermarks` drop (migration
 * 071, #2084, epic #1440). No mocks — #1219's rule: assertions about what the
 * database does belong on the real-DB harness.
 *
 * `initDbHarness()` runs the FULL migration set, so 071 has already been
 * applied when a test body starts and the table is already gone. That makes
 * the post-migration state — the state production will be in — the thing under
 * test, rather than a hand-driven `up()`. A test that needs the table back
 * calls `down()` first, which doubles as the reversibility proof.
 *
 * The load-bearing test here is the LAST one. Every other drop in this epic
 * had to argue about collateral damage; this one's whole claim is that there
 * is none, and the way that claim fails in practice is a `grep` that conflates
 * the dropped TABLE with the live `payment_intents.allowance_nonce` COLUMN.
 * So the column is pinned by execution.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { up, down, version } from '../071_drop_allowance_nonce_watermarks.js'

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>(
    `SELECT to_regclass(current_schema() || '.' || $1) IS NOT NULL AS exists`,
    [name],
  )
  return rows[0].exists
}

async function columnNames(table: string): Promise<string[]> {
  const { rows } = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1
     ORDER BY column_name`,
    [table],
  )
  return rows.map((r) => r.column_name)
}

describeDb('migration 071: drop allowance_nonce_watermarks (#2084)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('the table is gone once the migration set has run', async () => {
    expect(await tableExists('allowance_nonce_watermarks')).toBe(false)
  })

  it('up() is idempotent — re-running against an already-dropped table does not error', async () => {
    await up(db as never)
    await up(db as never)
    expect(await tableExists('allowance_nonce_watermarks')).toBe(false)
  })

  // ── Reversibility. ───────────────────────────────────────────────────────

  it("down() restores 055's exact shape, and up() drops it again", async () => {
    await down(db as never)

    expect(await tableExists('allowance_nonce_watermarks')).toBe(true)
    expect(await columnNames('allowance_nonce_watermarks')).toEqual([
      'chain_id',
      'delegate_address',
      'nonce',
      'safe_address',
      'token_address',
      'updated_at',
    ])

    // The FOUR-column primary key 055 created, not merely "a primary key" —
    // the address triple plus the chain. A restore that narrowed this would
    // collapse distinct watermarks onto one row.
    const { rows: pk } = await db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE schemaname = current_schema() AND tablename = 'allowance_nonce_watermarks'
         AND indexname = 'allowance_nonce_watermarks_pkey'`,
    )
    expect(pk).toHaveLength(1)
    expect(pk[0].indexdef).toMatch(
      /\(chain_id,\s*safe_address,\s*delegate_address,\s*token_address\)/,
    )

    // And the restored shape accepts the row it was designed for, then
    // refuses a second one on the same key — the upsert target 055 relied on.
    const row = ['84532', '0xaa', '0xbb', '0xcc']
    await db.query(
      `INSERT INTO allowance_nonce_watermarks
         (chain_id, safe_address, delegate_address, token_address, nonce)
       VALUES ($1, $2, $3, $4, 7)`,
      row,
    )
    await expect(
      db.query(
        `INSERT INTO allowance_nonce_watermarks
           (chain_id, safe_address, delegate_address, token_address, nonce)
         VALUES ($1, $2, $3, $4, 8)`,
        row,
      ),
    ).rejects.toThrow(/duplicate key/i)

    await up(db as never)
    expect(await tableExists('allowance_nonce_watermarks')).toBe(false)
  })

  it('the drop needs no CASCADE — nothing references the table in either direction', async () => {
    await down(db as never)

    // 055 states it is "Deliberately NOT foreign-keyed", which is why the
    // 069/070 evidence-cascade hazard cannot arise here. Asserted against the
    // catalogue rather than by reading the header: no constraint points AT the
    // table, and none points OUT of it.
    const { rows } = await db.query<{ conname: string }>(
      `SELECT c.conname FROM pg_constraint c
       WHERE c.contype = 'f'
         AND ( c.conrelid  = 'allowance_nonce_watermarks'::regclass
            OR c.confrelid = 'allowance_nonce_watermarks'::regclass )`,
    )
    expect(rows).toEqual([])

    // So a plain DROP — no CASCADE, which would mask a dependency rather than
    // prove its absence — succeeds.
    await db.query('DROP TABLE allowance_nonce_watermarks')
    expect(await tableExists('allowance_nonce_watermarks')).toBe(false)
  })

  // ── The KEEP half. A deletion slice is judged by what it kept. ────────────

  it('KEEPS payment_intents.allowance_nonce — the live COLUMN a bare grep conflates with the table', async () => {
    await up(db as never)

    // Not `information_schema` alone: the column is proven usable by writing
    // and reading a real intent through it. This is the whole residual risk of
    // #2084 — a name-based sweep that took the column with the table would
    // break every payment on every rail, and would do it silently until an
    // intent was created.
    expect(await columnNames('payment_intents')).toContain('allowance_nonce')

    const user = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`anw-${Date.now()}@test.example`],
    )
    const userId = user.rows[0].id
    const agent = await db.query<{ id: string }>(
      `INSERT INTO agents (user_id, name) VALUES ($1, 'anw agent') RETURNING id`,
      [userId],
    )
    const intent = await db.query<{ allowance_nonce: number }>(
      `INSERT INTO payment_intents
         (agent_id, user_id, safe_address, token_symbol, token_address, to_address,
          amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
          status, expires_at)
       VALUES ($1, $2, '0x00000000000000000000000000000000000000f1', 'USDC',
               '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
               '0x00000000000000000000000000000000000000c1',
               '100000', '0.10', '0x00000000000000000000000000000000000000d1',
               42, '0xsign', 'pending_signature', NOW() + interval '10 minutes')
       RETURNING allowance_nonce`,
      [agent.rows[0].id, userId],
    )
    expect(intent.rows[0].allowance_nonce).toBe(42)
  })
})

describe('migration 071 registration', () => {
  it('exports up, down and a version matching its filename', () => {
    expect(typeof up).toBe('function')
    expect(typeof down).toBe('function')
    expect(version).toBe('071_drop_allowance_nonce_watermarks')
  })
})
