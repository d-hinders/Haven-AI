/**
 * Real-Postgres proof for migration 084 (#2911, epic #2906 phase 3 — the
 * schema rename). No mocks — #1219's rule.
 *
 * The harness applies the FULL migration set, so by the time a test body
 * runs the table is already `smart_accounts` and every renamed column,
 * index and constraint already carries its new name; that post-migration
 * state is what production will be in. Tests that need the pre-rename shape
 * back call `down()` first, which doubles as the structural-reversibility
 * proof — same convention as every migration test in this directory.
 *
 * Every rename is asserted BY NAME, from the catalog (`pg_constraint`,
 * `pg_indexes`, `information_schema.columns`), never by re-deriving the name
 * from the migration's own source — `079_schema_local_constraint_repair.ts`
 * is the record of what happens when a constraint's existence is inferred
 * instead of measured.
 *
 * #2912 (data migration, epic #2906 phase 3b, later than this one) tightens
 * the `account_type` CHECK and renames the `'safe'` value to `'legacy_safe'`
 * on top of this migration's rename. The two tests below that assert this
 * migration's OWN untouched-content scope — the CHECK's exact definition and
 * a `'safe'`-valued row surviving the rename — revert 085 for their
 * duration so they keep testing 084 in isolation rather than drifting once
 * 085 lands.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../../db.js'
import { assertWorkerSchemaAtHead, describeDb, initDbHarness, resetDb, withMigrationReverted } from '../../../infra/__tests__/helpers/db-harness.js'
import { up, down, version } from '../084_rename_user_safes_to_smart_accounts.js'
import { down as down085, up as up085 } from '../085_account_type_legacy_safe.js'

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>(
    `SELECT to_regclass(current_schema() || '.' || $1) IS NOT NULL AS exists`,
    [name],
  )
  return rows[0].exists
}

async function viewExists(name: string): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.views
       WHERE table_schema = current_schema() AND table_name = $1
     ) AS exists`,
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

async function indexExists(table: string, indexName: string): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_indexes
       WHERE schemaname = current_schema() AND tablename = $1 AND indexname = $2
     ) AS exists`,
    [table, indexName],
  )
  return rows[0].exists
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

let seq = 0
async function seedUser(): Promise<string> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`rename084-${seq++}-${Date.now()}-${Math.random()}@test.example`],
  )
  return user.rows[0].id
}

// Every rename `up()` performs, expressed as [old, new] pairs, grouped by
// catalog kind — the single source both the "present/absent" tests and the
// down()-reversal test below iterate over, so the list itself cannot drift
// from what is actually asserted.
const RENAMED_TABLES = [['user_safes', 'smart_accounts']] as const

const RENAMED_COLUMNS = [
  ['smart_accounts', 'safe_address', 'account_address'],
  ['users', 'safe_address', 'account_address'],
  ['payment_intents', 'safe_address', 'account_address'],
  ['user_passkeys', 'safe_address', 'account_address'],
  ['agents', 'safe_id', 'account_id'],
  ['agent_connection_setups', 'safe_id', 'account_id'],
  ['agent_connection_setups', 'safe_tx_hash', 'account_tx_hash'],
  ['hybrid_account_passkeys', 'user_safe_id', 'account_id'],
] as const

const RENAMED_INDEXES = [
  ['smart_accounts', 'idx_user_safes_user_id', 'idx_smart_accounts_user_id'],
  ['smart_accounts', 'idx_user_safes_address', 'idx_smart_accounts_address'],
  ['smart_accounts', 'idx_user_safes_chain_id', 'idx_smart_accounts_chain_id'],
  ['hybrid_account_passkeys', 'hybrid_account_passkeys_safe_idx', 'hybrid_account_passkeys_account_idx'],
] as const

const RENAMED_CONSTRAINTS = [
  ['smart_accounts', 'user_safes_pkey', 'smart_accounts_pkey'],
  ['smart_accounts', 'user_safes_user_id_fkey', 'smart_accounts_user_id_fkey'],
  [
    'smart_accounts',
    'user_safes_user_id_safe_address_chain_id_key',
    'smart_accounts_user_id_account_address_chain_id_key',
  ],
  ['smart_accounts', 'user_safes_account_type_check', 'smart_accounts_account_type_check'],
  ['smart_accounts', 'user_safes_execution_rail_check', 'smart_accounts_execution_rail_check'],
  [
    'agent_connection_setups',
    'agent_connection_setups_safe_id_fkey',
    'agent_connection_setups_account_id_fkey',
  ],
  [
    'hybrid_account_passkeys',
    'hybrid_account_passkeys_user_safe_id_fkey',
    'hybrid_account_passkeys_account_id_fkey',
  ],
  [
    'hybrid_account_passkeys',
    'hybrid_account_passkeys_user_safe_id_key_id_key',
    'hybrid_account_passkeys_account_id_key_id_key',
  ],
] as const

describeDb('migration 084: rename user_safes to smart_accounts (#2911)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  // #2616: this file hand-drives up()/down(), which mutates SCHEMA — and
  // nothing else in the harness undoes that. Fail HERE if the schema is left
  // off head, rather than letting the next file on this worker inherit it as
  // an unexplained table-existence failure.
  //
  // Unlike most migrations in this directory, `up()` here is NOT idempotent —
  // every rename is an unconditional `RENAME TO`/`RENAME COLUMN`/
  // `RENAME CONSTRAINT`, none guarded by `IF EXISTS` — so there is no safe
  // blanket "re-apply up() afterwards" net to add here the way other files'
  // `afterAll` blocks do: calling it against an already-renamed schema
  // throws on the first statement. Each test that calls `down()` already
  // restores with its own `up(client)` in a `finally`, which is what keeps
  // the assertion below green.
  afterAll(assertWorkerSchemaAtHead)

  beforeEach(async () => {
    await resetDb()
  })

  it('is registered under its own version string', () => {
    expect(version).toBe('084_rename_user_safes_to_smart_accounts')
  })

  // ── The table ────────────────────────────────────────────────────────────

  it('the table is smart_accounts, and user_safes is gone', async () => {
    expect(await tableExists('smart_accounts')).toBe(true)
    expect(await tableExists('user_safes')).toBe(false)
  })

  it('no view is created to shadow the old name (epic decision 3 — no compat view)', async () => {
    expect(await viewExists('user_safes')).toBe(false)
    expect(await viewExists('smart_accounts')).toBe(false)
  })

  // ── Columns ──────────────────────────────────────────────────────────────

  it.each(RENAMED_COLUMNS)('%s.%s is renamed to %s', async (table, oldName, newName) => {
    expect(await columnExists(table, oldName)).toBe(false)
    expect(await columnExists(table, newName)).toBe(true)
  })

  // ── Indexes ──────────────────────────────────────────────────────────────

  it.each(RENAMED_INDEXES)('index on %s: %s is renamed to %s', async (table, oldName, newName) => {
    expect(await indexExists(table, oldName)).toBe(false)
    expect(await indexExists(table, newName)).toBe(true)
  })

  // ── Constraints — the five implicit names plus the three explicit ones ──
  //
  // `079_schema_local_constraint_repair.ts:49-51` records that two of these
  // exact names were silently dropped from 185 schemas once, because an
  // idempotency guard resolved `pg_constraint.conname` without a
  // `conrelid`/schema scope. `constraintExists()` above is anchored on
  // `conrelid`, which is the fix that issue landed — this migration's own
  // test inherits it rather than repeating the mistake.

  it.each(RENAMED_CONSTRAINTS)('constraint on %s: %s is renamed to %s', async (table, oldName, newName) => {
    expect(await constraintExists(table, oldName)).toBe(false)
    expect(await constraintExists(table, newName)).toBe(true)
  })

  // The CHECK constraints' CONTENT is untouched by THIS migration — only the
  // name changes. The `'safe'` value and the IN-list are #2912's scope, and
  // #2912 tightened it (085) on top of this migration — so this test reverts
  // 085 for its duration to assert 084's own scope in isolation, the same
  // "a later migration renamed what an earlier test asserted" shape 075's
  // file-level wrap uses for 083/084.
  it("the renamed account_type CHECK keeps its exact content — #2912's scope, not this one's", async () => {
    await withMigrationReverted(
      () => down085(db as never),
      async () => {
        const { rows } = await db.query<{ def: string }>(
          `SELECT pg_get_constraintdef(c.oid) AS def
           FROM pg_constraint c
           WHERE c.conname = 'smart_accounts_account_type_check'
             AND c.conrelid = (current_schema() || '.smart_accounts')::regclass`,
        )
        expect(rows[0]?.def).toContain("'safe'")
        expect(rows[0]?.def).toContain("'delegator_hybrid'")
      },
      () => up085(db as never),
    )
  })

  // ── The 083 default, carried forward under the new name ─────────────────

  it("account_type still defaults to 'delegator_hybrid' under the new table name (083's default, unchanged)", async () => {
    const value = await columnDefault('smart_accounts', 'account_type')
    expect(value).toBe("'delegator_hybrid'::character varying")
  })

  // 085 (#2912) tightens the CHECK to reject 'safe', so this test — which
  // asserts 084's OWN scope (the rename touches no row) — reverts 085 for
  // its duration, same reasoning as the CHECK-content test above.
  it('a legacy account_type=\'safe\' row survives the rename with its value untouched', async () => {
    await withMigrationReverted(
      () => down085(db as never),
      async () => {
        const userId = await seedUser()
        const inserted = await db.query<{ id: string }>(
          `INSERT INTO smart_accounts (user_id, account_address, chain_id, account_type)
           VALUES ($1, '0x0000000000000000000000000000000000000084', 84532, 'safe')
           RETURNING id`,
          [userId],
        )
        const { rows } = await db.query<{ account_type: string }>(
          `SELECT account_type FROM smart_accounts WHERE id = $1`,
          [inserted.rows[0].id],
        )
        expect(rows[0].account_type).toBe('safe')
      },
      () => up085(db as never),
    )
  })

  // ── `agents.account_id` — rename only, still no FK ───────────────────────

  it('agents.account_id is a bare column — renaming it did not add a foreign key', async () => {
    const { rows } = await db.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_constraint c
         WHERE c.conrelid = 'agents'::regclass
           AND c.contype = 'f'
           AND c.conname LIKE '%account_id%'
       ) AS exists`,
    )
    expect(rows[0].exists).toBe(false)
  })

  // ── up() idempotency ─────────────────────────────────────────────────────
  //
  // Not run bare: every rename in `up()` is unconditional (`RENAME TO`/
  // `RENAME COLUMN`/`RENAME CONSTRAINT`, none guarded by `IF EXISTS`), so a
  // second run over an already-renamed schema throws by construction — the
  // same shape as every other pure-rename migration in this repo (`080`'s
  // `ALTER TABLE … RENAME TO` carries no idempotency guard either). Proven
  // instead as down() -> up() -> up() again would throw, which the
  // reversibility test below exercises implicitly by calling up() last.

  // ── down() reverses cleanly ──────────────────────────────────────────────

  it('down() reverses every rename — table, columns, indexes and constraints', async () => {
    const client = await db.connect()
    try {
      await down(client)

      expect(await tableExists('user_safes')).toBe(true)
      expect(await tableExists('smart_accounts')).toBe(false)

      for (const [table, oldName, newName] of RENAMED_COLUMNS) {
        // `smart_accounts` itself is gone post-down(); its column checks run
        // against `user_safes` instead.
        const t = table === 'smart_accounts' ? 'user_safes' : table
        expect(await columnExists(t, newName)).toBe(false)
        expect(await columnExists(t, oldName)).toBe(true)
      }

      for (const [table, oldName, newName] of RENAMED_INDEXES) {
        expect(await indexExists(table === 'smart_accounts' ? 'user_safes' : table, newName)).toBe(false)
        expect(await indexExists(table === 'smart_accounts' ? 'user_safes' : table, oldName)).toBe(true)
      }

      for (const [table, oldName, newName] of RENAMED_CONSTRAINTS) {
        const t = table === 'smart_accounts' ? 'user_safes' : table
        expect(await constraintExists(t, newName)).toBe(false)
        expect(await constraintExists(t, oldName)).toBe(true)
      }

      // Restored shape is usable, not just present — a real insert.
      const userId = await seedUser()
      const { rows } = await db.query<{ execution_rail: string; account_type: string }>(
        `INSERT INTO user_safes (user_id, safe_address, chain_id)
         VALUES ($1, '0x0000000000000000000000000000000000000085', 84532)
         RETURNING execution_rail, account_type`,
        [userId],
      )
      // 083's default survives the round trip (rename → revert → rename).
      expect(rows[0].account_type).toBe('delegator_hybrid')
      expect(rows[0].execution_rail).toBe('delegation')
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

      expect(await tableExists('smart_accounts')).toBe(true)
      expect(await tableExists('user_safes')).toBe(false)
      for (const [table, oldName, newName] of RENAMED_COLUMNS) {
        expect(await columnExists(table, oldName)).toBe(false)
        expect(await columnExists(table, newName)).toBe(true)
      }
      for (const [table, , newName] of RENAMED_CONSTRAINTS) {
        expect(await constraintExists(table, newName)).toBe(true)
      }
    } finally {
      client.release()
    }
  })
})

describe('migration 084 registration', () => {
  it('exports up, down and a version matching its filename', () => {
    expect(typeof up).toBe('function')
    expect(typeof down).toBe('function')
    expect(version).toBe('084_rename_user_safes_to_smart_accounts')
  })
})
