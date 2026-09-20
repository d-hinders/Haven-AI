/**
 * Real-Postgres proof for migration 090 — the display-side SEK columns
 * (#3127 round 2) — and migration 091 — the stored preference catching up to
 * the documented default (owner decision, Antonio, 2026-09-20 (proposed by
 * Philip 2026-09-19)). No mocks — #1219's
 * rule.
 *
 * The harness applies the FULL migration set, so by the time a test body
 * runs both migrations are already applied at head shape. The 090 tests run
 * their backfill semantics against `withMigrationReverted`, which doubles as
 * the structural-reversibility proof, same convention as every migration
 * test in this directory. 091 is data + a column default, so its tests drive
 * up()/down() the same way.
 *
 * What this file pins, per the review's acceptance criteria:
 *
 *  090 backfill (`UPDATE … FROM machine_payment_evidence`):
 *   - a confirmed intent with evidence `amount_sek` gets that exact frozen
 *     book-time value;
 *   - the backfill is IDEMPOTENT and never overwrites: a row already holding
 *     `sek_value` keeps its own figure even when the evidence row says
 *     something else (the `pi.sek_value IS NULL` gate);
 *   - evidence with a NULL `amount_sek` (the partial-capture case 082
 *     documents) is skipped, not zero-filled — a missing figure is never
 *     invented;
 *   - `down()` drops all three columns cleanly and `up()` round-trips.
 *
 *  091 (stored preference):
 *   - every inherited `'USD'` row becomes NULL — including the boundary case
 *     of a user who explicitly chose USD after round 1, which the data
 *     cannot distinguish (the stated owner-decision consequence);
 *   - rows that already hold an explicit non-USD preference ('EUR') are left
 *     alone;
 *   - the column default is 'SEK' after `up()` and 'USD' again after
 *     `down()` — and `down()` deliberately does NOT re-stamp the NULLed
 *     rows;
 *   - the read path reaches the documented SEK fallback for NULL rows
 *     (`transactionCurrencyOrDefault`), and the signup INSERT writes the
 *     default explicitly.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../../db.js'
import { assertWorkerSchemaAtHead, describeDb, initDbHarness, resetDb, withMigrationReverted } from '../../../infra/__tests__/helpers/db-harness.js'
import { DEFAULT_TRANSACTION_CURRENCY, transactionCurrencyOrDefault } from '../../../domain/transaction-currency.js'
import { INSERT_USER_SQL, findCurrencyPreference } from '../../../infra/repositories/users.js'
import { down as down090, up as up090, version as version090 } from '../090_display_currency_sek.js'
import { down as down091, up as up091, version as version091 } from '../091_user_currency_preference_sek_default.js'

async function columnDefault(table: string, column: string): Promise<string | null> {
  const { rows } = await db.query<{ column_default: string | null }>(
    `SELECT column_default FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
    [table, column],
  )
  return rows[0]?.column_default ?? null
}

async function columnNullable(table: string, column: string): Promise<boolean | null> {
  const { rows } = await db.query<{ is_nullable: string }>(
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
    [table, column],
  )
  if (rows.length === 0) return null
  return rows[0].is_nullable === 'YES'
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

let seq = 0
async function seedUser(currencyPreference: string | null = null): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, currency_preference)
     VALUES ($1, 'x', $2) RETURNING id`,
    [`sek-migrations-${seq++}-${Date.now()}-${Math.random()}@test.example`, currencyPreference],
  )
  return rows[0].id
}

async function seedAgent(userId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, $2) RETURNING id`,
    [userId, `sek-migrations-agent-${seq++}`],
  )
  return rows[0].id
}

/** Address must be unique per row: `(user_id, account_address, chain_id)` is UNIQUE. */
function fakeAddress(n: number): string {
  return `0x${String(n).padStart(40, '0')}`
}

