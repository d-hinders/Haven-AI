/**
 * Real-DB tests for the agent hand-off attribution columns (#2522, epic #2519).
 *
 * Migration 076 adds `users.via` and `agent_connection_setups.via` so "how much
 * of the funnel did an agent drive" is a queryable fact rather than an
 * inference from a spoofable user agent. On the #1220 harness; zero mocks.
 *
 * The last test in this file is the one that matters most, and it exists
 * because of a collision found while wiring this: the funnel metadata ALREADY
 * had a key called `via`, meaning which CODE PATH created the record
 * (`'connection_setup'` from the connect flow, absent from `POST /agents`).
 * Writing the hand-off marker into that key would have given one key two
 * meanings and silently redefined every historical row, so the marker rides as
 * `handoff_via` and this test pins both keys coexisting.
 */
import { randomUUID } from 'node:crypto'
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import { insertUser } from '../users.js'
import { insertSetupWithAllowances, findSetupForUser } from '../agent-connection-setups.js'
import { emitFunnelEvent } from '../onboarding-funnel.js'
import { normalizeViaMarker, buildApprovalUrl, VIA_AGENT } from '../../../domain/handoff-links.js'

let seq = 0

async function seedSafe(userId: string): Promise<string> {
  const safe = await db.query<{ id: string }>(
    `INSERT INTO user_safes (user_id, safe_address, name, chain_id)
     VALUES ($1, $2, 'Main account', 84532) RETURNING id`,
    [userId, `0x${String(++seq).padStart(40, '0')}`],
  )
  return safe.rows[0].id
}

function newSetup(id: string, userId: string, safeId: string, via: string | null) {
  return {
    id,
    userId,
    safeId,
    name: 'Connect setup',
    description: null,
    runtime: null,
    setupTokenHash: `hash-${++seq}-${Date.now()}`,
    setupTokenPrefix: 'hvn_setup_ab',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    challengeId: randomUUID(),
    challengeMessage: 'sign me',
    issuePassport: false,
    source: null,
    via,
  }
}

/** Wait for a fire-and-forget funnel row. Bounded: a miss must fail, not hang. */
async function awaitFunnelRow(
  userId: string,
  event: string,
): Promise<Record<string, unknown> | null> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const row = await db.query<{ metadata: Record<string, unknown> | null }>(
      `SELECT metadata FROM onboarding_events WHERE user_id = $1 AND event = $2 LIMIT 1`,
      [userId, event],
    )
    if (row.rows.length > 0) return row.rows[0].metadata
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return null
}

describeDb('agent hand-off attribution (#2522)', () => {
  beforeAll(initDbHarness)
  beforeEach(resetDb)

  it('stores the marker on users, and null when absent', async () => {
    const marked = await insertUser('Agent-driven', `via-${++seq}@test.example`, 'x', VIA_AGENT)
    const plain = await insertUser('Organic', `plain-${++seq}@test.example`, 'x', null)

    const rows = await db.query<{ id: string; via: string | null }>(
      `SELECT id, via FROM users WHERE id = ANY($1::uuid[]) ORDER BY via NULLS LAST`,
      [[marked.id, plain.id]],
    )
    expect(rows.rows.map((r) => r.via)).toEqual([VIA_AGENT, null])
  })

  it('stores the marker on a connection setup and reads it back through the row projection', async () => {
    const user = await insertUser('Owner', `setup-${++seq}@test.example`, 'x', VIA_AGENT)
    const safeId = await seedSafe(user.id)
    const setupId = randomUUID()
    await insertSetupWithAllowances(newSetup(setupId, user.id, safeId, VIA_AGENT), [])

    // Through the real projection, not a bespoke SELECT: the column is only
    // useful if the SELECT list the route reads actually carries it.
    const row = await findSetupForUser(setupId, user.id)
    expect(row?.via).toBe(VIA_AGENT)
  })

  it('defaults to null for every setup written without a marker', async () => {
    const user = await insertUser('Owner', `nul-${++seq}@test.example`, 'x', null)
    const safeId = await seedSafe(user.id)
    const setupId = randomUUID()
    await insertSetupWithAllowances(newSetup(setupId, user.id, safeId, null), [])
    const row = await findSetupForUser(setupId, user.id)
    expect(row?.via).toBeNull()
  })

  it('carries handoff_via in signed_up metadata', async () => {
    const user = await insertUser('Agent-driven', `fun-${++seq}@test.example`, 'x', VIA_AGENT)
    emitFunnelEvent(user.id, 'signed_up', { handoff_via: VIA_AGENT })
    const metadata = await awaitFunnelRow(user.id, 'signed_up')
    expect(metadata).toMatchObject({ handoff_via: VIA_AGENT })
  })

  it('is queryable as a funnel segment, which is the whole point (#2529)', async () => {
    const agentDriven = await insertUser('A', `seg-a-${++seq}@test.example`, 'x', VIA_AGENT)
    const organic = await insertUser('B', `seg-b-${++seq}@test.example`, 'x', null)
    emitFunnelEvent(agentDriven.id, 'signed_up', { handoff_via: VIA_AGENT })
    emitFunnelEvent(organic.id, 'signed_up')
    await awaitFunnelRow(agentDriven.id, 'signed_up')
    await awaitFunnelRow(organic.id, 'signed_up')

    const segment = await db.query<{ users: string }>(
      `SELECT COUNT(DISTINCT user_id)::text AS users
         FROM onboarding_events
        WHERE event = 'signed_up' AND metadata->>'handoff_via' = $1`,
      [VIA_AGENT],
    )
    expect(segment.rows[0].users).toBe('1')
  })

  it('COLLISION: handoff_via does not overwrite the existing via code-path key', async () => {
    // `via: 'connection_setup'` is what tells the connect flow apart from
    // `POST /agents` in existing rows. Both keys must survive one emission.
    const user = await insertUser('Owner', `col-${++seq}@test.example`, 'x', VIA_AGENT)
    emitFunnelEvent(user.id, 'agent_created', {
      agent_id: randomUUID(),
      via: 'connection_setup',
      handoff_via: VIA_AGENT,
    })
    const metadata = await awaitFunnelRow(user.id, 'agent_created')
    expect(metadata).toMatchObject({ via: 'connection_setup', handoff_via: VIA_AGENT })
  })
})

describeDb('hand-off link helpers (#2522)', () => {
  it('accepts only the agent enum', () => {
    expect(normalizeViaMarker('agent')).toBe(VIA_AGENT)
    expect(normalizeViaMarker('AGENT')).toBe(VIA_AGENT)
    expect(normalizeViaMarker('human')).toBeNull()
    expect(normalizeViaMarker('agentic')).toBeNull()
    expect(normalizeViaMarker(42)).toBeNull()
    expect(normalizeViaMarker(undefined)).toBeNull()
  })

  it('builds an approval url with no double slash', () => {
    // A FRONTEND_URL with a trailing slash is an ordinary way to set that
    // variable, and `…com//agents` is a protocol-relative path to the host
    // `agents` once anything resolves it against a base.
    const url = buildApprovalUrl('hv_setup_x')
    expect(url).toMatch(/\/agents\?setup=hv_setup_x$/)
    expect(url.replace(/^https?:\/\//, '')).not.toContain('//')
  })
})
