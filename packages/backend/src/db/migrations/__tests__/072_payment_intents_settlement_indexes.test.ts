/**
 * Real-Postgres proof for the erc7710 settlement indexes (migration 072,
 * #2095). No mocks — #1219's rule: assertions about what the database does
 * belong on the real-DB harness.
 *
 * Two things are at stake and they are different obligations:
 *
 * 1. **The index must be USABLE by the query it was added for.** A partial
 *    expression index the planner cannot match is a maintenance cost with no
 *    benefit, and the failure is silent — the query keeps working, slowly.
 *    So the definitions are pinned by their `pg_indexes` text, mirroring the
 *    exact `LOWER(...)` / `IS NOT NULL` / `status = 'submitted'` shapes the
 *    production SQL uses. (Whether the planner then *chooses* it is a
 *    cost-model question that needs a realistically sized table; that
 *    measurement is in the PR body, not here — a plan captured against the
 *    handful of rows a unit test seeds proves nothing either way.)
 * 2. **The index must change NOTHING about what the guards refuse.** This is
 *    the acceptance criterion #2095 states as "no behaviour change", and it
 *    is asserted by execution: the replay guard is driven to its refusal with
 *    the index present and again with it dropped, and the outcome must be
 *    identical.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { confirmObservedSettlement } from '../../../infra/repositories/x402-authorizations.js'
import { up, down, version } from '../072_payment_intents_settlement_indexes.js'

const TX_HASH_INDEX = 'idx_payment_intents_tx_hash_lower'
const SWEEP_INDEX = 'idx_payment_intents_open_submitted_created_at'

async function indexDefs(): Promise<Record<string, string>> {
  const { rows } = await db.query<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = 'payment_intents'`,
  )
  return Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]))
}

let seq = 0

async function seedIntent(txHash: string | null): Promise<{ id: string; agentId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`idx072-${++seq}-${Date.now()}@test.example`],
  )
  const userId = user.rows[0].id
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'index agent') RETURNING id`,
    [userId],
  )
  const agentId = agent.rows[0].id
  const intent = await db.query<{ id: string }>(
    `INSERT INTO payment_intents
       (agent_id, user_id, safe_address, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
        status, expires_at, tx_hash, chain_id, source, payment_rail, execution_rail,
        machine_metadata)
     VALUES ($1, $2, '0x00000000000000000000000000000000000000f1', 'USDC',
             '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
             '0x00000000000000000000000000000000000000c1',
             '100000', '0.10', '0x00000000000000000000000000000000000000d1',
             0, '0xsign',
             CASE WHEN $3::text IS NULL THEN 'submitted' ELSE 'confirmed' END,
             NOW() + interval '10 minutes', $3, 84532, 'x402', 'x402', 'delegation',
             '{"settlement_scheme":"erc7710"}'::jsonb)
     RETURNING id`,
    [agentId, userId, txHash],
  )
  return { id: intent.rows[0].id, agentId }
}

describeDb('migration 072: payment_intents settlement indexes (#2095)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
    // Rebuild from THIS file's own DDL, every body. `resetDb` truncates rows
    // and never touches DDL, so without the drop the assertions below would
    // read whatever the migration RUNNER left in the worker schema — and
    // `up()`'s `IF NOT EXISTS` would make a mutated definition a silent no-op.
    // Proven by mutation: with the drop, breaking `up()` fails these tests;
    // without it, they passed against the stale index.
    await down(db as never)
    await up(db as never)
  })

  it('both indexes exist once the migration set has run', async () => {
    const defs = await indexDefs()
    expect(Object.keys(defs)).toEqual(expect.arrayContaining([TX_HASH_INDEX, SWEEP_INDEX]))
  })

  it('the tx_hash index mirrors the replay guard: LOWER() expression, partial on IS NOT NULL', async () => {
    const def = (await indexDefs())[TX_HASH_INDEX]
    // The expression and the predicate must both match the query or the
    // planner will not use it. Asserted separately so a failure says which
    // half drifted.
    expect(def).toMatch(/\(lower\(\(tx_hash\)::text\)\)/i)
    expect(def).toMatch(/WHERE \(tx_hash IS NOT NULL\)/i)
    // NOT unique — deliberately (#2095): a unique index would retroactively
    // constrain historical rows. The guard stays a query-level NOT EXISTS.
    expect(def).not.toMatch(/CREATE UNIQUE INDEX/i)
  })

  it("the sweep index is keyed on created_at and partial on the sweeper's open-intent predicate", async () => {
    const def = (await indexDefs())[SWEEP_INDEX]
    // created_at as the KEY, not merely in the predicate: that is what lets
    // the candidate query's ORDER BY created_at + LIMIT terminate early.
    expect(def).toMatch(/\(created_at\)/)
    expect(def).toMatch(/WHERE \(\(\(status\)::text = 'submitted'::text\) AND \(tx_hash IS NULL\)\)/i)
  })

  it('up() is idempotent — a second run against existing indexes does not error', async () => {
    await up(db as never)
    await up(db as never)
    const defs = await indexDefs()
    expect(defs[TX_HASH_INDEX]).toBeDefined()
    expect(defs[SWEEP_INDEX]).toBeDefined()
  })

  // ── Reversibility. ───────────────────────────────────────────────────────

  it('down() drops both and up() recreates them byte-identically', async () => {
    const before = await indexDefs()

    await down(db as never)
    const dropped = await indexDefs()
    expect(dropped[TX_HASH_INDEX]).toBeUndefined()
    expect(dropped[SWEEP_INDEX]).toBeUndefined()
    // Nothing else on the table was collateral damage.
    expect(Object.keys(dropped).sort()).toEqual(
      Object.keys(before)
        .filter((n) => n !== TX_HASH_INDEX && n !== SWEEP_INDEX)
        .sort(),
    )

    await up(db as never)
    expect(await indexDefs()).toEqual(before)

    // down() twice is safe too — an operator rolling back a rollback.
    await down(db as never)
    await down(db as never)
    expect((await indexDefs())[TX_HASH_INDEX]).toBeUndefined()
    await up(db as never)
  })

  // ── No behaviour change: the point of the whole migration. ───────────────

  it('the replay guard refuses the SAME hash whether the index is present or absent', async () => {
    async function refusalOutcome(): Promise<{ replayed: boolean; fresh: boolean }> {
      await resetDb()
      const HASH = `0x${'a'.repeat(64)}`
      // One intent already owns the hash; a second, otherwise-confirmable one
      // must be refused by the replay guard.
      await seedIntent(HASH)
      const victim = await seedIntent(null)
      const replayed = await confirmObservedSettlement({
        intentId: victim.id,
        agentId: victim.agentId,
        txHash: HASH,
        usdValue: null,
        eurValue: null,
        windowSeconds: 840,
        delegationBound: false,
      })
      // And the control: an unclaimed hash on the same row still confirms, so
      // a "refused" result is the guard and not a broken fixture.
      const other = await seedIntent(null)
      const fresh = await confirmObservedSettlement({
        intentId: other.id,
        agentId: other.agentId,
        txHash: `0x${'b'.repeat(64)}`,
        usdValue: null,
        eurValue: null,
        windowSeconds: 840,
        delegationBound: false,
      })
      return { replayed, fresh }
    }

    const withIndex = await refusalOutcome()
    await down(db as never)
    const withoutIndex = await refusalOutcome()
    await up(db as never)

    expect(withIndex).toEqual({ replayed: false, fresh: true })
    expect(withoutIndex).toEqual(withIndex)
  })
})

describe('migration 072 registration', () => {
  it('exports up, down and a version matching its filename', () => {
    expect(typeof up).toBe('function')
    expect(typeof down).toBe('function')
    expect(version).toBe('072_payment_intents_settlement_indexes')
  })
})
