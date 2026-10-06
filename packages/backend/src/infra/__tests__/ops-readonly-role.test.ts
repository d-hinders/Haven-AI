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
  buildOpsScrubSql,
  FREE_TEXT_COLUMN_NAME,
  OPS_FREE_TEXT_COLUMNS,
  OPS_NEVER_GRANT,
  OPS_READONLY_CONNECTION_LIMIT,
  OPS_READONLY_GRANTS,
  OPS_REVIEWED_SENSITIVE_COLUMNS,
  OPS_REVIEWED_STRUCTURED_COLUMNS,
  redactedExpression,
  SENSITIVE_COLUMN_NAME,
  unredactedSecretCondition,
} from '../ops-readonly-role.js'
import { redactVendorSecrets } from '../../domain/redact-vendor-secrets.js'
import { guardOpsReadExecutor, opsReadRoleProblems, OpsReadRoleUnsafeError } from '../repositories/ops-read-role.js'
import { LIST_UNMINED_OUTBOUND_TXS_SQL, COUNT_LANE_ATTEMPTS_AT_NONCE_SQL } from '../repositories/outbound-txs.js'
import { FIND_SWEEPABLE_ERC7710_INTENTS_SQL, FIND_EVIDENCE_ORPHANED_ERC7710_INTENTS_SQL } from '../repositories/x402-authorizations.js'
import { LIST_STUCK_REVOCATIONS_SQL, LIST_STUCK_REANCHORS_SQL } from '../repositories/agent-passports.js'
import { OPS_REVEAL_SQL } from '../repositories/ops-reveal.js'
import * as OPS_READS from '../repositories/ops-reads.js'

const SCHEMA = workerSchemaName()
const ROLE = `haven_ops_ro_${SCHEMA}`.slice(0, 63)

async function applyScript(): Promise<void> {
  await db.query(buildOpsReadonlyRoleSql({ role: ROLE, schema: SCHEMA }))
}

/**
 * Vendor-secret samples for the JS-vs-Postgres parity test, each with whether
 * it still holds an unredacted secret (`dirty`).
 */