async function seedConfirmedIntent(userId: string, agentId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO payment_intents
       (agent_id, user_id, account_address, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
        status, expires_at, chain_id, source, payment_rail, execution_rail,
        machine_metadata)
     VALUES ($1, $2, $3, 'USDC',
             '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
             '0x00000000000000000000000000000000000000c1',
             '100000', '0.10', '0x00000000000000000000000000000000000000d1',
             0, '0xsign', 'confirmed', NOW() + interval '10 minutes', 84532,
             'x402', 'x402', 'delegation',
             '{"settlement_scheme":"erc7710"}'::jsonb)
     RETURNING id`,
    [agentId, userId, fakeAddress(Math.floor(Math.random() * 1e12))],
  )
  return rows[0].id
}

/** The ONE evidence row per intent: `UNIQUE(payment_intent_id)` makes the backfill join safe. */
async function seedEvidence(
  intentId: string,
  userId: string,
  agentId: string,
  amountSek: string | null,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO machine_payment_evidence
       (payment_intent_id, agent_id, user_id, rail, proof_status, tx_hash, chain_id, resource_url,
        payer_address, settlement_address, token_symbol, token_address,
        amount_raw, amount_human, amount_sek, confirmed_at)
     VALUES ($1, $2, $3, 'x402', 'payment_confirmed', $4, 84532, 'https://merchant.example/paid',
             $5, $6, 'USDC',
             '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
             '100000', '0.10', $7, NOW())
     RETURNING id`,
    [
      intentId,
      agentId,
      userId,
      `0x${Math.floor(Math.random() * 1e12).toString(16).padStart(64, '0')}`,
      fakeAddress(Math.floor(Math.random() * 1e12) + 1),
      fakeAddress(Math.floor(Math.random() * 1e12) + 2),
      amountSek,
    ],
  )
  return rows[0].id
}

async function intentSekValue(intentId: string): Promise<string | null> {
  const { rows } = await db.query<{ sek_value: string | null }>(
    `SELECT sek_value FROM payment_intents WHERE id = $1`,
    [intentId],
  )
  return rows[0]?.sek_value ?? null
}

