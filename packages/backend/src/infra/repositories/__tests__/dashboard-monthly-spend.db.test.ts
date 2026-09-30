/**
 * Real-DB proof for `SUM_MONTHLY_PAYMENT_SPEND_SQL`'s SEK fallback predicate
 * (#3195).
 *
 * The claim under test is a claim about what Postgres returns — a CASE
 * predicate over NULL and zero-booked `sek_value` rows — so it belongs on the
 * #1220 harness, not on the `vi.mock('db.js')` dispatcher the characterization
 * suite uses (which proves only what the CALLER does with the rows). Zero
 * mocks. The A/B/C probe is the fixture #3195 measured on a real DB:
 *
 *   A: sek 10.5 booked, usd/eur NULL, amount 1 — priced, SEK never re-priced;
 *   B: sek NULL, usd 2 / eur 1.8 booked, amount 2 — SEK re-priced from NULL;
 *   C: 0/0/0 booked, amount 4 — the `zeroPrice()` shape, re-priced into SEK
 *      by the mirrored zero prong exactly as USD/EUR already re-price it.
 *
 * Under the pre-#3195 NULL-only predicate row C answered fallback_amount_sek
 * 0 while fallback_amount carried 4 — "Monthly agent spend" read LOWER under
 * SEK than under USD for the same rows. Reverting the predicate turns this
 * file red on the row-C assertions: that is the recorded mutation.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import { sumMonthlyPaymentSpend } from '../dashboard.js'

let seq = 0

async function seedUserWithAgent(): Promise<{ userId: string; agentId: string }> {
  const n = ++seq
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`dash-spend-${n}-${Date.now()}@test.example`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'monthly-spend agent') RETURNING id`,
    [user.rows[0].id],
  )
  return { userId: user.rows[0].id, agentId: agent.rows[0].id }
}

/**
 * A confirmed payment intent booked this month, with only the columns the
 * aggregate reads plus the table's required ones (same insert shape the
 * 090/091 migration suite's `seedConfirmedIntent` proves). `usd`/`eur`/`sek`
 * are the booked fiat values (NULL = not captured); `amount` is the token
 * amount.
 */
async function confirmedIntent(
  seed: { userId: string; agentId: string },
  fiat: { usd: string | null; eur: string | null; sek: string | null },
  amount: string,
): Promise<void> {
  const n = ++seq
  await db.query(
    `INSERT INTO payment_intents (
       agent_id, user_id, account_address, token_symbol, token_address,
       to_address, amount_raw, amount_human, delegate_address,
       allowance_nonce, sign_hash, status, confirmed_at, expires_at,
       chain_id, source, payment_rail, execution_rail, machine_metadata,
       usd_value, eur_value, sek_value
     ) VALUES (
       $1, $2, $3, 'USDC',
       '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
       '0x00000000000000000000000000000000000000aa', $4, $5,
       '0x00000000000000000000000000000000000000d1', 1, $6,
       'confirmed', NOW(), NOW() + INTERVAL '10 minutes', 84532,
       'x402', 'x402', 'delegation',
       '{"settlement_scheme":"erc7710"}'::jsonb, $7, $8, $9
     )`,
    [
      seed.agentId,
      seed.userId,
      `0x${String(1e12 + n).padStart(40, '0').slice(-40)}`,
      `${1000000 + n}`,
      amount,
      `0x${String(n).padStart(64, 'a')}`,
      fiat.usd,
      fiat.eur,
      fiat.sek,
    ],
  )
}

describeDb('SUM_MONTHLY_PAYMENT_SPEND_SQL — SEK fallback predicate (#3195)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
    seq = 0
  })

  it('re-prices the zero-booked row into SEK exactly as into USD/EUR (row C)', async () => {
    const seed = await seedUserWithAgent()
    await confirmedIntent(seed, { usd: '0', eur: '0', sek: '0' }, '4')

    const rows = await sumMonthlyPaymentSpend(seed.userId)

    expect(rows).toHaveLength(1)
    expect(rows[0].token_symbol).toBe('USDC')
    expect(rows[0].fallback_amount).toBe('4')
    // The mirrored zero prong — the assertion the pre-#3195 predicate fails
    // with '0' (NULL-only collected nothing for a 0/0/0 row).
    expect(rows[0].fallback_amount_sek).toBe('4')
  })

  it('still collects NULL-sek_value rows and still skips priced rows (rows A + B)', async () => {
    const seed = await seedUserWithAgent()
    // A: booked SEK 10.5, no booked USD/EUR — collected by the USD/EUR
    // bucket alone; the SEK bucket must NOT re-price an already-priced row.
    await confirmedIntent(seed, { usd: null, eur: null, sek: '10.5' }, '1')
    // B: no booked SEK, booked USD/EUR — collected by the SEK bucket alone.
    await confirmedIntent(seed, { usd: '2', eur: '1.8', sek: null }, '2')

    const rows = await sumMonthlyPaymentSpend(seed.userId)

    expect(rows).toHaveLength(1)
    // The booked sums come back as `::TEXT` of a NUMERIC sum — seeded '2'
    // renders '2.000000' — so compare numerically, not as strings. A books
    // sek 10.5; B books usd 2 / eur 1.8.
    expect(Number(rows[0].usd_sum)).toBe(2)
    expect(Number(rows[0].eur_sum)).toBe(1.8)
    expect(Number(rows[0].sek_sum)).toBe(10.5)
    // A's amount through the USD/EUR bucket; B's through the SEK bucket.
    expect(rows[0].fallback_amount).toBe('1')
    expect(rows[0].fallback_amount_sek).toBe('2')
  })

  it('sums booked fiat beside the fallback amounts in one aggregate (A + B + C)', async () => {
    const seed = await seedUserWithAgent()
    await confirmedIntent(seed, { usd: null, eur: null, sek: '10.5' }, '1')
    await confirmedIntent(seed, { usd: '2', eur: '1.8', sek: null }, '2')
    await confirmedIntent(seed, { usd: '0', eur: '0', sek: '0' }, '4')

    const rows = await sumMonthlyPaymentSpend(seed.userId)

    expect(rows).toHaveLength(1)
    expect(Number(rows[0].usd_sum)).toBe(2)
    expect(Number(rows[0].eur_sum)).toBe(1.8)
    expect(Number(rows[0].sek_sum)).toBe(10.5)
    expect(rows[0].fallback_amount).toBe('5')
    expect(rows[0].fallback_amount_sek).toBe('6')
  })

  it('scopes the aggregate to the given user only', async () => {
    const seed = await seedUserWithAgent()
    const other = await seedUserWithAgent()
    await confirmedIntent(seed, { usd: '0', eur: '0', sek: '0' }, '4')
    await confirmedIntent(other, { usd: null, eur: null, sek: null }, '9')

    const rows = await sumMonthlyPaymentSpend(seed.userId)

    expect(rows).toHaveLength(1)
    expect(rows[0].fallback_amount).toBe('4')
    expect(rows[0].fallback_amount_sek).toBe('4')
  })
})
