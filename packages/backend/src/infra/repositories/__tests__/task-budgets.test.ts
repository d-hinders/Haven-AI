/**
 * Real-DB tests for task budgets (#3329) — status transitions, agent
 * scoping and the open-reserved sum are all Postgres behaviour, so they
 * belong on the real harness (epic #1219).
 */
import { randomUUID } from 'node:crypto'
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import {
  findForAgent,
  insertPendingTaskBudget,
  listForAgent,
  listForOwner,
  markClosed,
  markClosing,
  markOpen,
  selectOpenForPayment,
  sumOpenReservedAtomic,
  type InsertPendingTaskBudgetInput,
} from '../task-budgets.js'

const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const PARENT_HASH = `0x${'a'.repeat(64)}`

let seq = 0

interface Seeded {
  userId: string
  agentId: string
}

async function seedAgent(): Promise<Seeded> {
  const n = ++seq
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`tb${n}-${Date.now()}@test.example`],
  )
  const userId = user.rows[0].id
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
     VALUES ($1, $2, 84532, 'delegation', 'delegator_hybrid') RETURNING id`,
    [userId, `0x${String(n).padStart(40, 'a')}`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, account_id, name, delegate_address, api_key_hash, api_key_prefix, status)
     VALUES ($1, $2, 'Task budget agent', $3, $4, 'sk_agent_tb', 'active') RETURNING id`,
    [userId, account.rows[0].id, `0x${String(n).padStart(40, 'd')}`, `hash-tb-${n}-${Date.now()}`],
  )
  return { userId, agentId: agent.rows[0].id }
}

function pendingInput(agentId: string, over: Partial<InsertPendingTaskBudgetInput> = {}): InsertPendingTaskBudgetInput {
  const n = ++seq
  return {
    id: randomUUID(),
    agentId,
    chainId: 84532,
    tokenAddress: USDC,
    recipientAddress: null,
    parentDelegationHash: PARENT_HASH,
    delegationHash: `0x${String(n).padStart(64, '0')}`,
    delegationJson: JSON.stringify({ unsigned: true, n }),
    label: 'Test task',
    maxAtomic: '1000000',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    ...over,
  }
}

