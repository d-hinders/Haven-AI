/**
 * Real-DB tests for the delegation-budgets repository (#1221, epic #1219).
 *
 * First conversion on the #1220 harness and the reference for the rest:
 * no `vi.mock('db.js')` anywhere — every assertion is about what Postgres
 * actually returns. This file is also the epic's proof case for the harness's
 * trickiest property: `delegation-budgets.ts` is the one repository using the
 * module-level `pool` import rather than an injected Executor, so these tests
 * passing at all confirms the per-worker `search_path` binding holds for
 * pooled connections.
 *
 * Row builders are local per #1220's domain-free-harness rule; promote to a
 * shared helper only when a second conversion needs the same shape.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import {
  listActiveDelegations,
  listDelegationJsonByIds,
  selectDelegationForPayment,
} from '../delegation-budgets.js'

const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const RECIPIENT = '0x00000000000000000000000000000000000000aa'

let hashCounter = 0

async function seedUserAndAgent(name = 'Budget agent'): Promise<string> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`u${++hashCounter}-${Date.now()}@test.example`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, $2) RETURNING id`,
    [user.rows[0].id, name],
  )
  return agent.rows[0].id
}

interface DelegationSeed {
  agentId: string
  status?: string
  tokenAddress?: string
  recipientAddress?: string | null
  budgetAtomic?: string
  createdAt?: string
  delegationJson?: string
}

async function seedDelegation(seed: DelegationSeed): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO agent_delegations
       (agent_id, chain_id, token_address, recipient_address, delegation_hash,
        delegation_json, version, status, budget_atomic, period_seconds,
        start_date, expires_at, created_at)
     VALUES ($1, 84532, $2, $3, $4, $5, 1, $6, $7, 86400, 0, 9999999999,
             COALESCE($8::timestamptz, NOW()))
     RETURNING id`,
    [
      seed.agentId,
      seed.tokenAddress ?? USDC,
      seed.recipientAddress ?? null,
      `0x${String(++hashCounter).padStart(64, '0')}`,
      seed.delegationJson ?? '{"signed":"capability"}',
      seed.status ?? 'active',
      seed.budgetAtomic ?? '1000000',
      seed.createdAt ?? null,
    ],
  )
  return result.rows[0].id
}

describeDb('delegation-budgets repository (#1221)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('returns only ACTIVE rows for the requested agents — revoked/replaced/pending are excluded', async () => {
    const agentA = await seedUserAndAgent('A')
    const agentB = await seedUserAndAgent('B')
    const active = await seedDelegation({ agentId: agentA })
    await seedDelegation({ agentId: agentA, status: 'revoked' })
    await seedDelegation({ agentId: agentA, status: 'replaced' })
    await seedDelegation({ agentId: agentA, status: 'pending' })
    // Another agent's ACTIVE row must not leak into A's budget view:
    await seedDelegation({ agentId: agentB })

    const rows = await listActiveDelegations([agentA])
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(active)
    expect(rows[0].agent_id).toBe(agentA)
  })

  it('ORDER BY created_at ASC holds with rows inserted out of order', async () => {
    const agent = await seedUserAndAgent()
    const newest = await seedDelegation({ agentId: agent, createdAt: '2026-08-03T00:00:00Z' })
    const oldest = await seedDelegation({ agentId: agent, createdAt: '2026-08-01T00:00:00Z' })
    const middle = await seedDelegation({ agentId: agent, createdAt: '2026-08-02T00:00:00Z' })

    const rows = await listActiveDelegations([agent])
    expect(rows.map((r) => r.id)).toEqual([oldest, middle, newest])
  })

  it('ANY($1) handles one agent, many agents, and agents matching nothing', async () => {
    const agentA = await seedUserAndAgent('A')
    const agentB = await seedUserAndAgent('B')
    const a = await seedDelegation({ agentId: agentA })
    const b = await seedDelegation({ agentId: agentB })

    expect((await listActiveDelegations([agentA])).map((r) => r.id)).toEqual([a])
    expect(
      (await listActiveDelegations([agentA, agentB])).map((r) => r.id).sort(),
    ).toEqual([a, b].sort())
    const ghost = '00000000-0000-0000-0000-000000000001'
    expect(await listActiveDelegations([ghost])).toEqual([])
  })

  it('empty input short-circuits to [] even when matching rows exist', async () => {
    const agent = await seedUserAndAgent()
    await seedDelegation({ agentId: agent })
    expect(await listActiveDelegations([])).toEqual([])
    expect(await listDelegationJsonByIds([])).toEqual(new Map())
  })

  it('NEVER exposes delegation_json from listActiveDelegations — the capability boundary (#1145)', async () => {
    // The signed delegation is a redeemable capability, and these rows are
    // spread straight into JSON responses. A refactor that "helpfully" joins
    // it in must fail here, loudly.
    const agent = await seedUserAndAgent()
    await seedDelegation({ agentId: agent, delegationJson: '{"signed":"SECRET"}' })

    const rows = await listActiveDelegations([agent])
    expect(rows).toHaveLength(1)
    expect(rows[0]).not.toHaveProperty('delegation_json')
    expect(JSON.stringify(rows)).not.toContain('SECRET')
  })

  it('listDelegationJsonByIds returns a Map of exactly the requested ids', async () => {
    const agent = await seedUserAndAgent()
    const one = await seedDelegation({ agentId: agent, delegationJson: '{"n":1}' })
    const two = await seedDelegation({ agentId: agent, delegationJson: '{"n":2}' })
    const unrequested = await seedDelegation({ agentId: agent, delegationJson: '{"n":3}' })
    const ghost = '00000000-0000-0000-0000-000000000002'

    const map = await listDelegationJsonByIds([one, two, ghost])
    expect(map.size).toBe(2)
    expect(map.get(one)).toBe('{"n":1}')
    expect(map.get(two)).toBe('{"n":2}')
    expect(map.has(unrequested)).toBe(false)
    expect(map.has(ghost)).toBe(false)
    // …and carries only id + delegation_json — nothing else came back.
    expect(await listDelegationJsonByIds([one])).toEqual(new Map([[one, '{"n":1}']]))
  })

  it('selectDelegationForPayment: a recipient-pinned grant beats the open one (#829)', async () => {
    const agent = await seedUserAndAgent()
    await seedDelegation({
      agentId: agent,
      recipientAddress: null,
      createdAt: '2026-08-02T00:00:00Z', // newer open grant…
    })
    await seedDelegation({
      agentId: agent,
      recipientAddress: RECIPIENT,
      createdAt: '2026-08-01T00:00:00Z', // …still loses to the older pinned one
    })

    const row = await selectDelegationForPayment(agent, USDC, RECIPIENT)
    expect(row).not.toBeNull()
    expect(row!.recipient_address).toBe(RECIPIENT)
  })

  it('selectDelegationForPayment: falls back to the open grant when the pin targets someone else', async () => {
    const agent = await seedUserAndAgent()
    await seedDelegation({ agentId: agent, recipientAddress: RECIPIENT })
    const other = '0x00000000000000000000000000000000000000bb'

    const row = await selectDelegationForPayment(agent, USDC, other)
    // The RECIPIENT-pinned grant must not authorize a payment to `other` —
    // and with no open grant, nothing does.
    expect(row).toBeNull()

    await seedDelegation({ agentId: agent, recipientAddress: null })
    const withOpen = await selectDelegationForPayment(agent, USDC, other)
    expect(withOpen).not.toBeNull()
    expect(withOpen!.recipient_address).toBeNull()
  })

  it('selectDelegationForPayment: lower-cases token and recipient inputs (the table stores lowercase)', async () => {
    const agent = await seedUserAndAgent()
    await seedDelegation({ agentId: agent, recipientAddress: RECIPIENT })

    const row = await selectDelegationForPayment(
      agent,
      USDC.toUpperCase().replace('0X', '0x'),
      RECIPIENT.toUpperCase().replace('0X', '0x'),
    )
    expect(row).not.toBeNull()
    expect(row!.recipient_address).toBe(RECIPIENT)
  })

  it('selectDelegationForPayment: ignores non-active rows and returns null when nothing authorizes', async () => {
    const agent = await seedUserAndAgent()
    await seedDelegation({ agentId: agent, status: 'revoked', recipientAddress: RECIPIENT })
    await seedDelegation({ agentId: agent, status: 'pending', recipientAddress: null })

    expect(await selectDelegationForPayment(agent, USDC, RECIPIENT)).toBeNull()
  })

  it('selectDelegationForPayment: within the same class, the NEWEST grant wins', async () => {
    const agent = await seedUserAndAgent()
    await seedDelegation({
      agentId: agent,
      recipientAddress: null,
      budgetAtomic: '111',
      createdAt: '2026-08-01T00:00:00Z',
    })
    await seedDelegation({
      agentId: agent,
      recipientAddress: null,
      budgetAtomic: '222',
      createdAt: '2026-08-02T00:00:00Z',
    })

    const row = await selectDelegationForPayment(agent, USDC, RECIPIENT)
    expect(row).not.toBeNull()
    // Identify the winner via its delegation_json/hash — budget is not
    // returned; re-read the row to confirm which one authorized.
    const winner = await db.query<{ budget_atomic: string }>(
      `SELECT budget_atomic FROM agent_delegations WHERE delegation_hash = $1`,
      [row!.delegation_hash],
    )
    expect(winner.rows[0].budget_atomic).toBe('222')
  })
})

/**
 * #1400 real-DB proof: the batch revocation is ONE statement, agent-scoped,
 * status-predicated — what Postgres must guarantee for "submit marks exactly
 * those hashes revoked".
 */
