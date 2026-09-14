/**
 * Real-Postgres proof for migration 086 — the `payment_refusals` ledger
 * (#2945, slice A of epic #2944). No mocks — #1219's rule.
 *
 * The harness applies the FULL migration set, so by the time a test body runs
 * the table already exists at head shape. Tests that need the pre-086 state
 * back call `down()` first (or wrap with `withMigrationReverted`), which
 * doubles as the structural-reversibility proof, same convention as every
 * migration test in this directory.
 *
 * What this file pins, per the issue's acceptance criteria:
 *  - the FK is named `payment_refusals_account_id_fkey` and references
 *    `smart_accounts(id)` — the post-084 account vocabulary;
 *  - the `reason` CHECK is the closed FIVE-value set with
 *    `recipient_not_allowed` ABSENT (no writer emits it);
 *  - the `source` CHECK is the closed three-value set;
 *  - `detail` is a JSONB ALLOWLIST: every allowed key survives, ANY extra
 *    key is a constraint violation (23514) at write time;
 *  - `down()` reverses exactly and `up()` round-trips to the head shape.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../../db.js'
import { assertWorkerSchemaAtHead, describeDb, initDbHarness, resetDb, withMigrationReverted } from '../../../infra/__tests__/helpers/db-harness.js'
import { DELETE_USER_ACCOUNT_SQL, ORPHAN_AGENTS_FOR_ACCOUNT_SQL } from '../../../infra/repositories/smart-accounts.js'
import { recordPaymentRefusal } from '../../../infra/repositories/payment-refusals.js'
import { up, down, version } from '../086_payment_refusals.js'

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

let seq = 0
async function seedUser(): Promise<string> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`refusals086-${seq++}-${Date.now()}-${Math.random()}@test.example`],
  )
  return user.rows[0].id
}

async function seedAgent(userId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, $2) RETURNING id`,
    [userId, `refusals-agent-${seq}`],
  )
  return rows[0].id
}

/** Address must be unique per row: `(user_id, account_address, chain_id)` is UNIQUE. */
function fakeAddress(n: number): string {
  return `0x${String(n).padStart(40, '0')}`
}