describeDb('agent_task_budgets repository (#3329)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('inserts pending and is findable only within its own agent', async () => {
    const seeded = await seedAgent()
    const other = await seedAgent()
    const row = await insertPendingTaskBudget(pendingInput(seeded.agentId))

    expect(row.status).toBe('pending')
    expect(await findForAgent(row.id, seeded.agentId)).not.toBeNull()
    expect(await findForAgent(row.id, other.agentId)).toBeNull()
  })

  it('#3329 review finding B: the inserted row id is EXACTLY the caller-minted id — the salt input is real', async () => {
    const seeded = await seedAgent()
    const mintedId = randomUUID()
    const row = await insertPendingTaskBudget(pendingInput(seeded.agentId, { id: mintedId }))

    expect(row.id).toBe(mintedId)
    expect((await findForAgent(mintedId, seeded.agentId))?.id).toBe(mintedId)
  })

  it('markOpen only succeeds from pending, and stores the signed json', async () => {
    const seeded = await seedAgent()
    const row = await insertPendingTaskBudget(pendingInput(seeded.agentId))

    const signed = JSON.stringify({ unsigned: false, signature: '0xsig' })
    const opened = await markOpen(row.id, seeded.agentId, signed)
    expect(opened?.status).toBe('open')
    expect(opened?.delegation_json).toBe(signed)
    expect(opened?.opened_at).not.toBeNull()

    // Already open — a second markOpen is a no-op (returns null).
    expect(await markOpen(row.id, seeded.agentId, signed)).toBeNull()
  })

  it('markClosing succeeds from open or closing (never pending), markClosed accepts open/closing/pending', async () => {
    const seeded = await seedAgent()
    const pending = await insertPendingTaskBudget(pendingInput(seeded.agentId))

    // pending -> closing refused
    expect(await markClosing(pending.id, seeded.agentId, JSON.stringify({}))).toBeNull()
    // pending -> closed (trivial close, never signed)
    const closedFromPending = await markClosed(pending.id, seeded.agentId, null)
    expect(closedFromPending?.status).toBe('closed')
    expect(closedFromPending?.close_tx_hash).toBeNull()
    expect(closedFromPending?.closed_at).not.toBeNull()

    const opened = await insertPendingTaskBudget(pendingInput(seeded.agentId))
    await markOpen(opened.id, seeded.agentId, JSON.stringify({ signed: true }))
    const closing = await markClosing(opened.id, seeded.agentId, JSON.stringify({ userOp: true }))
    expect(closing?.status).toBe('closing')
    expect(closing?.prepared_user_op).toBe(JSON.stringify({ userOp: true }))

    const closedFromClosing = await markClosed(closing!.id, seeded.agentId, '0xtxhash')
    expect(closedFromClosing?.status).toBe('closed')
    expect(closedFromClosing?.close_tx_hash).toBe('0xtxhash')

    // Already closed — markClosed again is a no-op.
    expect(await markClosed(closing!.id, seeded.agentId, '0xtxhash2')).toBeNull()
  })

  it('#3329 review finding A: markClosing from an already-closing row OVERWRITES the stored prepared_user_op', async () => {
    const seeded = await seedAgent()
    const opened = await insertPendingTaskBudget(pendingInput(seeded.agentId))
    await markOpen(opened.id, seeded.agentId, JSON.stringify({ signed: true }))

    const first = await markClosing(opened.id, seeded.agentId, JSON.stringify({ userOp: 'stale' }))
    expect(first?.status).toBe('closing')
    expect(first?.prepared_user_op).toBe(JSON.stringify({ userOp: 'stale' }))

    // A re-prepare (fresh bytes) lands on the SAME closing row, overwriting
    // the stale op rather than being refused by the status guard.
    const second = await markClosing(opened.id, seeded.agentId, JSON.stringify({ userOp: 'fresh' }))
    expect(second?.status).toBe('closing')
    expect(second?.prepared_user_op).toBe(JSON.stringify({ userOp: 'fresh' }))
    expect(second?.id).toBe(first?.id)

    // markClosed from 'closing' still works after the overwrite.
    const closed = await markClosed(second!.id, seeded.agentId, '0xfreshtx')
    expect(closed?.status).toBe('closed')
    expect(closed?.close_tx_hash).toBe('0xfreshtx')
  })

  it('listForAgent status=open excludes pending, closing, closed and expired rows', async () => {
    const seeded = await seedAgent()
    const openRow = await insertPendingTaskBudget(pendingInput(seeded.agentId))
    await markOpen(openRow.id, seeded.agentId, JSON.stringify({ signed: true }))

    const expiredRow = await insertPendingTaskBudget(
      pendingInput(seeded.agentId, { expiresAt: Math.floor(Date.now() / 1000) - 10 }),
    )
    await markOpen(expiredRow.id, seeded.agentId, JSON.stringify({ signed: true }))

    await insertPendingTaskBudget(pendingInput(seeded.agentId)) // stays pending

    const open = await listForAgent(seeded.agentId, { status: 'open' })
    expect(open.map((r) => r.id)).toEqual([openRow.id])

    const all = await listForAgent(seeded.agentId, { status: 'all' })
    expect(all).toHaveLength(3)
  })

  it('listForOwner scopes through agents.user_id', async () => {
    const seeded = await seedAgent()
    const other = await seedAgent()
    const row = await insertPendingTaskBudget(pendingInput(seeded.agentId))

    expect((await listForOwner(seeded.agentId, seeded.userId)).map((r) => r.id)).toEqual([row.id])
    expect(await listForOwner(seeded.agentId, other.userId)).toEqual([])
  })

  it('sumOpenReservedAtomic sums only open, unexpired rows under the given parent hash', async () => {
    const seeded = await seedAgent()
    const now = Math.floor(Date.now() / 1000)

    const a = await insertPendingTaskBudget(pendingInput(seeded.agentId, { maxAtomic: '1000000' }))
    await markOpen(a.id, seeded.agentId, JSON.stringify({}))
    const b = await insertPendingTaskBudget(pendingInput(seeded.agentId, { maxAtomic: '2000000' }))
    await markOpen(b.id, seeded.agentId, JSON.stringify({}))

    // A different parent — excluded.
    const otherParent = await insertPendingTaskBudget(
      pendingInput(seeded.agentId, { maxAtomic: '5000000', parentDelegationHash: `0x${'b'.repeat(64)}` }),
    )
    await markOpen(otherParent.id, seeded.agentId, JSON.stringify({}))

    // Still pending — excluded.
    await insertPendingTaskBudget(pendingInput(seeded.agentId, { maxAtomic: '9000000' }))

    // Expired — excluded.
    const expired = await insertPendingTaskBudget(
      pendingInput(seeded.agentId, { maxAtomic: '3000000', expiresAt: now - 10 }),
    )
    await markOpen(expired.id, seeded.agentId, JSON.stringify({}))

    expect(await sumOpenReservedAtomic(seeded.agentId, PARENT_HASH, now)).toBe(3_000_000n)
  })

  it('selectOpenForPayment matches only open, unexpired, token-matching rows for the agent', async () => {
    const seeded = await seedAgent()
    const now = Math.floor(Date.now() / 1000)
    const row = await insertPendingTaskBudget(pendingInput(seeded.agentId))
    await markOpen(row.id, seeded.agentId, JSON.stringify({}))

    expect(await selectOpenForPayment(row.id, seeded.agentId, USDC, now)).not.toBeNull()
    expect(await selectOpenForPayment(row.id, seeded.agentId, '0x' + 'f'.repeat(40), now)).toBeNull()
    expect(await selectOpenForPayment(row.id, seeded.agentId, USDC, now + 100_000)).toBeNull()

    const other = await seedAgent()
    expect(await selectOpenForPayment(row.id, other.agentId, USDC, now)).toBeNull()
  })
})
