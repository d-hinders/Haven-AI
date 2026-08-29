/**
 * Real-DB eligibility coverage for the passive settlement sweep (#2136,
 * absorbing PR #2134's `erc7710-observer-eligibility.test.ts`).
 *
 * `FIND_SWEEPABLE_ERC7710_INTENTS_SQL` decides which `submitted` intents the
 * sweeper is allowed to complete — i.e. which settled payments it may push
 * into the user's books. Every conjunct of its WHERE clause is a guard against
 * completing the WRONG thing, and the sweeper module ASSUMES all of them: it
 * re-checks none of them before calling `observeErc7710Settlement`. Until now
 * the only execution coverage of this query was migration 072's
 * index-parity test, which seeds two rows differing solely in `tx_hash` and
 * asserts the candidate set is the same with and without the index. That
 * proves the index is neutral, and in passing it exercises two conjuncts —
 * the settled control row is excluded, so `status = 'submitted'` and
 * `tx_hash IS NULL` are covered. The other six are not, and neither is the
 * ordering, the limit, nor the column list. So every guard is exercised here
 * on BOTH sides — the row that must come back and the row that must not —
 * plus the ordering, the limit, and the two bounds the sweeper passes in.
 *
 * Why this file is named for the *sweep* and not the *observer*: #2134 built
 * an "observer" keyed on transfer shape; the design that merged (#2135) is a
 * sweeper keyed on #2094's `delegation_hash`, with a different signature
 * (min-age + recovery horizon, not one max-age) and a different candidate
 * rule. The coverage is ported, not the query it was written against.
 *
 * Zero mocks; real Postgres on the #1220 harness (#1219: assertions about what
 * the database does belong on the real DB).
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import { findSweepableErc7710Intents } from '../x402-authorizations.js'
import {
  SWEEP_MAX_CANDIDATES_PER_TICK,
  SWEEP_MIN_AGE_SECONDS,
  SWEEP_RECOVERY_HORIZON_SECONDS,
} from '../../../modules/x402/settlement-sweeper.js'

/** The bounds a production tick actually passes. */
const PROD_ARGS = [
  SWEEP_MIN_AGE_SECONDS,
  SWEEP_RECOVERY_HORIZON_SECONDS,
  SWEEP_MAX_CANDIDATES_PER_TICK,
] as const

let seq = 0

