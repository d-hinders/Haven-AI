/**
 * Real-DB tests for sub-budgets (#3330) — the two-rows-per-tree shape,
 * agent scoping, the open-parent-child read and the reserved sum are all
 * Postgres behaviour, so they belong on the real harness (epic #1219),
 * exactly like `task-budgets.test.ts` (#3329).
 */
import { randomUUID } from 'node:crypto'
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import {
  findForAgent,
  findForDelegatingAgent,
  findOpenGrantsForAgent,
  findOpenParentChildByHash,
  insertPendingSubBudget,
  listAwaitingSignatureForDelegatingAgent,
  listForAgent,
  listForOwner,
  markClosed,
  markClosing,
  markOpen,
  selectOpenForPayment,
  sumOpenReservedForBudgetDelegation,
  sumOpenReservedForParent,
  type InsertPendingSubBudgetInput,
} from '../sub-budgets.js'

const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const BUDGET_HASH = `0x${'a'.repeat(64)}`

let seq = 0

interface Seeded {
  userId: string
  agentId: string
}

async function seedAgent(nameSuffix: string): Promise<Seeded> {
  const n = ++seq
  const user = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`sb${n}-${Date.now()}-${nameSuffix}@test.example`],
  )
  const userId = user.rows[0].id
  const account = await db.query<{ id: string }>(
    `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
     VALUES ($1, $2, 84532, 'delegation', 'delegator_hybrid') RETURNING id`,
    [userId, `0x${String(n).padStart(40, 'a')}`],
  )
  const agent = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, account_id, name, delegate_address, api_key_hash, api_key_prefix, status)
     VALUES ($1, $2, $3, $4, $5, 'sk_agent_sb', 'active') RETURNING id`,
    [userId, account.rows[0].id, `Sub Budget Agent ${n} ${nameSuffix}`, `0x${String(n).padStart(40, 'b')}`, `hash-sb-${n}-${Date.now()}`],
  )
  return { userId, agentId: agent.rows[0].id }
}

function subInput(agentId: string, over: Partial<InsertPendingSubBudgetInput> = {}): InsertPendingSubBudgetInput {
  const n = ++seq
  return {
    id: randomUUID(),
    agentId,
    parentAgentId: agentId,
    parentSubBudgetId: null,
    chainId: 84532,
    tokenAddress: USDC,
    recipientAddress: null,
    parentDelegationHash: BUDGET_HASH,
    delegationHash: `0x${String(n).padStart(64, '1')}`,
    delegationJson: JSON.stringify({ unsigned: true, n }),
    label: 'Test sub',
    periodAmountAtomic: '500000',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    ...over,
  }
}

/** The canonical two-row tree: A's parent-child + B's grant chained under it. */
async function seedTree(a: Seeded, b: Seeded, over: Partial<InsertPendingSubBudgetInput> = {}) {
  const parentChild = await insertPendingSubBudget(subInput(a.agentId, over))
  const grant = await insertPendingSubBudget(
    subInput(b.agentId, {
      ...over,
      parentAgentId: a.agentId,
      parentSubBudgetId: parentChild.id,
      parentDelegationHash: parentChild.delegation_hash,
      delegationHash: `0x${randomUUID().replaceAll('-', '0')}`,
    }),
  )
  return { parentChild, grant }
}

describeDb('agent_sub_budgets repository (#3330)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('inserts pending and is findable only within its own agent', async () => {
    const a = await seedAgent('a')
    const other = await seedAgent('other')
    const row = await insertPendingSubBudget(subInput(a.agentId))

    expect(row.status).toBe('pending')
    expect(row.parent_sub_budget_id).toBeNull()
    expect(await findForAgent(row.id, a.agentId)).not.toBeNull()
    expect(await findForAgent(row.id, other.agentId)).toBeNull()
  })

  it('#3329 review finding B\u2019s rule carried over: the inserted row id is EXACTLY the caller-minted id — the salt input is real', async () => {
    const a = await seedAgent('a')
    const mintedId = randomUUID()
    const row = await insertPendingSubBudget(subInput(a.agentId, { id: mintedId }))

    expect(row.id).toBe(mintedId)
    expect((await findForAgent(mintedId, a.agentId))?.id).toBe(mintedId)
  })

  it('the tree: B\u2019s grant references A\u2019s parent-child row and its hash', async () => {
    const a = await seedAgent('a')
    const b = await seedAgent('b')
    const { parentChild, grant } = await seedTree(a, b)

    expect(parentChild.parent_sub_budget_id).toBeNull()
    expect(parentChild.agent_id).toBe(a.agentId)
    expect(grant.parent_sub_budget_id).toBe(parentChild.id)
    expect(grant.parent_agent_id).toBe(a.agentId)
    expect(grant.parent_delegation_hash).toBe(parentChild.delegation_hash)
  })

  it('markOpen only succeeds from pending, and stores the signed json', async () => {
    const a = await seedAgent('a')
    const row = await insertPendingSubBudget(subInput(a.agentId))

    const signed = JSON.stringify({ unsigned: false, signature: '0xsig' })
    const opened = await markOpen(row.id, a.agentId, signed)
    expect(opened?.status).toBe('open')
    expect(opened?.delegation_json).toBe(signed)
    expect(opened?.opened_at).not.toBeNull()

    // Already open — a second markOpen is a no-op (returns null).
    expect(await markOpen(row.id, a.agentId, signed)).toBeNull()
  })

  it('findOpenParentChildByHash resolves ONLY an open, parent-child row (never a grant row)', async () => {
    const a = await seedAgent('a')
    const b = await seedAgent('b')
    const { parentChild, grant } = await seedTree(a, b)

    // Pending parent-child: not resolvable.
    expect(await findOpenParentChildByHash(parentChild.delegation_hash, Math.floor(Date.now() / 1000))).toBeNull()
    await markOpen(parentChild.id, a.agentId, JSON.stringify({ signed: true }))
    expect(
      (await findOpenParentChildByHash(parentChild.delegation_hash, Math.floor(Date.now() / 1000)))?.id,
    ).toBe(parentChild.id)

    // A GRANT row is never resolved as a parent-child, whatever its hash:
    // markOpen is DELEGATOR-scoped (parent_agent_id): A opens BOTH rows of
    // its tree — its parent-child AND B's grant (A signs both children,
    // decision log 2026-09-27). B cannot open its own grant.
    expect(await markOpen(grant.id, b.agentId, JSON.stringify({ signed: true }))).toBeNull()
    const openedGrant = await markOpen(grant.id, a.agentId, JSON.stringify({ signed: true }))
    expect(openedGrant?.status).toBe('open')
    expect(await findOpenParentChildByHash(grant.delegation_hash, Math.floor(Date.now() / 1000))).toBeNull()
  })

  it('criterion 3 (cascade): closing A\u2019s parent-child makes B\u2019s grant unresolvable through findOpenParentChildByHash, while A\u2019s budget delegation row is untouched', async () => {
    const a = await seedAgent('a')
    const b = await seedAgent('b')
    const { parentChild, grant } = await seedTree(a, b)
    await markOpen(parentChild.id, a.agentId, JSON.stringify({ signed: true }))
    // markOpen is DELEGATOR-scoped (parent_agent_id): A opens BOTH rows of
    // its tree — its parent-child AND B's grant (A signs both children,
    // decision log 2026-09-27). B cannot open its own grant.
    expect(await markOpen(grant.id, b.agentId, JSON.stringify({ signed: true }))).toBeNull()
    const openedGrant = await markOpen(grant.id, a.agentId, JSON.stringify({ signed: true }))
    expect(openedGrant?.status).toBe('open')

    // B's grant is resolvable through the open middle link...
    expect(await selectOpenForPayment(grant.id, b.agentId, USDC, Math.floor(Date.now() / 1000))).not.toBeNull()

    // ...A revokes its parent-child (owner DELETE, or the close path)...
    await markClosing(parentChild.id, a.agentId, JSON.stringify({ userOp: true }))
    await markClosed(parentChild.id, a.agentId, null)

    // ...and B's grant can no longer find its middle link — payment refuses
    // (the route maps this to sub_budget_parent_mismatch, proven there). B's
    // OWN row is untouched — revoking the parent strand does not close it.
    expect(await findOpenParentChildByHash(grant.parent_delegation_hash, Math.floor(Date.now() / 1000))).toBeNull()
    expect((await findForAgent(grant.id, b.agentId))?.status).toBe('open')
  })

  it('criterion 3 (survivor): revoking B\u2019s grant ends ONLY B\u2019s slice — A\u2019s parent-child stays open and keeps resolving by hash', async () => {
    const a = await seedAgent('a')
    const b = await seedAgent('b')
    const { parentChild, grant } = await seedTree(a, b)
    await markOpen(parentChild.id, a.agentId, JSON.stringify({ signed: true }))
    await markOpen(grant.id, a.agentId, JSON.stringify({ signed: true }))

    // B's grant is resolvable through the open middle link...
    expect(await selectOpenForPayment(grant.id, b.agentId, USDC, Math.floor(Date.now() / 1000))).not.toBeNull()

    // ...B's own child is revoked (B's request, or the owner DELETE on the
    // grant — the delegating agent A's delegate prepares the disable)...
    await markClosing(grant.id, a.agentId, JSON.stringify({ userOp: true }))
    await markClosed(grant.id, a.agentId, null)

    // ...B's slice no longer resolves for payment, but A's parent-child row
    // still resolves by hash: A's budget delegation is intact, A itself keeps
    // spending against it, and any future grant re-issued under the same
    // parent-child hashes back into the tree.
    expect(await selectOpenForPayment(grant.id, b.agentId, USDC, Math.floor(Date.now() / 1000))).toBeNull()
    expect(
      (await findOpenParentChildByHash(parentChild.delegation_hash, Math.floor(Date.now() / 1000)))?.id,
    ).toBe(parentChild.id)
    expect(await findOpenGrantsForAgent(b.agentId)).toEqual([])
    expect((await listForOwner(a.agentId, a.userId)).find((r) => r.id === parentChild.id)?.status).toBe('open')
  })

  it('findOpenGrantsForAgent names the parent agent and only OPEN/closing grants (haven_get_agent\u2019s additive read)', async () => {
    const a = await seedAgent('parent-a')
    const b = await seedAgent('sub-b')
    const { parentChild, grant } = await seedTree(a, b)

    // Pending grant: not reported.
    expect(await findOpenGrantsForAgent(b.agentId)).toEqual([])

    await markOpen(parentChild.id, a.agentId, JSON.stringify({ signed: true }))
    // markOpen is DELEGATOR-scoped (parent_agent_id): A opens BOTH rows of
    // its tree — its parent-child AND B's grant (A signs both children,
    // decision log 2026-09-27). B cannot open its own grant.
    expect(await markOpen(grant.id, b.agentId, JSON.stringify({ signed: true }))).toBeNull()
    const openedGrant = await markOpen(grant.id, a.agentId, JSON.stringify({ signed: true }))
    expect(openedGrant?.status).toBe('open')
    const grants = await findOpenGrantsForAgent(b.agentId)
    expect(grants).toHaveLength(1)
    expect(grants[0].sub_budget_id).toBe(grant.id)
    expect(grants[0].parent_agent_id).toBe(a.agentId)
    expect(grants[0].parent_agent_name).toContain('parent-a')
    expect(grants[0].period_amount_atomic).toBe('500000')
    expect(grants[0].is_expired).toBe(false)
    // The delegating agent does not see its own parent-child as a "grant".
    expect(await findOpenGrantsForAgent(a.agentId)).toEqual([])
  })

  it('findOpenGrantsForAgent reports is_expired for a past-expiry open row (derived, never hidden)', async () => {
    const a = await seedAgent('parent-a')
    const b = await seedAgent('sub-b')
    const { parentChild, grant } = await seedTree(a, b, { expiresAt: Math.floor(Date.now() / 1000) - 10 })
    await markOpen(parentChild.id, a.agentId, JSON.stringify({ signed: true }))
    // markOpen is DELEGATOR-scoped (parent_agent_id): A opens BOTH rows of
    // its tree — its parent-child AND B's grant (A signs both children,
    // decision log 2026-09-27). B cannot open its own grant.
    expect(await markOpen(grant.id, b.agentId, JSON.stringify({ signed: true }))).toBeNull()
    const openedGrant = await markOpen(grant.id, a.agentId, JSON.stringify({ signed: true }))
    expect(openedGrant?.status).toBe('open')

    const grants = await findOpenGrantsForAgent(b.agentId)
    expect(grants).toHaveLength(1)
    expect(grants[0].is_expired).toBe(true)
  })

  it('#3506 listAwaitingSignatureForDelegatingAgent: pending/closing rows for the DELEGATING agent only, parent-child first, never the sub-agent', async () => {
    const a = await seedAgent('delegating-a')
    const b = await seedAgent('sub-b')
    const other = await seedAgent('other')
    const { parentChild, grant } = await seedTree(a, b)
    const now = Math.floor(Date.now() / 1000)

    // Both pending rows are A's to sign — parent-child first, then the grant.
    const awaiting = await listAwaitingSignatureForDelegatingAgent(a.agentId, now)
    expect(awaiting.map((r) => r.id)).toEqual([parentChild.id, grant.id])

    // The sub-agent B holds the grant but never signs it: nothing awaits B.
    expect(await listAwaitingSignatureForDelegatingAgent(b.agentId, now)).toEqual([])
    expect(await listAwaitingSignatureForDelegatingAgent(other.agentId, now)).toEqual([])

    // A row leaves the list once its signature lands (open).
    await markOpen(parentChild.id, a.agentId, JSON.stringify({ signed: true }))
    expect((await listAwaitingSignatureForDelegatingAgent(a.agentId, now)).map((r) => r.id)).toEqual([grant.id])
    await markOpen(grant.id, a.agentId, JSON.stringify({ signed: true }))
    expect(await listAwaitingSignatureForDelegatingAgent(a.agentId, now)).toEqual([])

    // A close owed (closing) puts the row back.
    await markClosing(grant.id, a.agentId, JSON.stringify({ userOp: true }))
    expect((await listAwaitingSignatureForDelegatingAgent(a.agentId, now)).map((r) => r.id)).toEqual([grant.id])

    // A closed row is never listed.
    await markClosed(grant.id, a.agentId, null)
    expect(await listAwaitingSignatureForDelegatingAgent(a.agentId, now)).toEqual([])
  })

  it('#3506 listAwaitingSignatureForDelegatingAgent omits a pending row past its expiry but keeps a closing one', async () => {
    const a = await seedAgent('delegating-a')
    const b = await seedAgent('sub-b')
    const { parentChild, grant } = await seedTree(a, b, { expiresAt: Math.floor(Date.now() / 1000) - 10 })
    const now = Math.floor(Date.now() / 1000)

    // Pending and already expired: signing would open a dead child.
    expect(await listAwaitingSignatureForDelegatingAgent(a.agentId, now)).toEqual([])

    // Closing stays listed regardless of expiry: its stored disable op is the thing to sign.
    await markOpen(parentChild.id, a.agentId, JSON.stringify({ signed: true }))
    await markClosing(parentChild.id, a.agentId, JSON.stringify({ userOp: true }))
    expect((await listAwaitingSignatureForDelegatingAgent(a.agentId, now)).map((r) => r.id)).toEqual([parentChild.id])
    expect(grant.status).toBe('pending')
  })

  it('listForAgent scopes status; listForOwner joins through the owning user', async () => {
    const a = await seedAgent('a')
    const b = await seedAgent('b')
    const other = await seedAgent('other')
    await seedTree(a, b)

    // A sees both rows of its tree; B sees only its grant.
    expect((await listForAgent(a.agentId)).length).toBe(1)
    const bRows = await listForAgent(b.agentId)
    expect(bRows).toHaveLength(1)
    expect(bRows[0].parent_sub_budget_id).not.toBeNull()

    // Owner scope: the owning user sees each agent's rows under THAT agent's
    // id (listForOwner is agent_id AND owner scoped); another user's agent
    // sees nothing.
    const aRows = await listForAgent(a.agentId)
    const ownerListA = await listForOwner(a.agentId, a.userId)
    expect(aRows.length > 0).toBe(true)
    expect(ownerListA.length).toBe(aRows.length)
    const ownerListB = await listForOwner(b.agentId, b.userId)
    expect(bRows.length > 0).toBe(true)
    expect(ownerListB.length).toBe(bRows.length)
    expect(await listForOwner(b.agentId, other.userId)).toEqual([])
  })

  it('sumOpenReservedForParent sums only OPEN grants under ONE parent-child, never other trees', async () => {
    const a = await seedAgent('a')
    const b = await seedAgent('b')
    const c = await seedAgent('c')
    const tree1 = await seedTree(a, b)
    const tree2 = await seedTree(a, c)

    await markOpen(tree1.parentChild.id, a.agentId, JSON.stringify({ signed: true }))
    await markOpen(tree1.grant.id, a.agentId, JSON.stringify({ signed: true }))
    await markOpen(tree2.parentChild.id, a.agentId, JSON.stringify({ signed: true }))
    // tree2's grant stays pending — reserves nothing.

    expect(
      await sumOpenReservedForParent(a.agentId, tree1.parentChild.delegation_hash, Math.floor(Date.now() / 1000)),
    ).toBe(500000n)

    await markOpen(tree2.grant.id, a.agentId, JSON.stringify({ signed: true }))
    expect(
      await sumOpenReservedForParent(a.agentId, tree2.parentChild.delegation_hash, Math.floor(Date.now() / 1000)),
    ).toBe(500000n)
  })
  it('sumOpenReservedForBudgetDelegation (#3518) sums OPEN grants of every tree under ONE budget hash, agent-scoped', async () => {
    // The allowance row's reserved_haven_atomic: keyed by the BUDGET
    // delegation's hash (the parent-child row's parent_delegation_hash), one
    // level above sumOpenReservedForParent's key.
    const a = await seedAgent('a')
    const b = await seedAgent('b')
    const c = await seedAgent('c')
    const nowSec = () => Math.floor(Date.now() / 1000)
    const tree1 = await seedTree(a, b)
    const tree2 = await seedTree(a, c)
    const otherBudget = await seedTree(a, b, { parentDelegationHash: `0x${'e'.repeat(64)}` })
    for (const row of [tree1.parentChild, tree1.grant, tree2.parentChild, otherBudget.parentChild, otherBudget.grant]) {
      await markOpen(row.id, a.agentId, JSON.stringify({ signed: true }))
    }
    // tree2's grant still pending — reserves nothing.
    expect(await sumOpenReservedForBudgetDelegation(a.agentId, BUDGET_HASH, nowSec())).toBe(500000n)

    await markOpen(tree2.grant.id, a.agentId, JSON.stringify({ signed: true }))
    expect(await sumOpenReservedForBudgetDelegation(a.agentId, BUDGET_HASH, nowSec())).toBe(1000000n)

    // Another budget's tree, another agent and an unknown hash never count.
    expect(await sumOpenReservedForBudgetDelegation(a.agentId, `0x${'e'.repeat(64)}`, nowSec())).toBe(500000n)
    expect(await sumOpenReservedForBudgetDelegation(b.agentId, BUDGET_HASH, nowSec())).toBe(0n)
    expect(await sumOpenReservedForBudgetDelegation(a.agentId, `0x${'f'.repeat(64)}`, nowSec())).toBe(0n)

    // A grant past its expiry reserves nothing.
    expect(await sumOpenReservedForBudgetDelegation(a.agentId, BUDGET_HASH, nowSec() + 7200)).toBe(0n)
  })
})
