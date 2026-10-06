/**
 * The ops console's data reads (#3512), proven against a real Postgres —
 * cross-tenant by design, explicit projections, no write. The same SQL runs
 * as the read-only role in `infra/__tests__/ops-readonly-role.test.ts`.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import {
  hexOf,
  seedOpsAccount,
  seedOpsAgent,
  seedOpsDelegation,
  seedOpsFeedback,
  seedOpsIntent,
  seedOpsRefusal,
  seedOpsSystemTx,
  seedOpsUser,
} from '../../__tests__/helpers/ops-fixtures.js'
import {
  escapeLikePrefix,
  OPS_DETAIL_LIST_LIMIT,
  OPS_FEEDBACK_LIST_LIMIT,
  OPS_SEARCH_LIMIT,
  readOpsFeedbackList,
  readOpsOverview,
  readOpsUserDetail,
  searchOpsAccountsByAddress,
  searchOpsAgentById,
  searchOpsAgentsByDelegate,
  searchOpsIntentById,
  searchOpsIntentsByTx,
  searchOpsSystemTxsByTx,
  searchOpsUserById,
  searchOpsUsersByEmail,
} from '../ops-reads.js'

describeDb('ops console data reads (#3512)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
  })

  it('overview counts users, accounts split by account_type, agents by status, active delegations and the last 24 h', async () => {
    const u1 = await seedOpsUser()
    const u2 = await seedOpsUser()
    const acct = await seedOpsAccount(u1)
    await seedOpsAccount(u1, { chainId: 84532, accountType: 'legacy_safe' })
    await seedOpsAccount(u2, { chainId: 8453 })
    const a1 = await seedOpsAgent(u1, { accountId: acct })
    const a2 = await seedOpsAgent(u2, { status: 'revoked' })
    await seedOpsDelegation(a1)
    await seedOpsDelegation(a2, { status: 'revoked' })
    await seedOpsIntent(u1, a1, { status: 'confirmed' })
    await seedOpsIntent(u1, a1, { status: 'failed' })
    await seedOpsIntent(u1, a1, { status: 'confirmed', createdAt: '2020-01-01T00:00:00Z' }) // outside 24 h
    await seedOpsRefusal(u1, a1)
    await seedOpsRefusal(u1, a1, { reason: 'delegation_expired', createdAt: '2020-01-01T00:00:00Z' })

    const o = await readOpsOverview(db)
    expect(o.users).toBe(2)
    expect(o.smartAccounts).toEqual([
      { chain_id: 8453, account_type: 'delegator_hybrid', count: 1 },
      { chain_id: 84532, account_type: 'delegator_hybrid', count: 1 },
      { chain_id: 84532, account_type: 'legacy_safe', count: 1 },
    ])
    expect(o.agentsByStatus).toEqual([
      { status: 'active', count: 1 },
      { status: 'revoked', count: 1 },
    ])
    expect(o.activeDelegations).toBe(1)
    expect(o.paymentIntents24h).toEqual([
      { status: 'confirmed', count: 1 },
      { status: 'failed', count: 1 },
    ])
    expect(o.paymentRefusals24h).toEqual([{ reason: 'delegation_budget_exceeded', count: 1 }])
  })

  it('email search is a case-insensitive prefix, escapes LIKE wildcards, and stops at the hit cap', async () => {
    await seedOpsUser('Grace.Hopper@navy.example')
    await seedOpsUser('graceful@other.example')
    await seedOpsUser('gxace@other.example') // would match a `_` wildcard
    for (let i = 0; i < OPS_SEARCH_LIMIT + 5; i++) await seedOpsUser(`bulk${String(i).padStart(2, '0')}@many.example`)

    expect((await searchOpsUsersByEmail(db, 'GRACE')).map((r) => r.email)).toEqual([
      'Grace.Hopper@navy.example',
      'graceful@other.example',
    ])
    expect(await searchOpsUsersByEmail(db, 'g_ace')).toEqual([])
    expect(escapeLikePrefix('a%b_c\\')).toBe('a\\%b\\_c\\\\%')
    expect(await searchOpsUsersByEmail(db, 'bulk')).toHaveLength(OPS_SEARCH_LIMIT)
    expect(await searchOpsUsersByEmail(db, 'nobody-has-this')).toEqual([])
  })

  it('a UUID finds users, agents and payment intents by id; an unknown id finds nothing', async () => {
    const u = await seedOpsUser()
    const a = await seedOpsAgent(u)
    const p = await seedOpsIntent(u, a)

    expect((await searchOpsUserById(db, u)).map((r) => r.id)).toEqual([u])
    expect((await searchOpsAgentById(db, a)).map((r) => r.id)).toEqual([a])
    expect((await searchOpsIntentById(db, p)).map((r) => ({ id: r.id, user_id: r.user_id, agent_id: r.agent_id }))).toEqual([
      { id: p, user_id: u, agent_id: a },
    ])
    const unknown = '00000000-0000-4000-8000-000000000000'
    expect(await searchOpsUserById(db, unknown)).toEqual([])
    expect(await searchOpsAgentById(db, unknown)).toEqual([])
    expect(await searchOpsIntentById(db, unknown)).toEqual([])
  })

  it('an address finds smart accounts and agent delegate addresses, whatever its case', async () => {
    const u = await seedOpsUser()
    const address = '0xAbCdEf0000000000000000000000000000000001'
    const account = await seedOpsAccount(u, { address })
    const delegate = '0x1111111111111111111111111111111111111aBc'
    const agent = await seedOpsAgent(u, { delegate })

    expect((await searchOpsAccountsByAddress(db, address.toLowerCase())).map((r) => r.id)).toEqual([account])
    expect((await searchOpsAgentsByDelegate(db, delegate.toUpperCase().replace('0X', '0x'))).map((r) => r.id)).toEqual([agent])
    expect(await searchOpsAccountsByAddress(db, hexOf(1, 20))).toEqual([])
  })

  it('a tx hash finds payment intents, and outbound system transactions as user-less hits', async () => {
    const u = await seedOpsUser()
    const a = await seedOpsAgent(u)
    const tx = hexOf(0xabc, 32)
    const p = await seedOpsIntent(u, a, { txHash: tx })
    const sys = await seedOpsSystemTx(tx)

    expect((await searchOpsIntentsByTx(db, tx.toUpperCase().replace('0X', '0x'))).map((r) => r.id)).toEqual([p])
    const sysHits = await searchOpsSystemTxsByTx(db, tx)
    expect(sysHits.map((r) => r.id)).toEqual([sys])
    expect(Object.keys(sysHits[0]).sort()).toEqual(['chain_id', 'created_at', 'id', 'status', 'submitter'])
    expect(await searchOpsSystemTxsByTx(db, hexOf(0xdef, 32))).toEqual([])
  })

  it("user detail is one user's record only, with explicit columns and the 50-row cap", async () => {
    const u = await seedOpsUser('ada@customer.example')
    const other = await seedOpsUser()
    const acct = await seedOpsAccount(u)
    const legacy = await seedOpsAccount(u, { accountType: 'legacy_safe' })
    const a = await seedOpsAgent(u, { accountId: acct })
    const otherAgent = await seedOpsAgent(other)
    await seedOpsDelegation(a, { recipient: hexOf(0x77, 20) })
    await seedOpsDelegation(a, { status: 'revoked' })
    await seedOpsDelegation(otherAgent)
    for (let i = 0; i < OPS_DETAIL_LIST_LIMIT + 3; i++) await seedOpsIntent(u, a, { error: i === 0 ? 'nonce too low' : null })
    const otherIntent = await seedOpsIntent(other, otherAgent)
    await seedOpsRefusal(u, a)
    await seedOpsRefusal(other, otherAgent)

    const d = await readOpsUserDetail(db, u)
    expect(d).not.toBeNull()
    expect(d!.user).toMatchObject({ id: u, email: 'ada@customer.example', name: 'Ada Lovelace' })
    expect(Object.keys(d!.user).sort()).toEqual(['created_at', 'email', 'id', 'name'])
    expect(d!.accounts.map((r) => r.id).sort()).toEqual([acct, legacy].sort())
    expect(d!.accounts.map((r) => r.account_type).sort()).toEqual(['delegator_hybrid', 'legacy_safe'])
    expect(d!.agents.map((r) => r.id)).toEqual([a])
    expect(d!.delegations).toHaveLength(1) // the revoked one and the other user's are out
    expect(d!.delegations[0]).toMatchObject({ agent_id: a, recipient_address: hexOf(0x77, 20), budget_atomic: '1000000' })
    expect(Object.keys(d!.delegations[0])).not.toContain('delegation_json')
    expect(d!.intents).toHaveLength(OPS_DETAIL_LIST_LIMIT)
    expect(d!.intents.every((r) => r.agent_id === a)).toBe(true)
    expect(d!.intents.map((r) => r.id)).not.toContain(otherIntent)
    expect(Object.keys(d!.intents[0])).not.toContain('signature')
    expect(d!.refusals).toHaveLength(1)
    expect(d!.refusals[0]).toMatchObject({ reason: 'delegation_budget_exceeded', source: 'payment' })

    expect(await readOpsUserDetail(db, '00000000-0000-4000-8000-000000000000')).toBeNull()
  })

  it('the feedback list is newest first, only unexpired rows, and respects the page cap (#3602)', async () => {
    const u = await seedOpsUser('grace@customer.example')
    const other = await seedOpsUser()
    const first = await seedOpsFeedback(u, { text: 'first', createdAt: '2026-10-01T09:00:00Z' })
    const second = await seedOpsFeedback(u, { text: 'second', createdAt: '2026-10-02T09:00:00Z' })
    const third = await seedOpsFeedback(u, { text: 'third', createdAt: '2026-10-03T09:00:00Z' })
    await seedOpsFeedback(other, { text: 'another customer', createdAt: '2026-09-30T09:00:00Z' })
    const expired = await seedOpsFeedback(u, {
      text: 'already expired',
      createdAt: '2020-01-01T00:00:00Z',
      expiresAt: '2020-01-08T00:00:00Z',
    })

    const rows = await readOpsFeedbackList(db)
    expect(rows.map((r) => r.id)).toEqual([third, second, first, expect.any(String)])
    expect(rows.map((r) => r.text)).toEqual(['third', 'second', 'first', 'another customer'])
    expect(rows.map((r) => r.id)).not.toContain(expired)
    // The submitter joins through users — the module masks the email.
    expect(rows[0]).toMatchObject({ user_id: u, email: 'grace@customer.example' })
    expect(Object.keys(rows[0]).sort()).toEqual(['created_at', 'email', 'expires_at', 'id', 'text', 'user_id'])

    for (let i = 0; i < OPS_FEEDBACK_LIST_LIMIT + 3; i++) await seedOpsFeedback(u, { text: `bulk ${i}` })
    expect(await readOpsFeedbackList(db)).toHaveLength(OPS_FEEDBACK_LIST_LIMIT)
  })
})
