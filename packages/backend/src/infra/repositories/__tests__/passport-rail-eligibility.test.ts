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
    for (const [rail, accountType] of [
      ['allowance_module', 'safe'],
      ['session_key', 'safe'],
      [null, null], // no bound account at all — the LEFT JOIN's null
    ] as Array<[string | null, string | null]>) {
      await resetDb()
      const { agentId } = await seedAgentOnRail(rail, accountType)
      await seedRetryablePassport(agentId)

      expect(await listRetryable(50), `rail=${rail ?? 'null'} must not be retried`).toHaveLength(0)
    }
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
    for (const rail of domain) {
      for (const accountType of ['safe', 'delegator_hybrid']) {
        await resetDb()
        const { agentId } = await seedAgentOnRail(rail, accountType)
        await seedRetryablePassport(agentId)

        const sqlSaysEligible = (await listRetryable(50)).length === 1
        const tsSaysEligible = isPassportIssuableAccount(rail, accountType)
        expect(
          sqlSaysEligible,
          `SQL and TS disagree for rail=${rail} account_type=${accountType}`,
        ).toBe(tsSaysEligible)
      }
    }
  })

  it('the drift guard is not vacuous: the domain contains both an eligible and an ineligible rail', () => {
    // Without this, the loop above would pass on a domain where every member
    // happened to answer the same way.
    const domain = railDomainFromMigration()
    expect(domain.some((r) => isPassportIssuableAccount(r, 'safe'))).toBe(true)
    expect(domain.some((r) => !isPassportIssuableAccount(r, 'safe'))).toBe(true)
  })
})
