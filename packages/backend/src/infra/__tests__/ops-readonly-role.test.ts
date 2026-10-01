/**
 * The ops console's read-only role (#3510, epic #3507 invariant 5), proven
 * against a real Postgres — no mocks (#1219's rule).
 *
 * The script is applied to this worker's schema under a per-worker role name
 * (roles are cluster-wide; schemas are per worker). The role is NOLOGIN here,
 * so every "as the role" check runs inside a transaction after `SET ROLE`.
 */
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../db.js'
import { describeDb, initDbHarness, resetDb } from './helpers/db-harness.js'
import { workerSchemaName } from './helpers/worker-schema.js'
import {
  buildOpsReadonlyRoleSql,
  FREE_TEXT_COLUMN_NAME,
  OPS_FREE_TEXT_COLUMNS,
  OPS_READONLY_CONNECTION_LIMIT,
  OPS_READONLY_GRANTS,
  OPS_REVIEWED_SENSITIVE_COLUMNS,
  OPS_REVIEWED_STRUCTURED_COLUMNS,
  SENSITIVE_COLUMN_NAME,
} from '../ops-readonly-role.js'
import { LIST_UNMINED_OUTBOUND_TXS_SQL } from '../repositories/outbound-txs.js'
import { FIND_SWEEPABLE_ERC7710_INTENTS_SQL } from '../repositories/x402-authorizations.js'
import { LIST_STUCK_REVOCATIONS_SQL } from '../repositories/agent-passports.js'
import { OPS_REVEAL_SQL } from '../repositories/ops-reveal.js'

const SCHEMA = workerSchemaName()
const ROLE = `haven_ops_ro_${SCHEMA}`.slice(0, 63)

async function applyScript(): Promise<void> {
  await db.query(buildOpsReadonlyRoleSql({ role: ROLE, schema: SCHEMA }))
}

/** Run `fn` as the role, always rolled back. Rejections propagate. */
async function asRole<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL ROLE "${ROLE}"`)
    return await fn(client)
  } finally {
    await client.query('ROLLBACK').catch(() => undefined)
    client.release()
  }
}

async function permissionDenied(sql: string, params: unknown[] = []): Promise<void> {
  await expect(asRole((c) => c.query(sql, params))).rejects.toMatchObject({ code: '42501' })
}

async function schemaTables(): Promise<string[]> {
  const { rows } = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY 1`,
    [SCHEMA],
  )
  return rows.map((r) => r.table_name)
}

async function grantedColumns(): Promise<string[]> {
  const { rows } = await db.query<{ q: string }>(
    `SELECT table_name || '.' || column_name AS q
       FROM information_schema.column_privileges
      WHERE grantee = $1 AND table_schema = $2 AND privilege_type = 'SELECT'
      ORDER BY 1`,
    [ROLE, SCHEMA],
  )
  return rows.map((r) => r.q)
}

const ALLOWLIST = Object.entries(OPS_READONLY_GRANTS)
  .flatMap(([table, cols]) => cols.map((c) => `${table}.${c}`))
  .sort()