describeDb('migration 090 + 091: display-currency SEK columns and the stored-preference default (#3127)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  // This file hand-drives down()/up() below; the guard catches a leaked
  // schema mutation from this file or an earlier one.
  afterAll(assertWorkerSchemaAtHead)

  beforeEach(async () => {
    await resetDb()
  })

  it('registers both migrations under their own version strings', () => {
    expect(version090).toBe('090_display_currency_sek')
    expect(version091).toBe('091_user_currency_preference_sek_default')
  })

  // ── 090: the three columns ──────────────────────────────────────────────

  it('090 adds the three nullable SEK columns at head shape', async () => {
    expect(await columnExists('payment_intents', 'sek_value')).toBe(true)
    expect(await columnExists('user_daily_portfolio_snapshots', 'total_sek')).toBe(true)
    expect(await columnExists('payment_refusals', 'sek_value')).toBe(true)
    // Nullable like the usd/eur siblings: unpriced rows stay NULL and are
    // excluded by the aggregates' COALESCE arithmetic — never counted as 0.
    expect(await columnNullable('payment_intents', 'sek_value')).toBe(true)
    expect(await columnNullable('user_daily_portfolio_snapshots', 'total_sek')).toBe(true)
    expect(await columnNullable('payment_refusals', 'sek_value')).toBe(true)
  })

  // ── 090: the evidence backfill ──────────────────────────────────────────

  it('090 backfills sek_value from evidence amount_sek for rows with none', async () => {
    const userId = await seedUser()
    const agentId = await seedAgent(userId)
    const intentId = await seedConfirmedIntent(userId, agentId)
    await seedEvidence(intentId, userId, agentId, '10.5000')

    // Head already ran 090, so the row is backfilled the moment it exists;
    // the semantic proof runs with 090 reverted (columns gone) and re-applied.
    await withMigrationReverted(
      () => down090(db as never),
      async () => {
        expect(await columnExists('payment_intents', 'sek_value')).toBe(false)
        await up090(db as never)
        // NUMERIC(20,6) renders six-decimal scale — the frozen evidence
        // figure at the destination column's scale.
        expect(await intentSekValue(intentId)).toBe('10.500000')
      },
      () => up090(db as never),
    )
  })

  it('090 is idempotent and never overwrites an existing sek_value', async () => {
    const userId = await seedUser()
    const agentId = await seedAgent(userId)
    const intentId = await seedConfirmedIntent(userId, agentId)
    await seedEvidence(intentId, userId, agentId, '10.5000')

    await withMigrationReverted(
      () => down090(db as never),
      async () => {
        await up090(db as never)
        expect(await intentSekValue(intentId)).toBe('10.500000')

        // The evidence row now disagrees with the booked figure — the
        // backfill gate (`pi.sek_value IS NULL`) must refuse to move it.
        await db.query(
          `UPDATE machine_payment_evidence SET amount_sek = '99.0000' WHERE payment_intent_id = $1`,
          [intentId],
        )
        await up090(db as never)
        expect(await intentSekValue(intentId)).toBe('10.500000')
      },
      () => up090(db as never),
    )
  })

  it('090 skips evidence with a NULL amount_sek — a missing figure is never invented', async () => {
    const userId = await seedUser()
    const agentId = await seedAgent(userId)
    const intentId = await seedConfirmedIntent(userId, agentId)
    await seedEvidence(intentId, userId, agentId, null)

    await withMigrationReverted(
      () => down090(db as never),
      async () => {
        await up090(db as never)
        expect(await intentSekValue(intentId)).toBeNull()
      },
      () => up090(db as never),
    )
  })

  it('090 down() drops all three columns and up() round-trips', async () => {
    await withMigrationReverted(
      () => down090(db as never),
      async () => {
        expect(await columnExists('payment_intents', 'sek_value')).toBe(false)
        expect(await columnExists('user_daily_portfolio_snapshots', 'total_sek')).toBe(false)
        expect(await columnExists('payment_refusals', 'sek_value')).toBe(false)
        await up090(db as never)
        expect(await columnExists('payment_intents', 'sek_value')).toBe(true)
      },
      () => up090(db as never),
    )
  })

  // ── 091: the stored preference catches up to the documented default ─────

  it('091 NULLs every inherited USD row — including one explicitly chosen before the data could distinguish', async () => {
    const inherited = await seedUser('USD')
    const chosen = await seedUser('USD')
    const untouched = await seedUser('EUR')

    await withMigrationReverted(
      () => down091(db as never),
      async () => {
        // Re-stage the pre-091 state: head already applied 091, so the rows
        // seeded above were written with the SEK default in place.
        await db.query(`UPDATE users SET currency_preference = 'USD' WHERE id = ANY($1)`, [
          [inherited, chosen],
        ])
        await db.query(`UPDATE users SET currency_preference = 'EUR' WHERE id = $1`, [untouched])

        await up091(db as never)

        expect(await findCurrencyPreference(inherited)).toBeNull()
        // The owner decision's stated consequence: an explicit pre-091 USD
        // choice is indistinguishable from the inherited literal and
        // silently switches to the SEK default (clickable back in the UI).
        expect(await findCurrencyPreference(chosen)).toBeNull()
        expect(await findCurrencyPreference(untouched)).toBe('EUR')
      },
      () => up091(db as never),
    )
  })

  it('091 realigns the column default to SEK and down() restores USD without re-stamping rows', async () => {
    const userId = await seedUser('USD')

    await withMigrationReverted(
      () => down091(db as never),
      async () => {
        await db.query(`UPDATE users SET currency_preference = 'USD' WHERE id = $1`, [userId])
        await up091(db as never)

        const def = await columnDefault('users', 'currency_preference')
        expect(def).toContain("'SEK'")

        await down091(db as never)
        // The default restores…
        const defAfterDown = await columnDefault('users', 'currency_preference')
        expect(defAfterDown).toContain("'USD'")
        // …but the migrated row is NOT re-stamped: it was NULLed by up091
        // earlier in this body and down() leaves it NULL — re-fabricating
        // 'USD' from NULL would re-create the inherited-not-chosen state 091
        // exists to remove. The restore's up091 re-runs are no-ops on NULL.
        expect(await findCurrencyPreference(userId)).toBeNull()
      },
      () => up091(db as never),
    )
  })

  it('after 091 a NULL preference reaches the documented SEK fallback on the read path', async () => {
    const userId = await seedUser(null)

    expect(await findCurrencyPreference(userId)).toBeNull()
    expect(transactionCurrencyOrDefault(await findCurrencyPreference(userId))).toBe(
      DEFAULT_TRANSACTION_CURRENCY,
    )
    expect(DEFAULT_TRANSACTION_CURRENCY).toBe('SEK')
  })

  it('the signup INSERT writes the documented default explicitly', async () => {
    // INSERT_USER_SQL names the column and binds DEFAULT_TRANSACTION_CURRENCY
    // (the repository constant) — pinned here as a string so a revert to the
    // pre-#3127 column-less INSERT cannot pass silently.
    expect(INSERT_USER_SQL).toContain('currency_preference')
  })
})
