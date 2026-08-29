/**
 * Passport issuance is delegation-rail only (#2138, epic #1440).
 *
 * Owner decision, 2026-08-27: *"we should not support issuance on legacy
 * rails."* Existing passports are left alone; only NEW issuance is gated.
 *
 * `infra/repositories/**` is on the money-path perimeter, so per `money.md` §2
 * the CURRENT behaviour of `listRetryable` is characterized here BEFORE it
 * changes, and the claim is about what a SQL statement returns, so it runs on
 * the real-Postgres harness rather than against a mock (epic #1219).
 *
 * ## Why `listRetryable` has to change at all
 *
 * The gate lives in `issuePassport`. The retry sweep calls that for every
 * non-anchored row, every tick. Gate without touching the query and a legacy
 * row fails forever, climbing `attempts` until it trips
 * `ISSUANCE_ATTENTION_ATTEMPTS` and alarms an operator about a refusal that is
 * working exactly as designed.
 *
 * The revoked-agent guard already solved this problem (#1043 finding 3):
 * `markFailed` plus an exclusion in this query, so the row stops churning.
 * This follows that precedent rather than inventing a second mechanism — and
 * the first test below pins that precedent still holds, so a future change
 * cannot quietly break the pattern this one is modelled on.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import { listRetryable } from '../agent-passports.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isPassportIssuableAccount } from '../../../domain/passport-issuance-rail.js'

let seq = 0

/**
 * `execution_rail` is NOT NULL with default `'allowance_module'`, and its CHECK
 * admits exactly `allowance_module | session_key | delegation` (migrations
 * 036/041). So a null rail cannot exist in the COLUMN — the `string | null` on
 * `VerificationRow`/`findAgentChain` comes from the LEFT JOIN against
 * `user_safes`, which yields null when an agent has no bound account at all
 * (`agents.safe_id` is nullable). Pass `rail: null` here to seed that case.
 *
 * Worth stating because the issue framed null as "the legacy population". The
 * truer statement is that the column's DEFAULT is the legacy rail; null means
 * no account, not a legacy account. The allowlist covers both regardless.
 */
async function seedAgentOnRail(
  rail: string | null,
  accountType: string | null,
  agentStatus = 'active',
): Promise<{ agentId: string; userId: string }> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`pr-${++seq}-${Date.now()}@test.example`],
  )
  const userId = user.rows[0].id
  let safeId: string | null = null
  if (rail !== null) {
    const safe = await db.query<{ id: string }>(
      `INSERT INTO user_safes (user_id, safe_address, chain_id, execution_rail, account_type)
       VALUES ($1, $2, 84532, $3, $4) RETURNING id`,
      [userId, `0x${String(seq).padStart(40, 'a')}`, rail, accountType ?? 'safe'],
    )
    safeId = safe.rows[0].id
  }
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, safe_id, status)
     VALUES ($1, 'passport agent', $2, $3) RETURNING id`,
    [userId, safeId, agentStatus],
  )
  return { agentId: agent.rows[0].id, userId }
}

/**
 * A row the sweep would pick up: not anchored, and old enough that the backoff
 * window has elapsed. `requested_at`/`updated_at` are set well into the past so
 * the `MAKE_INTERVAL` backoff cannot exclude it for timing reasons — otherwise
 * a test could pass because the row was too fresh, which would look identical
 * to the exclusion working.
 */
async function seedRetryablePassport(agentId: string, attempts = 0): Promise<void> {
  await db.query(
    `INSERT INTO agent_passports (agent_id, chain_id, status, assurance_level, attempts, requested_at, updated_at)
     VALUES ($1, 84532, 'pending', 0, $2, NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days')`,
    [agentId, attempts],
  )
}

/**
 * The column's authoritative domain, read from the migration that owns the
 * CHECK rather than restated — a hand-kept copy is what #2110 found rotting on
 * this same passport surface.
 */