describeDb('ops read-only role (#3510)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
    await applyScript()
  })
  afterAll(async () => {
    // Leave the cluster-wide role with nothing granted in this schema.
    await db.query(`REVOKE ALL ON ALL TABLES IN SCHEMA "${SCHEMA}" FROM "${ROLE}"`).catch(() => undefined)
  })

  it('grants exactly the allowlist — column-level only, never a table-level SELECT', async () => {
    expect(await grantedColumns()).toEqual(ALLOWLIST)
    const tables = await schemaTables()
    expect(tables).toContain('users')
    const tableLevel: string[] = []
    for (const t of tables) {
      const { rows } = await db.query<{ ok: boolean }>(`SELECT has_table_privilege($1, $2, 'SELECT') AS ok`, [ROLE, `"${SCHEMA}"."${t}"`])
      if (rows[0].ok) tableLevel.push(t)
    }
    expect(tableLevel).toEqual([])
  })

  it('every allowlisted column exists at head — a dropped or renamed column fails here, not in prod', async () => {
    const { rows } = await db.query<{ q: string }>(
      `SELECT table_name || '.' || column_name AS q FROM information_schema.columns WHERE table_schema = $1`,
      [SCHEMA],
    )
    const existing = new Set(rows.map((r) => r.q))
    expect(ALLOWLIST.filter((q) => !existing.has(q))).toEqual([])
  })

  it('names nothing sensitive or free-text without a written review', () => {
    const unreviewedSensitive = ALLOWLIST.filter(
      (q) => SENSITIVE_COLUMN_NAME.test(q.split('.')[1]) && !(q in OPS_REVIEWED_SENSITIVE_COLUMNS),
    )
    expect(unreviewedSensitive).toEqual([])
    const unreviewedFreeText = ALLOWLIST.filter(
      (q) =>
        FREE_TEXT_COLUMN_NAME.test(q.split('.')[1]) &&
        !(q in OPS_FREE_TEXT_COLUMNS) &&
        !(q in OPS_REVIEWED_STRUCTURED_COLUMNS),
    )
    expect(unreviewedFreeText).toEqual([])
    // Positive control: the patterns do match what they are meant to.
    expect(SENSITIVE_COLUMN_NAME.test('password_hash')).toBe(true)
    expect(FREE_TEXT_COLUMN_NAME.test('error_message')).toBe(true)
  })

  it('cannot read a withheld column or table', async () => {
    for (const sql of [
      'SELECT password_hash FROM users',
      'SELECT api_key_hash FROM agents',
      'SELECT api_key_prefix FROM agents',
      'SELECT signature FROM payment_intents',
      'SELECT machine_idempotency_key FROM payment_intents',
      'SELECT * FROM users',
      'SELECT * FROM agent_connection_setups',
      'SELECT * FROM device_authorizations',
      'SELECT * FROM accounting_connections',
      'SELECT * FROM catalog_submissions',
      'SELECT * FROM user_passkeys',
      'SELECT * FROM rate_limit_counters',
      'SELECT * FROM owner_company_details',
      'SELECT * FROM ops_access_log',
    ]) {
      await permissionDenied(sql)
    }
  })

  it('cannot write anything', async () => {
    await permissionDenied(`INSERT INTO users (email, password_hash) VALUES ('x@y.example', 'x')`)
    await permissionDenied(`UPDATE agents SET name = 'x'`)
    await permissionDenied(`DELETE FROM payment_intents`)
    await permissionDenied(`INSERT INTO ops_access_log (operator_github_id, operator_login, action, request_id) VALUES (1, 'x', 'view', 'r')`)
  })

  it('reads what it is granted, counts rows, and runs every query the ops slices reuse', async () => {
    await asRole(async (c) => {
      await c.query('SELECT id, email, name FROM users')
      await c.query('SELECT count(*) FROM payment_intents')
      await c.query('SELECT delegation_json FROM agent_delegations')
      await c.query(LIST_UNMINED_OUTBOUND_TXS_SQL, [84532, 180])
      await c.query(FIND_SWEEPABLE_ERC7710_INTENTS_SQL, [90, 86_400, 50])
      await c.query(LIST_STUCK_REVOCATIONS_SQL, [3600])
      await c.query(OPS_REVEAL_SQL.user.email, ['00000000-0000-4000-8000-000000000000'])
      await c.query(OPS_REVEAL_SQL.user.name, ['00000000-0000-4000-8000-000000000000'])
    })
  })

  it('sets the read-only, timeout and connection-limit bounds on the role', async () => {
    const { rows } = await db.query<{ rolconnlimit: number; rolcanlogin: boolean; settings: string[] | null }>(
      `SELECT r.rolconnlimit, r.rolcanlogin, s.setconfig AS settings
         FROM pg_roles r LEFT JOIN pg_db_role_setting s ON s.setrole = r.oid AND s.setdatabase = 0
        WHERE r.rolname = $1`,
      [ROLE],
    )
    expect(rows[0].rolconnlimit).toBe(OPS_READONLY_CONNECTION_LIMIT)
    expect(rows[0].rolcanlogin).toBe(false)
    expect(rows[0].settings).toEqual(expect.arrayContaining(['default_transaction_read_only=on', 'statement_timeout=5s']))
  })

  it('is idempotent, and a re-run revokes a column granted outside the allowlist', async () => {
    await db.query(`GRANT SELECT (password_hash) ON "${SCHEMA}".users TO "${ROLE}"`)
    expect(await grantedColumns()).toContain('users.password_hash')
    await applyScript()
    await applyScript()
    expect(await grantedColumns()).toEqual(ALLOWLIST)
  })

  it.each(Object.keys(OPS_FREE_TEXT_COLUMNS))(
    'refuses, granting nothing new, while %s holds an unredacted vendor secret',
    async (qualified) => {
      const [table, column] = qualified.split('.')
      const { rows: users } = await db.query<{ id: string }>(
        `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
        [`ops-ro-${Date.now()}@test.example`],
      )
      const { rows: agents } = await db.query<{ id: string }>(
        `INSERT INTO agents (user_id, name, status) VALUES ($1, 'a', 'active') RETURNING id`,
        [users[0].id],
      )
      const leak = 'HTTP request failed. URL: https://rpc.example/v2/84532?apikey=LEAKED_SECRET_123'
      if (table === 'payment_intents') {
        await db.query(
          `INSERT INTO payment_intents (agent_id, user_id, token_symbol, token_address, to_address, amount_raw, amount_human, status, error_message)
           VALUES ($1, $2, 'USDC', $3, $3, '1', '0.000001', 'failed', $4)`,
          [agents[0].id, users[0].id, '0x' + '11'.repeat(20), leak],
        )
      } else if (table === 'outbound_txs') {
        await db.query(
          `INSERT INTO outbound_txs (chain_id, submitter, to_address, data, value_atomic, status, error)
           VALUES (84532, 'sweep', $1, '0x', '0', 'failed', $2)`,
          ['0x' + '11'.repeat(20), leak],
        )
      } else {
        await db.query(
          `INSERT INTO agent_passports (agent_id, chain_id, status, ${column}) VALUES ($1, 84532, 'failed', $2)`,
          [agents[0].id, leak],
        )
      }
      await db.query(`REVOKE ALL ON ALL TABLES IN SCHEMA "${SCHEMA}" FROM "${ROLE}"`)
      await expect(applyScript()).rejects.toThrow(/unredacted vendor secret/)
      expect(await grantedColumns()).toEqual([])

      // The redacted form is accepted.
      await db.query(`UPDATE "${SCHEMA}"."${table}" SET "${column}" = $1`, [
        'HTTP request failed. URL: https://rpc.example/v2/84532?apikey=REDACTED',
      ])
      await applyScript()
      expect(await grantedColumns()).toEqual(ALLOWLIST)
    },
  )
})
