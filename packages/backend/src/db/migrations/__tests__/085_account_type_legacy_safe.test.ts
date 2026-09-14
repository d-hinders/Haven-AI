/**
 * Real-Postgres proof for migration 085 (#2912, epic #2906 phase 3b — the
 * `account_type` VALUE rename). No mocks — #1219's rule.
 *
 * The harness applies the FULL migration set, so by the time a test body runs
 * the CHECK already reads `account_type IN ('legacy_safe','delegator_hybrid')`
 * and no row carries `'safe'` — that post-migration state is what production
 * will be in. Tests that need the pre-rename shape back call `down()` first
 * (or wrap with `withMigrationReverted`), which doubles as the structural-
 * reversibility proof, same convention as every migration test in this
 * directory.
 *
 * The runner's `Migration.up` is typed `(client: PoolClient) => Promise<void>`
 * (`db/migrations/index.ts:132`) and the boot runner discards whatever `up()`
 * returns, so this migration's `up()` keeps that exact signature rather than
 * widen a shared type for one file's test. The UPDATE's row count is instead
 * proven by a post-count: seed a known N of `'safe'` rows and M of
 * `'delegator_hybrid'` rows, call `up()`, and assert the counts moved exactly
 * as expected (`0` remaining `'safe'`, `N` now `'legacy_safe'`, the M
 * `'delegator_hybrid'` rows byte-for-byte untouched by id).
 *
 * MUTATION TARGET (run by hand for the #2912 report):
 *  - comment out the `UPDATE … SET account_type = 'legacy_safe' …` statement
 *    in `up()` → "the UPDATE renames exactly the seeded 'safe' rows" fails
 *    (post-count of `'legacy_safe'` stays 0, `'safe'` stays N).
 *  - keep the OLD CHECK (`IN ('safe','delegator_hybrid')`) instead of
 *    tightening it → "the CHECK rejects 'safe' after up()" fails (the insert
 *    that expects a 23514 rejection succeeds instead).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../../db.js'
import { assertWorkerSchemaAtHead, describeDb, initDbHarness, resetDb, withMigrationReverted } from '../../../infra/__tests__/helpers/db-harness.js'
import { up, down, version } from '../085_account_type_legacy_safe.js'
import { listAccountsWithTypeForUser } from '../../../infra/repositories/smart-accounts.js'

async function columnDefault(table: string, column: string): Promise<string | null> {
  const { rows } = await db.query<{ column_default: string | null }>(
    `SELECT column_default FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
    [table, column],
  )
  return rows[0]?.column_default ?? null
}

async function constraintExists(table: string, conname: string): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_constraint c
       WHERE c.conname = $2 AND c.conrelid = (current_schema() || '.' || $1)::regclass
     ) AS exists`,
    [table, conname],
  )
  return rows[0].exists
}

async function constraintDef(table: string, conname: string): Promise<string | null> {
  const { rows } = await db.query<{ def: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS def
     FROM pg_constraint c
     WHERE c.conname = $2 AND c.conrelid = (current_schema() || '.' || $1)::regclass`,
    [table, conname],
  )
  return rows[0]?.def ?? null
}

async function countByType(accountType: string): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT COUNT(*)::int AS count FROM smart_accounts WHERE account_type = $1`,
    [accountType],
  )
  return Number(rows[0].count)
}

let seq = 0
async function seedUser(): Promise<string> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`legacysafe085-${seq++}-${Date.now()}-${Math.random()}@test.example`],
  )
  return user.rows[0].id
}

/** Address must be unique per row: `(user_id, account_address, chain_id)` is UNIQUE. */
function fakeAddress(n: number): string {
  return `0x${String(n).padStart(40, '0')}`
}