const SECRET_SAMPLES: ReadonlyArray<[string, boolean]> = [
  ['HTTP request failed. URL: https://rpc.example/v2/84532?apikey=LEAKED_SECRET_123', true],
  ['https://api.pimlico.io/v2/84532/rpc?api_key=pim_abcDEF123&x=1', true],
  ['call failed: api-key=abc123) next', true],
  ['token=tok_1 secret=s3cr3t key=k', true],
  ['APIKEY=UPPER_CASE_KEY', true],
  ['https://user:p4ss@rpc.example/path', true],
  ['HTTPS://User:P4ss@rpc.example', true],
  ['https://bundler.example/rpc/0123456789abcdef0123', true],
  ['https://bundler.example/v2/AbCdEf_-0123456789xyz/more', true],
  ['https://rpc.example/v2/84532?apikey=REDACTED', false],
  ['https://REDACTED@rpc.example/rpc/REDACTED', false],
  ['passport failed: apikey=RED', false], // `.slice(0, 500)` after redaction
  ['execution reverted: TransferAmountExceedsBalance', false],
  ['publicKey=0xabc monkey=1 x_key=2', false], // no word boundary before `key`
  ['https://bundler.example/RPC/0123456789abcdef0123', false], // path match is case-sensitive, as in JS
  ['https://bundler.example/rpc/short', false],
  ['', false],
  // Unicode: JS `\s` includes NBSP, and JS `\b` (no `u` flag) treats é / π as non-word.
  ['key=REDACTED\u00a0more', false],
  ['key=abc\u00a0def', true],
  ['\u00e9key=SECRETVALUE', true],
  ['\u03c0key=xyz', true],
  ['https://user:p\u2028ss@host', false],
]

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

  it('never grants a never-grant column, and the builder refuses one a review entry tries to add', () => {
    expect(Object.keys(OPS_NEVER_GRANT).sort()).toEqual([
      'agents.api_key_hash',
      'agents.api_key_prefix',
      'payment_intents.machine_idempotency_key',
      'payment_intents.send_idempotency_key',
      'payment_intents.signature',
      'payment_intents.x402_idempotency_key',
      'users.password_hash',
    ])
    expect(ALLOWLIST.filter((q) => q in OPS_NEVER_GRANT)).toEqual([])
    expect(Object.keys(OPS_REVIEWED_SENSITIVE_COLUMNS).filter((q) => q in OPS_NEVER_GRANT)).toEqual([])
    const grants = OPS_READONLY_GRANTS as Record<string, string[]>
    const saved = grants.payment_intents
    grants.payment_intents = [...saved, 'signature']
    try {
      expect(() => buildOpsReadonlyRoleSql({ role: ROLE, schema: SCHEMA })).toThrow(/never-grant column\(s\): payment_intents.signature/)
    } finally {
      grants.payment_intents = saved
    }
  })

  it('detects and scrubs exactly what redactVendorSecrets redacts (JS-vs-Postgres parity)', async () => {
    for (const [sample, dirty] of SECRET_SAMPLES) {
      const { rows } = await db.query<{ dirty: boolean; scrubbed: string; clean_after: boolean }>(
        `SELECT ${unredactedSecretCondition('$1::text')} AS dirty,
                ${redactedExpression('$1::text')} AS scrubbed,
                ${unredactedSecretCondition(redactedExpression('$1::text'))} AS clean_after`,
        [sample],
      )
      expect(rows[0].dirty, sample).toBe(dirty)
      expect(rows[0].scrubbed, sample).toBe(redactVendorSecrets(sample))
      expect(rows[0].clean_after, sample).toBe(false)
      // A dirty sample is one the JS writer would have changed.
      if (dirty) expect(redactVendorSecrets(sample), sample).not.toBe(sample)
    }
  })

  it('the scrub clears a refusal, touching only the rows that hold a secret', async () => {
    const { rows: users } = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`ops-scrub-${Date.now()}@test.example`],
    )
    const { rows: agents } = await db.query<{ id: string }>(
      `INSERT INTO agents (user_id, name, status) VALUES ($1, 'a', 'active') RETURNING id`,
      [users[0].id],
    )
    const leak = 'HTTP request failed. URL: https://rpc.example/v2/84532?apikey=LEAKED_SECRET_123'
    await db.query(
      `INSERT INTO agent_passports (agent_id, chain_id, status, last_error, revocation_last_error) VALUES ($1, 84532, 'failed', $2, 'plain reason')`,
      [agents[0].id, leak],
    )
    await db.query(
      `INSERT INTO outbound_txs (chain_id, submitter, to_address, data, value_atomic, status, error)
       VALUES (84532, 'sweep', $1, '0x', '0', 'failed', 'nonce too low')`,
      ['0x' + '11'.repeat(20)],
    )
    await expect(applyScript()).rejects.toThrow(/unredacted vendor secret/)
    await db.query(buildOpsScrubSql({ schema: SCHEMA }))
    await db.query(buildOpsScrubSql({ schema: SCHEMA })) // idempotent
    const { rows } = await db.query<{ last_error: string; revocation_last_error: string }>(
      `SELECT last_error, revocation_last_error FROM agent_passports WHERE agent_id = $1`,
      [agents[0].id],
    )
    expect(rows[0]).toEqual({ last_error: redactVendorSecrets(leak), revocation_last_error: 'plain reason' })
    const { rows: txs } = await db.query<{ error: string }>(`SELECT error FROM outbound_txs`)
    expect(txs.map((t) => t.error)).toEqual(['nonce too low'])
    await applyScript()
    expect(await grantedColumns()).toEqual(ALLOWLIST)
  })

  it('refuses while the role can CREATE in the schema, and revokes a direct CREATE grant', async () => {
    await db.query(`GRANT CREATE ON SCHEMA "${SCHEMA}" TO "${ROLE}"`)
    await applyScript()
    const { rows } = await db.query<{ ok: boolean }>(`SELECT has_schema_privilege($1, $2, 'CREATE') AS ok`, [ROLE, SCHEMA])
    expect(rows[0].ok).toBe(false)
    await db.query(`GRANT CREATE ON SCHEMA "${SCHEMA}" TO PUBLIC`)
    try {
      await expect(applyScript()).rejects.toThrow(/can still CREATE in schema/)
    } finally {
      await db.query(`REVOKE CREATE ON SCHEMA "${SCHEMA}" FROM PUBLIC`)
    }
  })

  it('the pool self-check passes the role and refuses the main login, for good', async () => {
    // SET LOCAL ROLE does not apply the role's settings; the transaction sets what a login would get.
    await asRole(async (c) => {
      await c.query('SET LOCAL default_transaction_read_only = on')
      expect(await opsReadRoleProblems(c)).toEqual([])
    })
    expect(await opsReadRoleProblems(db)).toEqual(
      expect.arrayContaining([
        ...Object.keys(OPS_NEVER_GRANT).map((q) => `can read ${q}`),
        'can write a table',
        'can CREATE in its schema',
      ]),
    )
    let reported = 0
    const guarded = guardOpsReadExecutor(db, () => reported++)
    await expect(guarded.query('SELECT 1')).rejects.toBeInstanceOf(OpsReadRoleUnsafeError)
    await expect(guarded.query('SELECT 1')).rejects.toBeInstanceOf(OpsReadRoleUnsafeError)
    expect(reported).toBe(1)
  })

  it('the self-check refuses a login granted any never-grant column, or a write on any table', async () => {
    await asRole(async (c) => {
      await c.query('SET LOCAL default_transaction_read_only = on')
      expect(await opsReadRoleProblems(c)).toEqual([])
    })
    await db.query(`GRANT SELECT (api_key_prefix) ON "${SCHEMA}".agents TO "${ROLE}"`)
    await db.query(`GRANT INSERT ON "${SCHEMA}".payment_refusals TO "${ROLE}"`)
    await asRole(async (c) => {
      await c.query('SET LOCAL default_transaction_read_only = on')
      expect(await opsReadRoleProblems(c)).toEqual(['can read agents.api_key_prefix', 'can write a table'])
    })
  })

  it('a self-check that could not run is retried, not remembered', async () => {
    let calls = 0
    const flaky = {
      async query() {
        calls++
        if (calls === 1) throw new Error('connection refused')
        if (calls === 2) {
          return {
            rows: [{ 'can read users.password_hash': false, 'can write a table': false }],
            rowCount: 1,
          }
        }
        return { rows: [{ ok: 1 }], rowCount: 1 }
      },
    }
    const guarded = guardOpsReadExecutor(flaky as never)
    await expect(guarded.query('SELECT 1')).rejects.toThrow('connection refused')
    await expect(guarded.query('SELECT 1')).resolves.toMatchObject({ rows: [{ ok: 1 }] })
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
      // #3514: GET /ops/health reuses three more queries; each must run as the
      // role too. Parameters of the type each statement expects.
      await c.query(FIND_EVIDENCE_ORPHANED_ERC7710_INTENTS_SQL, [90, 86_400, 50])
      await c.query(LIST_STUCK_REANCHORS_SQL, [3600])
      await c.query(COUNT_LANE_ATTEMPTS_AT_NONCE_SQL, [84532, '0'])
      await c.query(OPS_REVEAL_SQL.user.email, ['00000000-0000-4000-8000-000000000000'])
      await c.query(OPS_REVEAL_SQL.user.name, ['00000000-0000-4000-8000-000000000000'])
      // #3512: every ops data read runs as the role. Each `*_SQL` export of
      // ops-reads.ts is executed with a parameter of the type it expects.
      const opsSql = Object.entries(OPS_READS).filter(([name]) => name.endsWith('_SQL')) as [string, string][]
      expect(opsSql.length).toBeGreaterThanOrEqual(20)
      for (const [name, sql] of opsSql) {
        const params = !sql.includes('$1')
          ? []
          : /email\) LIKE/.test(sql)
            ? ['ada%']
            : /lower\(/.test(sql)
              ? ['0x00']
              : ['00000000-0000-4000-8000-000000000000']
        await c.query(sql, params).catch((err: Error) => {
          throw new Error(`${name} failed as the ops role: ${err.message}`)
        })
      }
    })
  })

  it('sets the read-only, timeout and connection-limit bounds on the role', async () => {
    // Role settings are cluster-wide and outlive a run: clear them first, so
    // only THIS application of the script can make the assertions true.
    await db.query(`ALTER ROLE "${ROLE}" RESET ALL`)
    await db.query(`ALTER ROLE "${ROLE}" CONNECTION LIMIT -1`)
    await applyScript()
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
          `INSERT INTO payment_intents (agent_id, user_id, account_address, token_symbol, token_address, to_address, amount_raw, amount_human,
                                        delegate_address, allowance_nonce, sign_hash, expires_at, status, error_message)
           VALUES ($1, $2, $3, 'USDC', $3, $3, '1', '0.000001', $3, 0, '0x' || repeat('22', 32), NOW() + interval '1 hour', 'failed', $4)`,
          [agents[0].id, users[0].id, '0x' + '11'.repeat(20), leak],
        )
      } else if (table === 'outbound_txs') {
        await db.query(
          `INSERT INTO outbound_txs (chain_id, submitter, to_address, data, value_atomic, status, error)
           VALUES (84532, 'sweep', $1, '0x', '0', 'failed', $2)`,
          ['0x' + '11'.repeat(20), leak],
        )
      } else if (table === 'feedback') {
        // #3597's table: only a user and the text are NOT NULL (migration 106).
        await db.query(
          `INSERT INTO feedback (user_id, text) VALUES ($1, $2)`,
          [users[0].id, leak],
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