async function seedOwner(): Promise<{ agentId: string; userId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`sweep-elig-${++seq}-${Date.now()}@test.example`],
  )
  const userId = user.rows[0].id
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, 'sweep elig agent') RETURNING id`,
    [userId],
  )
  return { agentId: agent.rows[0].id, userId }
}

interface IntentSeed {
  agentId: string
  userId: string
  status?: string
  /** `machine_metadata.settlement_scheme`; `null` writes NULL metadata. */
  scheme?: string | null
  executionRail?: string | null
  /** The predicate reads COALESCE(payment_rail, source). */
  source?: string | null
  paymentRail?: string | null
  txHash?: string | null
  delegationHash?: string | null
  /** `created_at` offset from NOW, in seconds (negative = in the past). */
  createdOffsetSec?: number
}

/**
 * An eligible row by default; each field overrides exactly one conjunct, so a
 * test body reads as "the baseline, except <this>".
 */
async function seedIntent(seed: IntentSeed): Promise<string> {
  const metadata =
    seed.scheme === null ? null : JSON.stringify({ settlement_scheme: seed.scheme ?? 'erc7710' })
  const createdOffset = seed.createdOffsetSec ?? -(SWEEP_MIN_AGE_SECONDS + 60)
  const result = await db.query<{ id: string }>(
    `INSERT INTO payment_intents
       (agent_id, user_id, safe_address, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
        status, expires_at, chain_id, source, payment_rail, execution_rail,
        machine_metadata, tx_hash, delegation_hash, created_at)
     VALUES ($1, $2, '0x00000000000000000000000000000000000000f1', 'USDC',
             '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
             '0x00000000000000000000000000000000000000aa',
             '100000', '0.10', '0x00000000000000000000000000000000000000d1',
             0, $3, $4, NOW() + interval '10 minutes', 84532,
             $5, $6, $7, $8::jsonb, $9, $10,
             NOW() + ($11 * interval '1 second'))
     RETURNING id`,
    [
      seed.agentId,
      seed.userId,
      `0x${String(++seq).padStart(64, 'a')}`.slice(0, 66),
      seed.status ?? 'submitted',
      seed.source === undefined ? 'x402' : seed.source,
      seed.paymentRail === undefined ? null : seed.paymentRail,
      seed.executionRail === undefined ? 'delegation' : seed.executionRail,
      metadata,
      seed.txHash ?? null,
      seed.delegationHash === undefined ? `0x${String(seq).padStart(64, 'd')}`.slice(0, 66) : seed.delegationHash,
      createdOffset,
    ],
  )
  return result.rows[0].id
}

async function sweepIds(
  args: readonly [number, number, number] = PROD_ARGS,
): Promise<string[]> {
  const rows = await findSweepableErc7710Intents(args[0], args[1], args[2])
  return rows.map((r) => r.id)
}

describeDb('erc7710 sweep eligibility (#2117 candidate query, absorbed from #2134)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  // `resetDb()` truncates every table in the worker schema, so its cost tracks
  // the migration count, not what this file wrote (#2209). It belongs here and
  // never inside a table-driven loop.
  beforeEach(async () => {
    await resetDb()
  })

  it('POSITIVE CONTROL: a settled-but-unreported erc7710 intent is a candidate under the PRODUCTION bounds', async () => {
    const { agentId, userId } = await seedOwner()
    const id = await seedIntent({ agentId, userId })

    // Not "the query returns something" — the query returns THIS row, under
    // the exact arguments `runSettlementSweepTick` passes. Without this, every
    // exclusion assertion below could pass against a query that returns
    // nothing at all.
    expect(await sweepIds()).toEqual([id])
  })

  it('excludes every row that is not at the exact lifecycle the sweeper can complete', async () => {
    const { agentId, userId } = await seedOwner()
    const eligible = await seedIntent({ agentId, userId })

    // One row per conjunct, each identical to the baseline except the field
    // named. Any conjunct that stopped being enforced shows up as a length
    // mismatch naming a row that should not be sweepable.
    await seedIntent({ agentId, userId, status: 'confirmed' })
    await seedIntent({ agentId, userId, status: 'pending_signature' })
    await seedIntent({ agentId, userId, status: 'failed' })
    await seedIntent({ agentId, userId, txHash: `0x${'b'.repeat(64)}` })
    await seedIntent({ agentId, userId, scheme: 'eip3009' })
    await seedIntent({ agentId, userId, scheme: null })
    await seedIntent({ agentId, userId, executionRail: 'safe' })
    await seedIntent({ agentId, userId, executionRail: null })
    await seedIntent({ agentId, userId, source: 'direct', paymentRail: null })
    await seedIntent({ agentId, userId, delegationHash: null })

    expect(await sweepIds()).toEqual([eligible])
  })

  it('reads the rail through COALESCE(payment_rail, source) — payment_rail wins when present', async () => {
    const { agentId, userId } = await seedOwner()
    // source alone carries the rail on older rows: still sweepable.
    const viaSource = await seedIntent({ agentId, userId, source: 'x402', paymentRail: null })
    // payment_rail present and NOT x402 must exclude the row even though
    // `source` says x402 — a `COALESCE` written the other way round would
    // wrongly sweep this one.
    await seedIntent({ agentId, userId, source: 'x402', paymentRail: 'direct' })
    // …and payment_rail alone is enough when source is something else.
    const viaPaymentRail = await seedIntent({ agentId, userId, source: 'direct', paymentRail: 'x402' })

    expect((await sweepIds()).sort()).toEqual([viaSource, viaPaymentRail].sort())
  })

  it('a pre-#2094 intent (delegation_hash NULL) is excluded — silently, and that is a known consequence', async () => {
    const { agentId, userId } = await seedOwner()
    const bound = await seedIntent({ agentId, userId })
    await seedIntent({ agentId, userId, delegationHash: null })

    // `delegation_hash IS NOT NULL` is a hard requirement of the merged design:
    // the stored child hash IS the lookup key and there is no second path
    // (`requireDelegationBound`). The consequence, raised by PR #2134's author,
    // is that a pre-#2094 row can never be completed passively — AND, because
    // the filter sits in the SQL rather than in the tick, it is never even
    // counted as `unresolved`, so the sweeper's own "log the rest loudly as it
    // ages out" complement does not reach it. Pinned here so the exclusion is
    // a stated decision rather than an accident of the WHERE clause.
    expect(await sweepIds()).toEqual([bound])
  })

  it('holds the minimum age back — a freshly authorized payment is left to its own agent report', async () => {
    const { agentId, userId } = await seedOwner()
    // Younger than the grace: the ordinary evidence report has not had its
    // chance yet, and sweeping now would put the sweep on the happy path.
    await seedIntent({ agentId, userId, createdOffsetSec: -(SWEEP_MIN_AGE_SECONDS - 30) })
    const old = await seedIntent({ agentId, userId, createdOffsetSec: -(SWEEP_MIN_AGE_SECONDS + 30) })
    // A clock-skewed row in the future is younger still.
    await seedIntent({ agentId, userId, createdOffsetSec: 60 })

    expect(await sweepIds()).toEqual([old])
  })

  it('holds the recovery horizon — a payment older than 24h is past recovery, not merely past its window', async () => {
    const { agentId, userId } = await seedOwner()
    // Well past the 600s settlement window but inside the horizon: still
    // sweepable, which is the whole point of separating the two bounds. If the
    // horizon ever collapsed back onto the settlement window (as #2134's
    // 780s max-age did), this row would drop out and an RPC outage spanning a
    // window would again mean permanent invisibility.
    const recoverable = await seedIntent({ agentId, userId, createdOffsetSec: -6 * 60 * 60 })
    await seedIntent({
      agentId,
      userId,
      createdOffsetSec: -(SWEEP_RECOVERY_HORIZON_SECONDS + 600),
    })

    expect(await sweepIds()).toEqual([recoverable])
  })

  it('orders oldest-first and spends the limit on the oldest candidates', async () => {
    const { agentId, userId } = await seedOwner()
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      ids.push(
        await seedIntent({
          agentId,
          userId,
          createdOffsetSec: -(SWEEP_MIN_AGE_SECONDS + 600 - i * 60),
        }),
      )
    }

    // Oldest-first: the candidate nearest the horizon is the one that loses its
    // last chance if a tick runs out of budget, so it must be served first.
    expect(await sweepIds()).toEqual(ids)
    // …and the LIMIT takes the oldest three, not an arbitrary three.
    expect(await sweepIds([SWEEP_MIN_AGE_SECONDS, SWEEP_RECOVERY_HORIZON_SECONDS, 3])).toEqual(
      ids.slice(0, 3),
    )
  })

  it('returns rows already shaped for BOTH consumers, with no reshape in the sweeper', async () => {
    const { agentId, userId } = await seedOwner()
    const id = await seedIntent({ agentId, userId })

    const [row] = await findSweepableErc7710Intents(...PROD_ARGS)
    // `sweepOne` passes the row straight to `observeErc7710Settlement`
    // (`ObservableSettlementIntent`) and reads `delegation_hash`, `chain_id`
    // and `created_at` itself. A column dropped from the SELECT list would be
    // `undefined` at runtime with no type error at the call site, because the
    // row type is declared by hand rather than derived from the SQL — so the
    // column list is pinned by execution here.
    expect(row).toMatchObject({
      id,
      agent_id: agentId,
      status: 'submitted',
      tx_hash: null,
      chain_id: 84532,
      execution_rail: 'delegation',
      token_symbol: 'USDC',
      amount_raw: '100000',
      amount_human: '0.10',
    })
    for (const column of [
      'safe_address',
      'to_address',
      'token_address',
      'delegation_hash',
      'created_at',
      'machine_metadata',
    ] as const) {
      expect(row[column], `column ${column} must be selected`).toBeTruthy()
    }
  })
})
