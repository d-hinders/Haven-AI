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
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import {
  findEvidenceOrphanedErc7710Intents,
  findSweepableErc7710Intents,
} from '../x402-authorizations.js'
import { insertMachineIntent } from '../payment-intents.js'
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

/** A minimal `machine_payment_evidence` row — enough to satisfy the NOT NULLs. */
async function seedEvidence(intentId: string, agentId: string, userId: string): Promise<void> {
  await db.query(
    `INSERT INTO machine_payment_evidence
       (payment_intent_id, agent_id, user_id, rail, tx_hash, chain_id, resource_url,
        payer_address, settlement_address, token_symbol, token_address,
        amount_raw, amount_human)
     VALUES ($1, $2, $3, 'x402', $4, 84532, 'https://merchant.example/paid',
             '0x00000000000000000000000000000000000000f1',
             '0x00000000000000000000000000000000000000aa', 'USDC',
             '0x036cbd53842c5426634e7929541ec2318f3dcf7e', '100000', '0.10')`,
    [intentId, agentId, userId, `0x${String(++seq).padStart(64, 'e')}`.slice(0, 66)],
  )
}

async function orphanIds(
  args: readonly [number, number, number] = PROD_ARGS,
): Promise<string[]> {
  const rows = await findEvidenceOrphanedErc7710Intents(args[0], args[1], args[2])
  return rows.map((r) => r.id)
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

  it('a delegation_hash NULL row is excluded — silently, upstream of every counter and log', async () => {
    const { agentId, userId } = await seedOwner()
    const bound = await seedIntent({ agentId, userId })
    await seedIntent({ agentId, userId, delegationHash: null })

    // `delegation_hash IS NOT NULL` is a hard requirement of the merged design:
    // the stored child hash IS the lookup key and there is no second path
    // (`requireDelegationBound`). @PhilipEriksson raised the consequence on PR
    // #2134: because the filter sits in the SQL rather than in the tick, an
    // excluded row is never even counted as `unresolved`, so the sweeper's own
    // "log the rest loudly as it ages out" complement does not reach it.
    //
    // #2214 corrects this test's ORIGINAL title, which called the seeded row "a
    // pre-#2094 intent". It is not one. `delegation_hash` has been written by
    // the erc7710 authorize path since #830 introduced that path (2026-07-10),
    // not since #2094 (2026-08-27) — what #2094 changed is the child's SALT, so
    // a pre-#2094 intent carries the OLD constant-salt hash, is a candidate, is
    // scanned, and is counted and logged like any other. The row below is
    // seeded by raw INSERT and no production writer can produce it; the two
    // tests under "#2214" at the end of this file pin exactly that. So what
    // this test pins is the SQL's behaviour on a shape that must stay
    // unreachable — not a live population.
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
  // ── #2213: the recovery query, the complement of the one above ──────────
  //
  // `FIND_EVIDENCE_ORPHANED_ERC7710_INTENTS_SQL` is what makes a failed
  // evidence write recoverable rather than permanent. The forward query above
  // demands `status = 'submitted' AND tx_hash IS NULL`; this one demands the
  // exact opposite pair plus "no evidence row", so between them a settled
  // erc7710 payment is in one working set or the other until it is booked.
  // That complementarity is the guarantee, so it is asserted as one.

  it('POSITIVE CONTROL: a confirmed erc7710 intent with no evidence row is a recovery candidate under the PRODUCTION bounds', async () => {
    const { agentId, userId } = await seedOwner()
    const orphan = await seedIntent({
      agentId, userId, status: 'confirmed', txHash: `0x${'c'.repeat(64)}`,
    })
    // The same row WITH its evidence row is not an orphan — without this half,
    // every completed payment would be re-fed to the accounting tool forever.
    const booked = await seedIntent({
      agentId, userId, status: 'confirmed', txHash: `0x${'d'.repeat(64)}`,
    })
    await seedEvidence(booked, agentId, userId)

    expect(await orphanIds()).toEqual([orphan])
    // …and it is NOT in the forward set: that is precisely why a confirm with
    // a failed evidence write used to be unreachable by every retry path.
    expect(await sweepIds()).toEqual([])
  })

  it('excludes every row that is not a settled, unbooked erc7710 payment inside the horizon', async () => {
    const { agentId, userId } = await seedOwner()
    const CONFIRMED = { status: 'confirmed', txHash: `0x${'c'.repeat(64)}` }
    const orphan = await seedIntent({ agentId, userId, ...CONFIRMED })

    // One row per conjunct, each the baseline except the field named.
    await seedIntent({ agentId, userId, status: 'submitted', txHash: null })
    // A SUBMITTED intent that already carries a hash — the eip3009 in-flight
    // state `MARK_INTENT_SUBMITTED_FOR_SETTLEMENT_SQL` writes. It is excluded by
    // `status = 'confirmed'` ALONE, so without this row that conjunct is masked
    // by `tx_hash IS NOT NULL` and a widened status predicate survives. Booking
    // evidence for it would put money in the accounts before Haven has verified
    // the settlement — the one thing worse than a missing row.
    await seedIntent({ agentId, userId, status: 'submitted', txHash: `0x${'a'.repeat(64)}` })
    await seedIntent({ agentId, userId, status: 'failed', txHash: `0x${'c'.repeat(64)}` })
    await seedIntent({ agentId, userId, status: 'confirmed', txHash: null })
    await seedIntent({ agentId, userId, ...CONFIRMED, scheme: 'eip3009' })
    await seedIntent({ agentId, userId, ...CONFIRMED, scheme: null })
    await seedIntent({ agentId, userId, ...CONFIRMED, executionRail: 'safe' })
    await seedIntent({ agentId, userId, ...CONFIRMED, source: 'direct', paymentRail: null })
    await seedIntent({ agentId, userId, ...CONFIRMED, createdOffsetSec: -(SWEEP_MIN_AGE_SECONDS - 30) })
    await seedIntent({
      agentId, userId, ...CONFIRMED,
      createdOffsetSec: -(SWEEP_RECOVERY_HORIZON_SECONDS + 600),
    })
    // Deliberately NOT excluded: `delegation_hash IS NULL`. The forward query
    // needs the hash as its lookup key; recovery needs nothing from the chain,
    // so a pre-#2094 payment that WAS confirmed by an agent report and lost its
    // evidence write is recoverable here. Narrowing this to sweep-confirmed
    // rows would make recovery depend on which path dug the hole.
    const preSalt = await seedIntent({ agentId, userId, ...CONFIRMED, delegationHash: null })

    expect((await orphanIds()).sort()).toEqual([orphan, preSalt].sort())
  })

  // ── #2214: what makes the NULL-hash silence harmless ─────────────────────
  //
  // `delegation_hash IS NOT NULL` sits in the forward query's WHERE clause,
  // upstream of `sweepOne`, so anything it removes is excluded from BOTH halves
  // of the module's stated design — not completed, and not counted or logged as
  // residue either. @PhilipEriksson raised that on PR #2134 and #2136 pinned
  // the behaviour. What makes it acceptable is not a policy but an INVARIANT:
  // no writer can produce such a row, so the conjunct removes nothing. An
  // invariant that nothing checks is one refactor from being false and silent,
  // which is the precise failure mode this whole line of issues is about, so it
  // is checked here — from both directions.

  it('POSITIVE CONTROL: the real erc7710 writer produces a row the candidate query returns', async () => {
    const { agentId, userId } = await seedOwner()
    const childHash = `0x${'7'.repeat(64)}`

    // `delegation-authorize.ts`'s own argument object, trimmed to the fields
    // this invariant is about. The point is that `settlement_scheme: 'erc7710'`
    // and `delegationHash` enter through ONE call and land in ONE INSERT, so
    // the first can never be persisted without the second.
    const row = await insertMachineIntent({
      agent: {
        id: agentId,
        user_id: userId,
        safe_address: '0x00000000000000000000000000000000000000f1',
        chain_id: 84532,
        delegate_address: '0x00000000000000000000000000000000000000d1',
      },
      rail: 'x402',
      payTo: '0x00000000000000000000000000000000000000aa',
      tokenSymbol: 'USDC',
      tokenAddress: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
      amountRaw: 100000n,
      amountHuman: '0.10',
      allowanceNonce: 0,
      signHash: childHash,
      resourceUrl: 'https://merchant.example/paid',
      category: null,
      merchantAddress: '0x00000000000000000000000000000000000000aa',
      challengeId: null,
      idempotencyKey: `sweep-2214-${++seq}`,
      metadata: { network: 'base-sepolia', settlement_scheme: 'erc7710' },
      executionRail: 'delegation',
      delegationHash: childHash,
      budgetDelegationHash: `0x${'b'.repeat(64)}`,
      preparedUserOp: '{}',
      conflictTarget: 'x402_idempotency_key',
    })
    expect(row, 'the writer must have inserted a row').not.toBeNull()

    const stored = await db.query<{ delegation_hash: string | null; scheme: string | null }>(
      `SELECT delegation_hash, machine_metadata->>'settlement_scheme' AS scheme
         FROM payment_intents WHERE id = $1`,
      [row!.id],
    )
    expect(stored.rows[0].scheme).toBe('erc7710')
    expect(stored.rows[0].delegation_hash, 'the erc7710 writer must persist a lookup key').toBe(
      childHash,
    )

    // Lifecycle only. The writer inserts at `pending_signature`, and the sweep
    // acts on `submitted` past its grace; neither column under test is touched.
    await db.query(
      `UPDATE payment_intents
          SET status = 'submitted', created_at = NOW() - ($2 * interval '1 second')
        WHERE id = $1`,
      [row!.id, SWEEP_MIN_AGE_SECONDS + 60],
    )

    // The control that matters: every exclusion assertion in this file is also
    // satisfied by a query that returns nothing, and the silence at issue is
    // precisely a set that reports zero forever. This says the instrument can
    // still say YES about a row the PRODUCTION writer built.
    expect(await sweepIds()).toEqual([row!.id])
  })
})

/**
 * The other direction, and the one that actually catches the regression: no DB,
 * because the risk is a SECOND writer of `settlement_scheme: 'erc7710'` added
 * without a `delegationHash`. Such a writer breaks no type (the field is
 * optional on `NewMachineIntent`), fails no query, and produces payments the
 * sweep drops in SQL without counting or logging them — the exact silence
 * #2214 describes, arriving through the door the invariant currently blocks.
 *
 * The enclosing call is delimited by PAREN DEPTH, not by a line regex. The
 * first draft matched the closing `})` on its own line, which the independent
 * reviewer defeated with the idiomatic two-argument form
 * `insertMachineIntent({ … }, db)`: `}, db)` never matched, the forward walk ran
 * past the end of the call, and a `delegationHash:` belonging to some LATER
 * function in the same file marked the writer bound. That is a false GREEN in
 * exactly the shape this guard exists to catch — a transactional erc7710 writer
 * is the natural next one to be added — so the boundary is now computed rather
 * than recognised, and a call whose extent cannot be resolved is reported as
 * UNBOUND (a red) instead of scanned past.
 */
describe('#2214: every production writer of settlement_scheme=erc7710 also writes delegation_hash', () => {
  const SRC = fileURLToPath(new URL('../../../', import.meta.url))
  const SCHEME_WRITE = /settlement_scheme\s*:\s*'erc7710'/
  /** Prose quoting the literal is not a writer — this rule is documented. */
  const COMMENT = /^\s*(\/\/|\*|\/\*)/
  const CALL_NAME = /\b(createPaymentIntent|insertMachineIntent)\s*\($/

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full)
      return entry.isFile() && full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : []
    })
  }

  /**
   * The character range of the intent-insert call enclosing `at`, or null when
   * there is none. Null is a FAILURE for the caller, never a pass: "I could not
   * work out which call this belongs to" and "it sets delegationHash" are
   * different answers, and only one of them is safe.
   */
  function enclosingCall(src: string, at: number): { from: number; to: number } | null {
    // Nearest `insertMachineIntent(` / `createPaymentIntent(` at or before the
    // match. Its `(` opens the call.
    let open = -1
    for (let i = at; i >= 0; i--) {
      if (src[i] === '(' && CALL_NAME.test(src.slice(Math.max(0, i - 40), i + 1))) {
        open = i
        break
      }
    }
    if (open === -1) return null

    // Forward to the paren that closes it. This is what the reviewer's
    // `}, db)` case needs: the call ends at its own `)`, wherever the argument
    // object happened to end.
    let depth = 0
    for (let i = open; i < src.length; i++) {
      if (src[i] === '(') depth += 1
      else if (src[i] === ')') {
        depth -= 1
        if (depth === 0) {
          // The backward walk can land on an unrelated earlier call; if the
          // match is not actually inside this one, we have not found it.
          return at > open && at < i ? { from: open, to: i } : null
        }
      }
    }
    return null
  }

  it('finds the writers, and each one is inside an intent insert that sets delegationHash', () => {
    const writers: { file: string; line: number; boundToHash: boolean }[] = []

    for (const file of sourceFiles(SRC)) {
      const src = readFileSync(file, 'utf8')
      const lines = src.split('\n')
      let offset = 0
      lines.forEach((text, i) => {
        const lineStart = offset
        offset += text.length + 1
        if (!SCHEME_WRITE.test(text) || COMMENT.test(text)) return

        const call = enclosingCall(src, lineStart + text.search(SCHEME_WRITE))
        writers.push({
          file: file.slice(SRC.length),
          line: i + 1,
          boundToHash:
            call !== null && /\bdelegationHash\s*:/.test(src.slice(call.from, call.to + 1)),
        })
      })
    }

    // Positive control on the scanner itself. A walk that matched nothing —
    // a moved directory, a renamed literal — would otherwise pass the
    // assertion below vacuously, which is the same always-reports-zero defect
    // the invariant exists to prevent.
    expect(writers.length, 'the scan must actually find the erc7710 writer').toBeGreaterThan(0)

    expect(
      writers.filter((w) => !w.boundToHash),
      'an erc7710 intent written without delegationHash is dropped by the sweep candidate query ' +
        'in SQL — never completed, and never counted or logged as residue either (#2214)',
    ).toEqual([])
  })

  it('resolves the two-argument call form the first draft scanned straight past', () => {
    // The reviewer's counterexample, as a fixture rather than as a mutation, so
    // the boundary bug cannot come back silently. Both shapes must be judged on
    // their OWN argument object: the first has no `delegationHash` and the
    // trailing `delegationHash:` belongs to a later function, which is exactly
    // what the line-regex version credited it with.
    const src = [
      `await insertMachineIntent({`,
      `  metadata: { settlement_scheme: 'erc7710' },`,
      `}, db)`,
      ``,
      `function unrelated() {`,
      `  return insertMachineIntent({ delegationHash: other, metadata: {} })`,
      `}`,
    ].join('\n')

    const at = src.indexOf("settlement_scheme: 'erc7710'")
    const call = enclosingCall(src, at)
    expect(call, 'the two-argument call must still resolve').not.toBeNull()
    expect(
      /\bdelegationHash\s*:/.test(src.slice(call!.from, call!.to + 1)),
      'the later function\'s delegationHash must not count for this writer',
    ).toBe(false)

    // …and the same scanner still says YES when the hash really is there, so
    // "reports unbound, always" cannot pass either.
    const bound = `await insertMachineIntent({\n  metadata: { settlement_scheme: 'erc7710' },\n  delegationHash: h,\n}, db)`
    const boundAt = bound.indexOf("settlement_scheme: 'erc7710'")
    const boundCall = enclosingCall(bound, boundAt)
    expect(boundCall).not.toBeNull()
    expect(/\bdelegationHash\s*:/.test(bound.slice(boundCall!.from, boundCall!.to + 1))).toBe(true)
  })
})