async function insertAccount(
  userId: string,
  addrSeed: number,
  accountType: string,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, account_type)
     VALUES ($1, $2, 84532, $3)
     RETURNING id`,
    [userId, fakeAddress(addrSeed), accountType],
  )
  return rows[0].id
}

describeDb('migration 085: account_type value safe -> legacy_safe (#2912)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  // #2616: this file hand-drives up()/down(), which mutates the CHECK
  // constraint's content and row data. `assertWorkerSchemaAtHead` cannot see
  // a CHECK's content (documented blind spot on that helper) so it will not
  // catch a leaked constraint-content mutation here — but every reverting
  // test below restores through `withMigrationReverted` or its own
  // try/finally, and this still catches a leaked table/column mutation from
  // this file or an earlier one.
  afterAll(assertWorkerSchemaAtHead)

  beforeEach(async () => {
    await resetDb()
  })

  it('is registered under its own version string', () => {
    expect(version).toBe('085_account_type_legacy_safe')
  })

  // ── The UPDATE, proven by exact post-count ──────────────────────────────

  it("up() renames exactly the seeded 'safe' rows to 'legacy_safe' and leaves 'delegator_hybrid' rows untouched", async () => {
    const client = await db.connect()
    try {
      await withMigrationReverted(
        () => down(client),
        async () => {
          const userId = await seedUser()
          const N = 3
          const M = 2
          const safeIds: string[] = []
          const hybridIds: string[] = []
          for (let i = 0; i < N; i++) {
            safeIds.push(await insertAccount(userId, 100 + i, 'safe'))
          }
          for (let i = 0; i < M; i++) {
            hybridIds.push(await insertAccount(userId, 200 + i, 'delegator_hybrid'))
          }

          // Sanity: the old CHECK really does accept 'safe' in this window.
          expect(await countByType('safe')).toBe(N)
          expect(await countByType('delegator_hybrid')).toBe(M)

          await up(client)

          expect(await countByType('safe')).toBe(0)
          expect(await countByType('legacy_safe')).toBe(N)
          expect(await countByType('delegator_hybrid')).toBe(M)

          const { rows: renamed } = await db.query<{ id: string; account_type: string }>(
            `SELECT id, account_type FROM smart_accounts WHERE id = ANY($1::uuid[])`,
            [safeIds],
          )
          expect(renamed.every((r) => r.account_type === 'legacy_safe')).toBe(true)

          const { rows: untouched } = await db.query<{ id: string; account_type: string }>(
            `SELECT id, account_type FROM smart_accounts WHERE id = ANY($1::uuid[])`,
            [hybridIds],
          )
          expect(untouched.every((r) => r.account_type === 'delegator_hybrid')).toBe(true)

          // The DELEGATION_RAIL_ONLY filter (infra/repositories/smart-accounts.ts)
          // compares against 'delegator_hybrid' only — unaffected by this
          // migration. Run the REAL repository query, not a re-derived one.
          const listed = await listAccountsWithTypeForUser(userId)
          const listedIds = listed.map((r) => r.id).sort()
          expect(listedIds).toEqual([...hybridIds].sort())
          // None of the renamed legacy_safe accounts should appear.
          expect(listed.some((r) => safeIds.includes(r.id))).toBe(false)
        },
        () => up(client),
      )
    } finally {
      client.release()
    }
  })

  // ── The CHECK, tightened ─────────────────────────────────────────────────

  it("the CHECK rejects 'safe' after up() (exact SQLSTATE 23514)", async () => {
    const userId = await seedUser()
    await expect(insertAccount(userId, 300, 'safe')).rejects.toMatchObject({ code: '23514' })
  })

  it("the CHECK accepts both surviving values after up()", async () => {
    const userId = await seedUser()
    await expect(insertAccount(userId, 301, 'legacy_safe')).resolves.toEqual(expect.any(String))
    await expect(insertAccount(userId, 302, 'delegator_hybrid')).resolves.toEqual(expect.any(String))
  })

  it('the constraint keeps its explicit name and its new content', async () => {
    expect(await constraintExists('smart_accounts', 'smart_accounts_account_type_check')).toBe(true)
    const def = await constraintDef('smart_accounts', 'smart_accounts_account_type_check')
    expect(def).toContain("'legacy_safe'")
    expect(def).toContain("'delegator_hybrid'")
    expect(def).not.toContain("'safe'::")
    expect(def).not.toMatch(/\(\s*'safe'/)
  })

  // ── The default (idempotent no-op, carried from 083/084) ─────────────────

  it("the column default is still 'delegator_hybrid' after up() (083's default, unaffected)", async () => {
    const value = await columnDefault('smart_accounts', 'account_type')
    expect(value).toBe("'delegator_hybrid'::character varying")
  })

  it('an INSERT omitting account_type lands as delegator_hybrid', async () => {
    const userId = await seedUser()
    const { rows } = await db.query<{ account_type: string }>(
      `INSERT INTO smart_accounts (user_id, account_address, chain_id)
       VALUES ($1, $2, 84532) RETURNING account_type`,
      [userId, fakeAddress(303)],
    )
    expect(rows[0].account_type).toBe('delegator_hybrid')
  })

  // ── down() reverses exactly ──────────────────────────────────────────────

  it('down() widens the CHECK back to accept \'safe\' and renames legacy_safe rows back', async () => {
    const client = await db.connect()
    try {
      const userId = await seedUser()
      const id = await insertAccount(userId, 400, 'legacy_safe')

      await down(client)

      const { rows } = await db.query<{ account_type: string }>(
        `SELECT account_type FROM smart_accounts WHERE id = $1`,
        [id],
      )
      expect(rows[0].account_type).toBe('safe')

      // The widened CHECK accepts 'safe' again.
      await expect(insertAccount(userId, 401, 'safe')).resolves.toEqual(expect.any(String))

      const def = await constraintDef('smart_accounts', 'smart_accounts_account_type_check')
      expect(def).toContain("'safe'")
      expect(def).not.toContain("'legacy_safe'")

      // The default is untouched by down() — 083 owns it, not this migration.
      const value = await columnDefault('smart_accounts', 'account_type')
      expect(value).toBe("'delegator_hybrid'::character varying")
    } finally {
      await up(client)
      client.release()
    }
  })

  it('down() then up() round-trips back to the exact head shape (no drift)', async () => {
    const client = await db.connect()
    try {
      await down(client)
      await up(client)

      const def = await constraintDef('smart_accounts', 'smart_accounts_account_type_check')
      expect(def).toContain("'legacy_safe'")
      expect(def).toContain("'delegator_hybrid'")
      const value = await columnDefault('smart_accounts', 'account_type')
      expect(value).toBe("'delegator_hybrid'::character varying")
    } finally {
      client.release()
    }
  })
})

describe('migration 085 registration', () => {
  it('exports up, down and a version matching its filename', () => {
    expect(typeof up).toBe('function')
    expect(typeof down).toBe('function')
    expect(version).toBe('085_account_type_legacy_safe')
  })
})