function railDomainFromMigration(): string[] {
  const migration = readFileSync(
    fileURLToPath(new URL('../../../db/migrations/041_hybrid_accounts.ts', import.meta.url)),
    'utf8',
  )
  const m = migration.match(/CHECK \(execution_rail IN \(([^)]*)\)\)/)
  if (!m) throw new Error('could not read the execution_rail CHECK from migration 041')
  return m[1].split(',').map((v) => v.trim().replace(/^'|'$/g, '')).filter(Boolean)
}

describeDb('passport issuance is delegation-rail only (#2138)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
  })

  // ── The precedent this change is modelled on ────────────────────────────

  it('CHARACTERIZATION: a revoked agent is already excluded from the retry queue (#1043)', async () => {
    const { agentId } = await seedAgentOnRail('delegation', 'delegator_hybrid', 'revoked')
    await seedRetryablePassport(agentId)

    expect(await listRetryable(50)).toHaveLength(0)
  })

  it('CHARACTERIZATION: an eligible delegation-rail row IS returned — the query is not vacuously empty', async () => {
    // Without this, every exclusion assertion below could pass because the
    // seed never produced a retryable row in the first place.
    const { agentId } = await seedAgentOnRail('delegation', 'delegator_hybrid')
    await seedRetryablePassport(agentId)

    const rows = await listRetryable(50)
    expect(rows).toHaveLength(1)
    expect(rows[0].agent_id).toBe(agentId)
  })

  // ── The new rule ────────────────────────────────────────────────────────

  it('excludes every retired and unset rail from the retry queue', async () => {
    // Seeded side by side in ONE database state rather than one `resetDb()`
    // per case (#2209). `resetDb()` truncates every table in the worker schema,
    // so its cost is set by the migration count, not by what this test wrote —
    // paying it per iteration made a 3-case loop the second-slowest test in the
    // file and put it on the same path to the 5 s default that the drift guard
    // below already fell off. Per-case attribution is kept by asserting on the
    // agent ids, which is what the loop's failure message needed anyway.
    const seeded: Array<{ label: string; agentId: string }> = []
    for (const [rail, accountType] of [
      ['allowance_module', 'safe'],
      ['session_key', 'safe'],
      [null, null], // no bound account at all — the LEFT JOIN's null
    ] as Array<[string | null, string | null]>) {
      const { agentId } = await seedAgentOnRail(rail, accountType)
      await seedRetryablePassport(agentId)
      seeded.push({ label: `rail=${rail ?? 'null'}`, agentId })
    }

    const returned = new Set((await listRetryable(50)).map((r) => r.agent_id))
    for (const { label, agentId } of seeded) {
      expect(returned.has(agentId), `${label} must not be retried`).toBe(false)
    }
    // …and nothing else came back either, which the per-case loop also proved.
    expect(returned.size).toBe(0)
  })

  it('a delegator_hybrid account is eligible even if its rail string is not "delegation"', async () => {
    // The allowlist admits delegation OR delegator_hybrid. issuance.ts already
    // treats those as the same thing when deriving the smart-account address,
    // and a hybrid account is not legacy by any reading — refusing one on a
    // rail/account_type mismatch would be a false refusal of a live account.
    // Seeded with the column's DEFAULT rail to prove account_type alone
    // qualifies it.
    const { agentId } = await seedAgentOnRail('allowance_module', 'delegator_hybrid')
    await seedRetryablePassport(agentId)

    const rows = await listRetryable(50)
    expect(rows).toHaveLength(1)
    expect(rows[0].agent_id).toBe(agentId)
  })

  it('an eligible row is still returned when an ineligible one sits ahead of it', async () => {
    // Ordering is `requested_at ASC`, so a legacy row that is OLDER must not
    // occupy the batch and starve the eligible one behind it — the failure
    // shape #1043's own comment warns about for unisolated sweep failures.
    const legacy = await seedAgentOnRail('allowance_module', 'safe')
    await seedRetryablePassport(legacy.agentId)
    const live = await seedAgentOnRail('delegation', 'delegator_hybrid')
    await db.query(
      `INSERT INTO agent_passports (agent_id, chain_id, status, assurance_level, attempts, requested_at, updated_at)
       VALUES ($1, 84532, 'pending', 0, 0, NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day')`,
      [live.agentId],
    )

    const rows = await listRetryable(50)
    expect(rows).toHaveLength(1)
    expect(rows[0].agent_id).toBe(live.agentId)
  })

  // ── The drift guard: SQL and TypeScript must agree ──────────────────────

  it('the SQL predicate and the TS predicate agree across BOTH axes of the domain', async () => {
    // Two languages, one rule, and nothing in the type system makes them
    // agree. Asserted per rail against the real query rather than by reading
    // both and eyeballing them.
    const domain = railDomainFromMigration()
    expect(domain.sort()).toEqual(['allowance_module', 'delegation', 'session_key'])

    // Review nit 4: the rail axis alone did not justify the name. Both axes
    // are varied now, so "the whole domain" means the whole domain — the
    // account_type arm is the one that lets a hybrid account qualify on a
    // non-delegation rail string, and it deserves the same guard.
    //
    // ## Why the whole domain is seeded into ONE database state (#2209)
    //
    // This used to call `resetDb()` per combination and read eligibility off
    // the batch SIZE (`length === 1`). That made the test cost
    // `6 × resetDb`, and `resetDb()` truncates EVERY table in the worker
    // schema — so its cost tracks the migration count, not anything this test
    // writes. Measured on `dev` at 38 tables: ~250 ms per reset with the suite
    // quiet, ~800 ms–1.2 s with the scoped `vitest run src/db src/infra` load,
    // i.e. 7 resets (6 here + `beforeEach`) landing at ~5.7 s against the 5 s
    // default. Not a timeout that was set too tight — a fixture that got more
    // expensive with every migration and would have outgrown any number.
    //
    // Seeding once and asserting on agent IDs removes the resets without
    // narrowing the claim: every (rail × account_type) pair in the domain is
    // still checked against the real query, and per-pair attribution survives
    // in the failure message. It is if anything STRICTER — the SQL now has to
    // pick the eligible rows out of a table that also holds the ineligible
    // ones, which per-combination isolation could not see, and the closing
    // set-equality assertion keeps the "nothing extra came back" half of the
    // old `length === 1`.
    const seeded: Array<{ agentId: string; label: string; tsSaysEligible: boolean }> = []
    for (const rail of domain) {
      for (const accountType of ['safe', 'delegator_hybrid']) {
        const { agentId } = await seedAgentOnRail(rail, accountType)
        await seedRetryablePassport(agentId)
        seeded.push({
          agentId,
          label: `rail=${rail} account_type=${accountType}`,
          tsSaysEligible: isPassportIssuableAccount(rail, accountType),
        })
      }
    }

    // The batch limit must not be what decides the answer: a truncated batch
    // would read as "SQL says ineligible" for whatever fell off the end. Stated
    // over the SEEDED universe, not over `rows` — `rows` can never reach 50
    // while `seeded` holds 6, so asserting on it would be a guard that cannot
    // fire (review nit). Asserted on `seeded` it is the real precondition, and
    // it starts firing the moment the rail domain outgrows the batch.
    expect(seeded.length, 'the seeded domain no longer fits under the batch limit').toBeLessThan(50)
    const rows = await listRetryable(50)

    const returned = new Set(rows.map((r) => r.agent_id))
    for (const { agentId, label, tsSaysEligible } of seeded) {
      expect(returned.has(agentId), `SQL and TS disagree for ${label}`).toBe(tsSaysEligible)
    }
    expect(rows).toHaveLength(seeded.filter((s) => s.tsSaysEligible).length)
  })

  it('the drift guard is not vacuous: the domain contains both an eligible and an ineligible rail', () => {
    // Without this, the loop above would pass on a domain where every member
    // happened to answer the same way.
    const domain = railDomainFromMigration()
    expect(domain.some((r) => isPassportIssuableAccount(r, 'safe'))).toBe(true)
    expect(domain.some((r) => !isPassportIssuableAccount(r, 'safe'))).toBe(true)
  })
})