import {
  listNonRevokedDelegationsForAgent,
  revokeDelegationsByHashes,
} from '../delegation-budgets.js'

describeDb('batch revocation (#1400, real DB)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
  })

  it('lists pending AND active, never revoked/replaced; batch-revoke flips exactly the given hashes', async () => {
    const agentId = await seedUserAndAgent('Batch agent')
    const otherAgent = await seedUserAndAgent('Other agent')
    const hActive = await seedDelegation({ agentId, status: 'active', tokenAddress: USDC })
    const hPending = await seedDelegation({ agentId, status: 'pending', tokenAddress: '0x' + '11'.repeat(20) })
    await seedDelegation({ agentId, status: 'revoked', tokenAddress: '0x' + '22'.repeat(20) })
    const hForeign = await seedDelegation({ agentId: otherAgent, status: 'active', tokenAddress: USDC })

    const targets = await listNonRevokedDelegationsForAgent(agentId)
    expect(targets.map((t) => t.status).sort()).toEqual(['active', 'pending'])
    const hashes = targets.map((t) => t.delegation_hash)

    // The foreign hash rides along in the request — the agent scope must
    // make it flip NOTHING outside this agent.
    const foreignRow = await db.query<{ delegation_hash: string }>(
      `SELECT delegation_hash FROM agent_delegations WHERE id = $1`, [hForeign],
    )
    const flipped = await revokeDelegationsByHashes(agentId, [...hashes, foreignRow.rows[0].delegation_hash])
    expect(flipped.sort()).toEqual(hashes.sort())

    const after = await db.query<{ status: string }>(
      `SELECT status FROM agent_delegations WHERE id = ANY($1)`, [[hActive, hPending]],
    )
    expect(after.rows.every((r) => r.status === 'revoked')).toBe(true)
    const foreign = await db.query<{ status: string }>(
      `SELECT status FROM agent_delegations WHERE id = $1`, [hForeign],
    )
    expect(foreign.rows[0].status).toBe('active')
  })

  it('re-running the batch is a no-op (status predicate) — nothing double-flips', async () => {
    const agentId = await seedUserAndAgent('Idempotent agent')
    await seedDelegation({ agentId, status: 'active', tokenAddress: USDC })
    const hashes = (await listNonRevokedDelegationsForAgent(agentId)).map((t) => t.delegation_hash)
    expect(await revokeDelegationsByHashes(agentId, hashes)).toHaveLength(1)
    expect(await revokeDelegationsByHashes(agentId, hashes)).toHaveLength(0)
  })
})