async function insertAccount(userId: string, addrSeed: number): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id)
     VALUES ($1, $2, 84532) RETURNING id`,
    [userId, fakeAddress(addrSeed)],
  )
  return rows[0].id
}

async function insertRefusal(overrides: Record<string, unknown> = {}): Promise<void> {
  const userId = overrides.user_id ?? (await seedUser())
  const agentId = overrides.agent_id ?? (await seedAgent(userId as string))
  await db.query(
    `INSERT INTO payment_refusals
       (user_id, agent_id, chain_id, token_symbol, amount_atomic, reason, source, detail)
     VALUES ($1, $2, 84532, 'USDC', '10000', $3, $4, $5)`,
    [
      userId,
      agentId,
      overrides.reason ?? 'onchain_revert',
      overrides.source ?? 'x402_authorize',
      overrides.detail === undefined ? null : JSON.stringify(overrides.detail),
    ],
  )
}

describeDb('migration 086: payment_refusals ledger (#2945)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  // This file hand-drives down()/up() below (dropping and re-creating the
  // table); the guard catches a leaked table mutation from this file or an
  // earlier one. CHECK-constraint content mutations are its documented blind
  // spot — every reverting test restores through withMigrationReverted or its
  // own try/finally.
  afterAll(assertWorkerSchemaAtHead)

  beforeEach(async () => {
    await resetDb()
  })

  it('is registered under its own version string', () => {
    expect(version).toBe('086_payment_refusals')
  })

  // ── The FK, in the post-084 account vocabulary ──────────────────────────

  it('the account FK keeps its explicit name and references smart_accounts(id)', async () => {
    expect(await constraintExists('payment_refusals', 'payment_refusals_account_id_fkey')).toBe(true)
    const def = await constraintDef('payment_refusals', 'payment_refusals_account_id_fkey')
    expect(def).toContain('smart_accounts')
  })

  // The delete action is the load-bearing half of this FK. Without it the
  // column's nullability is a lie: an existing refusal row blocks the account
  // unlink (PG 23503), so a telemetry table permanently breaks a self-custody
  // revocation control. Pinned structurally here AND behaviourally below.
  it('the account FK is ON DELETE SET NULL, not the NO ACTION default', async () => {
    const def = await constraintDef('payment_refusals', 'payment_refusals_account_id_fkey')
    expect(def).toContain('ON DELETE SET NULL')
    // The NO ACTION default renders without any ON clause; asserting its
    // absence is what makes this fail if the clause is dropped from 086.
    expect(def).not.toMatch(/ON DELETE (NO ACTION|RESTRICT|CASCADE|SET DEFAULT)/)
  })

  it('the account unlink succeeds once a refusal row carries the account_id, and the audit row survives with a NULL account_id', async () => {
    // Reproduces the shape `deleteAccountForUser` runs (routes/user-safes.ts
    // -> DELETE /user/safes/:safeId): orphan the agents, then delete the
    // account row. The refusal row is written first — the record-then-unlink
    // direction that threw 23503 at the reviewed head.
    const userId = await seedUser()
    const accountId = await insertAccount(userId, 510)
    const agentId = await seedAgent(userId)
    await db.query(ORPHAN_AGENTS_FOR_ACCOUNT_SQL, [accountId])

    const { id: refusalId } = await recordPaymentRefusal({
      userId,
      accountId,
      agentId,
      chainId: 84532,
      tokenSymbol: 'USDC',
      amountAtomic: '10000',
      usdValue: null,
      eurValue: null,
      reason: 'onchain_revert',
      source: 'x402_authorize',
    })

    // The row is attached to the account before the unlink touches it.
    const before = await db.query<{ account_id: string | null }>(
      `SELECT account_id FROM payment_refusals WHERE id = $1`,
      [refusalId],
    )
    expect(before.rows[0].account_id).toBe(accountId)

    // The write half of the real unlink transaction. This DELETE is where the
    // NO ACTION FK raised 23503; with SET NULL it must simply succeed.
    await expect(db.query(ORPHAN_AGENTS_FOR_ACCOUNT_SQL, [accountId])).resolves.toBeTruthy()
    await expect(db.query(DELETE_USER_ACCOUNT_SQL, [accountId])).resolves.toBeTruthy()

    // The audit trail outlives the account: row retained, account_id cleared.
    const after = await db.query<{ account_id: string | null }>(
      `SELECT account_id FROM payment_refusals WHERE id = $1`,
      [refusalId],
    )
    expect(after.rows).toHaveLength(1)
    expect(after.rows[0].account_id).toBeNull()

    // And the account really is gone — this is not a rolled-back no-op.
    const account = await db.query<{ one: number }>(
      `SELECT 1 AS one FROM smart_accounts WHERE id = $1`,
      [accountId],
    )
    expect(account.rows).toHaveLength(0)
  })

  it('a refusal whose account_id names a real smart_account row is accepted (FK live)', async () => {
    const userId = await seedUser()
    const accountId = await insertAccount(userId, 500)
    const agentId = await seedAgent(userId)
    await expect(
      db.query(
        `INSERT INTO payment_refusals
           (user_id, account_id, agent_id, chain_id, token_symbol, amount_atomic, reason, source)
         VALUES ($1, $2, $3, 84532, 'USDC', '10000', 'onchain_revert', 'x402_authorize')`,
        [userId, accountId, agentId],
      ),
    ).resolves.toBeTruthy()
  })

  it('a refusal whose account_id has no smart_account row is rejected (23503)', async () => {
    const userId = await seedUser()
    const agentId = await seedAgent(userId)
    await expect(
      db.query(
        `INSERT INTO payment_refusals
           (user_id, account_id, agent_id, chain_id, token_symbol, amount_atomic, reason, source)
         VALUES ($1, $2, $3, 84532, 'USDC', '10000', 'onchain_revert', 'x402_authorize')`,
        [userId, crypto.randomUUID(), agentId],
      ),
    ).rejects.toMatchObject({ code: '23503' })
  })

  it('agent_id is NOT NULL and cascades on agent delete (a refusal belongs to its agent)', async () => {
    const userId = await seedUser()
    const agentId = await seedAgent(userId)
    await insertRefusal({ user_id: userId, agent_id: agentId })
    const { rows: counted } = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM payment_refusals WHERE agent_id = $1`,
      [agentId],
    )
    expect(Number(counted[0].count)).toBe(1)
    await db.query(`DELETE FROM agents WHERE id = $1`, [agentId])
    const { rows: after } = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM payment_refusals WHERE agent_id = $1`,
      [agentId],
    )
    expect(Number(after[0].count)).toBe(0)
  })

  // ── The closed reason enum: five values, recipient_not_allowed ABSENT ───

  it('the reason CHECK accepts exactly the five named values', async () => {
    for (const reason of [
      'delegation_budget_exceeded',
      'no_delegation_for_target',
      'delegation_expired',
      'relayer_budget',
      'onchain_revert',
    ]) {
      await expect(insertRefusal({ reason })).resolves.toBeUndefined()
    }
  })

  it('the reason CHECK rejects recipient_not_allowed (dropped: no writer emits it) and anything unnamed', async () => {
    await expect(insertRefusal({ reason: 'recipient_not_allowed' })).rejects.toMatchObject({ code: '23514' })
    await expect(insertRefusal({ reason: 'insufficient_funds' })).rejects.toMatchObject({ code: '23514' })
  })

  it('the source CHECK accepts exactly the three writers and rejects the rest', async () => {
    for (const source of ['x402_authorize', 'payment', 'redeem']) {
      await expect(insertRefusal({ source })).resolves.toBeUndefined()
    }
    await expect(insertRefusal({ source: 'settle' })).rejects.toMatchObject({ code: '23514' })
  })

  // ── detail: the JSONB ALLOWLIST ──────────────────────────────────────────

  it('detail accepts every allowlisted key and rejects ANY extra key', async () => {
    // The full allowlist, as strings — the only shape the writer produces.
    await expect(
      insertRefusal({
        detail: {
          error_code: 'delegation_budget_exceeded',
          phase: 'insufficient_funds',
          next_action: 'fund_safe_or_raise_allowance',
          remaining_atomic: '40000',
          budget_atomic: '5000000',
        },
      }),
    ).resolves.toBeUndefined()
    // A subset is fine too.
    await expect(insertRefusal({ detail: { error_code: 'no_delegation_for_target' } })).resolves.toBeUndefined()
    // One extra key — the copy-whole-body drift #2907/#2908 found — is a
    // constraint violation, not a convention.
    await expect(
      insertRefusal({ detail: { error_code: 'onchain_revert', amount: '0.10' } }),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(insertRefusal({ detail: { components: {} } })).rejects.toMatchObject({ code: '23514' })
  })

  it('attempts must be >= 1', async () => {
    const userId = await seedUser()
    const agentId = await seedAgent(userId)
    await expect(
      db.query(
        `INSERT INTO payment_refusals
           (user_id, agent_id, chain_id, token_symbol, amount_atomic, reason, source, attempts)
         VALUES ($1, $2, 84532, 'USDC', '10000', 'onchain_revert', 'x402_authorize', 0)`,
        [userId, agentId],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('the two analytics indexes exist', async () => {
    const { rows } = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = 'payment_refusals'`,
    )
    const names = rows.map((r) => r.indexname)
    expect(names).toContain('idx_payment_refusals_user_created')
    expect(names).toContain('idx_payment_refusals_agent_created')
    expect(names).toContain('idx_payment_refusals_dedupe')
  })

  // ── down() reverses exactly ──────────────────────────────────────────────

  it('down() drops the table and up() recreates the exact head shape', async () => {
    const client = await db.connect()
    try {
      const userId = await seedUser()
      await insertRefusal({ user_id: userId })

      await withMigrationReverted(
        () => down(client),
        async () => {
          await expect(db.query(`SELECT 1 FROM payment_refusals LIMIT 1`)).rejects.toMatchObject({ code: '42P01' })
        },
        () => up(client),
      )

      // The seeded row is gone with the table (down() dropped it); a fresh
      // insert works again at head shape.
      await expect(insertRefusal({ user_id: userId })).resolves.toBeUndefined()
    } finally {
      client.release()
    }
  })

  it('down() then up() round-trips back to the exact head shape (no drift)', async () => {
    const client = await db.connect()
    try {
      await down(client)
      await up(client)
      expect(await constraintExists('payment_refusals', 'payment_refusals_account_id_fkey')).toBe(true)
      const def = await constraintDef('payment_refusals', 'payment_refusals_reason_check')
      expect(def).toContain('delegation_budget_exceeded')
      expect(def).not.toContain('recipient_not_allowed')
    } finally {
      client.release()
    }
  })
})

describe('migration 086 registration', () => {
  it('exports up, down and a version matching its filename', () => {
    expect(typeof up).toBe('function')
    expect(typeof down).toBe('function')
    expect(version).toBe('086_payment_refusals')
  })
})
