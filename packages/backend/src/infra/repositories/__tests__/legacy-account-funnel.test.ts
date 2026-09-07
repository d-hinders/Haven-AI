/**
 * #2413 — the dashboard stops rendering retired-rail accounts.
 *
 * Epic #1440's owner decision of 2026-09-02 is that retirement is DELETION,
 * not accommodation. Rather than keep ~25 files branching on `account_type` to
 * render legacy Safe accounts nicely for a population of zero, the account and
 * agent list queries stop returning them, and every branch behind them becomes
 * unreachable and deletable.
 *
 * These are REAL-DB tests on purpose (epic #1219): the claim is "which rows a
 * query returns", which is database behaviour. A positional mock would assert
 * that a string contains a WHERE clause, which is not the same claim and would
 * pass against a clause that filters the wrong column.
 *
 * Every case seeds BOTH rails for the SAME user, so a passing result cannot be
 * explained by the tenant filter that was already there.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import {
  listSafesForUser,
  listSafesWithAccountTypeForUser,
  listSessionSafesForUser,
} from '../user-safes.js'
import { findAgentForUserAllStatuses, listAgentsForUserAllStatuses } from '../agents.js'
import { listDashboardAgents, listDashboardSafes } from '../dashboard.js'

let n = 0

async function seedUser(): Promise<string> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`funnel-${++n}-${Date.now()}@test.example`],
  )
  return user.rows[0].id
}

// `account_type` is NOT NULL with a two-value CHECK (041_hybrid_accounts), so
// the parameter is deliberately not nullable: there is no third state to seed.
async function seedSafe(userId: string, accountType: 'safe' | 'delegator_hybrid'): Promise<string> {
  const safe = await db.query<{ id: string }>(
    `INSERT INTO user_safes (user_id, safe_address, name, chain_id, account_type)
     VALUES ($1, $2, $3, 8453, $4) RETURNING id`,
    [userId, `0x${String(++n).padStart(40, '0')}`, `acct-${accountType}`, accountType],
  )
  return safe.rows[0].id
}

async function seedAgent(userId: string, safeId: string | null, name: string): Promise<void> {
  await db.query(
    `INSERT INTO agents (user_id, name, delegate_address, api_key_hash, api_key_prefix, safe_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, name, `0x${String(++n).padStart(40, 'a')}`, `hash-${n}`, `sk_${n}`, safeId],
  )
}

describeDb('legacy accounts are not listed (#2413)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
  })

  it('all three account-list queries return the delegation account and not the legacy one', async () => {
    const userId = await seedUser()
    await seedSafe(userId, 'delegator_hybrid')
    await seedSafe(userId, 'safe')

    expect((await listSafesForUser(userId)).map((s) => s.name)).toEqual(['acct-delegator_hybrid'])
    expect((await listSafesWithAccountTypeForUser(userId)).map((s) => s.name)).toEqual([
      'acct-delegator_hybrid',
    ])
    expect((await listSessionSafesForUser(userId)).map((s) => s.name)).toEqual([
      'acct-delegator_hybrid',
    ])
  })

  it('a user whose only account is legacy sees no accounts at all', async () => {
    // The accepted consequence, pinned rather than discovered: this user is
    // routed to onboarding, which provisions a Hybrid DeleGator.
    const userId = await seedUser()
    await seedSafe(userId, 'safe')

    expect(await listSessionSafesForUser(userId)).toEqual([])
  })

  it('the agent list drops an agent bound to a legacy account and keeps a delegation one', async () => {
    const userId = await seedUser()
    const hybrid = await seedSafe(userId, 'delegator_hybrid')
    const legacy = await seedSafe(userId, 'safe')
    await seedAgent(userId, hybrid, 'delegation agent')
    await seedAgent(userId, legacy, 'legacy agent')

    expect((await listAgentsForUserAllStatuses(userId)).map((a) => a.name)).toEqual([
      'delegation agent',
    ])
  })

  it('an ORPHANED agent is not listed either — owner decision, not a side effect', async () => {
    // An agent whose account was unlinked has safe_id NULL, so the LEFT JOIN
    // gives it a NULL account_type and the predicate excludes it. That is
    // deliberate (owner call, 2026-09-02): since #2331 such an agent gets 403
    // from agentAuth on every route, and the one exemption — sweep recovery —
    // refuses it too because has_bound_safe is false. It is a dead record.
    //
    // Pinned rather than left to the predicate's shape, because the honest
    // alternative (keeping it visible) is one clause away and someone will
    // reasonably wonder which was meant.
    const userId = await seedUser()
    await seedAgent(userId, null, 'orphaned agent')

    expect(await listAgentsForUserAllStatuses(userId)).toEqual([])
  })

  // ── The queries review caught me missing (#2413 round 1) ────────────────
  //
  // `dashboard.ts` was a THIRD repository file, unmentioned by the issue and
  // by my own commentary, which listed accounts and agents unfiltered. The
  // consequence was not cosmetic: `/dashboard` counted legacy accounts in
  // "Active accounts" and rendered legacy agents in "Connected agents" LINKING
  // to `/agents/:id` — a link that 404s, because the list that route reads
  // from IS filtered. A partly-filtered funnel is worse than an unfiltered
  // one, which is why these cases exist rather than a note.
  it('the dashboard overview lists neither legacy accounts nor their agents', async () => {
    const userId = await seedUser()
    const hybrid = await seedSafe(userId, 'delegator_hybrid')
    const legacy = await seedSafe(userId, 'safe')
    await seedAgent(userId, hybrid, 'delegation agent')
    await seedAgent(userId, legacy, 'legacy agent')

    expect((await listDashboardSafes(userId)).map((s) => s.name)).toEqual(['acct-delegator_hybrid'])
    expect((await listDashboardAgents(userId)).map((a) => a.name)).toEqual(['delegation agent'])
  })

  it('a legacy agent cannot be read back individually either', async () => {
    // Otherwise the single-record route stays a way to reach an agent the list
    // refuses to show — the same inconsistency one layer down.
    const userId = await seedUser()
    const legacy = await seedSafe(userId, 'safe')
    await seedAgent(userId, legacy, 'legacy agent')

    const listed = await listAgentsForUserAllStatuses(userId)
    expect(listed).toEqual([])

    const rows = await db.query<{ id: string }>(`SELECT id FROM agents WHERE user_id = $1`, [userId])
    expect(await findAgentForUserAllStatuses(rows.rows[0].id, userId)).toBeNull()
  })

  it('tenant scoping still holds — the filter narrows, it never widens', async () => {
    const owner = await seedUser()
    const other = await seedUser()
    await seedSafe(owner, 'delegator_hybrid')

    expect(await listSessionSafesForUser(other)).toEqual([])
    expect(await listSafesForUser(other)).toEqual([])
    expect(await listSafesWithAccountTypeForUser(other)).toEqual([])
  })
})