/**
 * #2411 real-DB proof of the activation sequence. #2331 reordered the
 * route's transaction so the "retire the slot's active grants" sweep ran
 * AFTER the pending row was flipped active — and the sweep had no `id <>`
 * exclusion, so it retired the row it had just activated. Every activation
 * committed with ZERO active rows in the slot; the first payment 403ed on
 * `SELECT_DELEGATION_FOR_PAYMENT_SQL`. The mocked route test could not see
 * it: a stateless mock cannot observe that a sweep matched the row a previous
 * statement wrote. Only Postgres can, so this is where the invariant lives.
 */
import { withTransaction } from '../../transaction.js'
import {
  activatePendingDelegationInSlot,
  replaceOtherActiveDelegationsInSlot,
} from '../delegation-budgets.js'

const SIGNED_JSON = '{"signed":"capability","signature":"0xowner"}'

async function statusOf(id: string): Promise<string> {
  const row = await db.query<{ status: string }>(
    `SELECT status FROM agent_delegations WHERE id = $1`,
    [id],
  )
  return row.rows[0].status
}

describeDb('activation replace sweep (#2411, real DB)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
  })

  it('activating a pending grant over an older active one leaves EXACTLY ONE active row in the slot — the new one — and the payment selector returns it', async () => {
    const agent = await seedUserAndAgent('Activation agent')
    const older = await seedDelegation({
      agentId: agent,
      status: 'active',
      recipientAddress: null,
      createdAt: '2026-08-01T00:00:00Z',
    })
    const fresh = await seedDelegation({
      agentId: agent,
      status: 'pending',
      recipientAddress: null,
      delegationJson: '{"signed":"not yet"}',
    })
    // Neighbours the sweep must NOT reach: a recipient-pinned grant is a
    // different slot (#829 relies on both coexisting), another token is
    // another slot, and another agent's open grant is another agent's.
    const pinned = await seedDelegation({ agentId: agent, status: 'active', recipientAddress: RECIPIENT })
    const otherToken = await seedDelegation({ agentId: agent, status: 'active', tokenAddress: '0x' + '11'.repeat(20) })
    const otherAgent = await seedUserAndAgent('Bystander agent')
    const foreign = await seedDelegation({ agentId: otherAgent, status: 'active', recipientAddress: null })

    // The route's sequence: lock, sweep-then-activate, commit.
    const activated = await withTransaction(db, (tx) =>
      activatePendingDelegationInSlot(
        {
          agentId: agent,
          delegationId: fresh,
          tokenAddress: USDC,
          recipientAddress: null,
          signedDelegationJson: SIGNED_JSON,
        },
        tx,
      ),
    )
    expect(activated).toBe(true)

    const slot = await db.query<{ id: string; status: string }>(
      `SELECT id, status FROM agent_delegations
       WHERE agent_id = $1 AND token_address = $2 AND recipient_address IS NULL`,
      [agent, USDC],
    )
    const active = slot.rows.filter((r) => r.status === 'active')
    expect(active.map((r) => r.id)).toEqual([fresh])
    expect(slot.rows.find((r) => r.id === older)?.status).toBe('replaced')

    // What the 403 bottomed out in: the payment selector must find the NEW
    // grant (a recipient the pinned grant does not cover, so the open slot
    // answers).
    const other = '0x00000000000000000000000000000000000000bb'
    const selected = await selectDelegationForPayment(agent, USDC, other)
    const freshRow = await db.query<{ delegation_hash: string }>(
      `SELECT delegation_hash FROM agent_delegations WHERE id = $1`,
      [fresh],
    )
    expect(selected).not.toBeNull()
    expect(selected!.delegation_hash).toBe(freshRow.rows[0].delegation_hash)
    expect(selected!.delegation_json).toBe(SIGNED_JSON)

    for (const untouched of [pinned, otherToken, foreign]) {
      expect(await statusOf(untouched)).toBe('active')
    }
  })

  it('the sweep excludes the row being activated BY ID — correct whichever order a caller runs the two statements in', async () => {
    // Isolates the `AND id <> $4` half from the ordering half: with the
    // exception row ALREADY active (the #2331 order, activate-then-sweep),
    // the sweep must leave it alone and retire only its sibling.
    const agent = await seedUserAndAgent('Exclusion agent')
    const sibling = await seedDelegation({ agentId: agent, status: 'active', recipientAddress: null })
    const kept = await seedDelegation({ agentId: agent, status: 'active', recipientAddress: null })

    const retired = await replaceOtherActiveDelegationsInSlot(agent, USDC, null, kept)
    expect(retired).toEqual([sibling])
    expect(await statusOf(kept)).toBe('active')
    expect(await statusOf(sibling)).toBe('replaced')
  })

  it('a row that is no longer pending activates nothing, and the caller\'s rollback undoes the sweep', async () => {
    const agent = await seedUserAndAgent('Stale agent')
    const older = await seedDelegation({ agentId: agent, status: 'active', recipientAddress: null })
    const revoked = await seedDelegation({ agentId: agent, status: 'revoked', recipientAddress: null })

    const abandon = new Error('abandon')
    await expect(
      withTransaction(db, async (tx) => {
        const activated = await activatePendingDelegationInSlot(
          { agentId: agent, delegationId: revoked, tokenAddress: USDC, recipientAddress: null, signedDelegationJson: SIGNED_JSON },
          tx,
        )
        expect(activated).toBe(false)
        // The documented contract: by now the sweep HAS run on this client…
        const mid = await tx.query<{ status: string }>(`SELECT status FROM agent_delegations WHERE id = $1`, [older])
        expect(mid.rows[0].status).toBe('replaced')
        throw abandon
      }),
    ).rejects.toBe(abandon)
    // …and only the caller's ROLLBACK (the route's 409 path) restores it.
    expect(await statusOf(older)).toBe('active')
    expect(await statusOf(revoked)).toBe('revoked')
  })
})
