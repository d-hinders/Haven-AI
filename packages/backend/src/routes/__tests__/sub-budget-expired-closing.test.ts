/**
 * #3923 (epic #3919 slice D, P6): an expired `closing` sub-budget is still
 * owed a close signature — the awaiting list lists it, the sign context is
 * served, and `/close` must NOT trivially close it (the stored disable op is
 * still the thing to sign). `pending` and expired `open` stay trivial.
 *
 * Real Postgres + the real agent-auth middleware; only the chain-touching
 * collaborators (the rail's prepare, the account-address derivation, the
 * on-chain disabled probe) are stubbed.
 */
import { createHash, randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyJwt from '@fastify/jwt'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import db from '../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'
import { insertPendingSubBudget } from '../../infra/repositories/sub-budgets.js'
import { serializeUserOp } from '../../rails/execution-rail.js'

const DELEGATE_ACCOUNT = '0x1111111111111111111111111111111111111111'
const { mockPrepareAccountCall, mockDisabled } = vi.hoisted(() => ({
  mockPrepareAccountCall: vi.fn(),
  mockDisabled: vi.fn(),
}))

vi.mock('../../rails/hybrid-provisioning.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../rails/hybrid-provisioning.js')>()),
  computeHybridAccountAddress: vi.fn(async () => DELEGATE_ACCOUNT),
}))
vi.mock('../../rails/delegation-rail.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../rails/delegation-rail.js')>()),
  createDelegationRail: vi.fn(async () => ({ prepareAccountCall: mockPrepareAccountCall })),
}))
vi.mock('../../modules/sub-budgets/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../modules/sub-budgets/index.js')>()),
  isSubBudgetChildDisabledOnChain: (...a: unknown[]) => mockDisabled(...a),
}))

const subBudgetRoutes = (await import('../sub-budgets.js')).default
const agentSubBudgetsOwnerRoutes = (await import('../agent-sub-budgets.js')).default

const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const CHAIN_ID = 8453
let seq = 0

function storedUserOp(): string {
  return serializeUserOp({
    sender: DELEGATE_ACCOUNT,
    nonce: 7n,
    callData: '0xdeadbeef',
    callGasLimit: 100_000n,
    verificationGasLimit: 200_000n,
    preVerificationGas: 50_000n,
    maxFeePerGas: 1_000_000n,
    maxPriorityFeePerGas: 1_000n,
    paymaster: '0x2222222222222222222222222222222222222222',
    paymasterVerificationGasLimit: 30_000n,
    paymasterPostOpGasLimit: 10_000n,
    paymasterData: '0x',
    signature: '0x',
  })
}

describeDb('expired closing sub-budget keeps its signature path (#3923 P6)', () => {
  let app: FastifyInstance
  let issuerKey = ''
  let issuerId = ''
  let ownerId = ''

  beforeAll(async () => {
    process.env.DELEGATION_RAIL_BUNDLER_URL_8453 = 'http://127.0.0.1:1/bundler-stub'
    await initDbHarness()
    app = Fastify({ logger: false })
    await app.register(fastifyJwt, { secret: process.env.JWT_SECRET ?? 'test-secret' })
    await app.register(subBudgetRoutes, { prefix: '/sub-budgets' })
    await app.register(agentSubBudgetsOwnerRoutes, { prefix: '/agents' })
    await app.ready()
  })
  beforeEach(async () => {
    await resetDb()
    mockPrepareAccountCall.mockReset()
    mockDisabled.mockReset()
    mockDisabled.mockResolvedValue(false)
    mockPrepareAccountCall.mockResolvedValue({
      userOperation: { sender: DELEGATE_ACCOUNT },
      userOpHash: `0x${'ab'.repeat(32)}`,
      signingTypedData: { primaryType: 'PackedUserOperation' },
    })
    seq += 1
    issuerKey = `sk_agent_p6_${seq}_${Date.now()}`
    const user = await db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`p6-${seq}-${Date.now()}@test.example`],
    )
    const account = await db.query<{ id: string }>(
      `INSERT INTO smart_accounts (user_id, account_address, chain_id, execution_rail, account_type)
       VALUES ($1, $2, $3, 'delegation', 'delegator_hybrid') RETURNING id`,
      [user.rows[0].id, `0x${String(seq).padStart(40, 'a')}`, CHAIN_ID],
    )
    const agent = await db.query<{ id: string }>(
      `INSERT INTO agents (user_id, account_id, name, delegate_address, api_key_hash, api_key_prefix, status)
       VALUES ($1, $2, 'P6 issuer', $3, $4, 'sk_agent_p6', 'active') RETURNING id`,
      [
        user.rows[0].id,
        account.rows[0].id,
        `0x${String(seq).padStart(40, 'b')}`,
        createHash('sha256').update(issuerKey).digest('hex'),
      ],
    )
    issuerId = agent.rows[0].id
    ownerId = user.rows[0].id
  })
  afterEach(() => vi.clearAllMocks())
  afterAll(async () => {
    delete process.env.DELEGATION_RAIL_BUNDLER_URL_8453
    await app.close()
  })

  async function seedRow(status: string, expiresOffset: number): Promise<string> {
    seq += 1
    const id = randomUUID()
    await insertPendingSubBudget({
      id,
      agentId: issuerId,
      parentAgentId: issuerId,
      parentSubBudgetId: null,
      chainId: CHAIN_ID,
      tokenAddress: USDC_BASE,
      recipientAddress: null,
      parentDelegationHash: `0x${'a'.repeat(64)}`,
      delegationHash: `0x${String(seq).padStart(64, '1')}`,
      delegationJson: JSON.stringify({
        delegate: DELEGATE_ACCOUNT,
        delegator: DELEGATE_ACCOUNT,
        authority: `0x${'ff'.repeat(32)}`,
        caveats: [],
        salt: '0x01',
        signature: `0x${'11'.repeat(65)}`,
      }),
      label: 'p6',
      periodAmountAtomic: '500000',
      expiresAt: Math.floor(Date.now() / 1000) + expiresOffset,
    })
    await db.query(
      `UPDATE agent_sub_budgets SET status = $2, prepared_user_op = $3 WHERE id = $1`,
      [id, status, status === 'closing' ? storedUserOp() : null],
    )
    return id
  }

  const headers = () => ({ authorization: `Bearer ${issuerKey}` })
  const statusOf = async (id: string) =>
    (await db.query<{ status: string }>(`SELECT status FROM agent_sub_budgets WHERE id = $1`, [id])).rows[0].status

  it('expired closing: listed as awaiting, sign context served, /close does NOT trivially close it', async () => {
    const id = await seedRow('closing', -60)

    const awaiting = await app.inject({ method: 'GET', url: '/sub-budgets?status=awaiting_signature', headers: headers() })
    expect(awaiting.statusCode).toBe(200)
    expect((awaiting.json().sub_budgets as Array<{ id: string }>).map((r) => r.id)).toContain(id)

    const ctx = await app.inject({ method: 'GET', url: `/sub-budgets/${id}/sign-context`, headers: headers() })
    expect(ctx.statusCode).toBe(200)
    expect(ctx.json().purpose).toBe('close')

    const close = await app.inject({ method: 'POST', url: `/sub-budgets/${id}/close`, headers: headers() })
    expect(close.statusCode).toBe(200)
    expect(close.json().status).not.toBe('closed')
    expect(close.json().next_action).toBe('sign_then_submit')
    expect(close.json().sign_data.user_op_hash).toBe(`0x${'ab'.repeat(32)}`)
    // Re-prepared (one fresh op overwriting the stored one), still closing.
    expect(mockPrepareAccountCall).toHaveBeenCalledTimes(1)
    expect(await statusOf(id)).toBe('closing')
  })

  it('control: expired open and pending rows stay trivial — /close marks them closed, no signature, no prepare', async () => {
    const expiredOpen = await seedRow('open', -60)
    const pending = await seedRow('pending', 3600)
    for (const id of [expiredOpen, pending]) {
      const res = await app.inject({ method: 'POST', url: `/sub-budgets/${id}/close`, headers: headers() })
      expect(res.statusCode).toBe(200)
      expect(res.json().status).toBe('closed')
      expect(await statusOf(id)).toBe('closed')
    }
    expect(mockPrepareAccountCall).not.toHaveBeenCalled()
  })

  const ownerHeaders = () => ({ authorization: `Bearer ${app.jwt.sign({ sub: ownerId, email: 'p6@test.dev' })}` })

  it('owner DELETE, expired closing: NOT closed — agent_signs_close_then_submits, row stays closing, one prepare', async () => {
    const id = await seedRow('closing', -60)
    const res = await app.inject({ method: 'DELETE', url: `/agents/${issuerId}/sub-budgets/${id}`, headers: ownerHeaders() })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).not.toBe('closed')
    expect(res.json().next_action).toBe('agent_signs_close_then_submits')
    expect(mockPrepareAccountCall).toHaveBeenCalledTimes(1)
    expect(await statusOf(id)).toBe('closing')
  })

  it('owner DELETE control: an expired open row closes trivially, no prepare', async () => {
    const id = await seedRow('open', -60)
    const res = await app.inject({ method: 'DELETE', url: `/agents/${issuerId}/sub-budgets/${id}`, headers: ownerHeaders() })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('closed')
    expect(await statusOf(id)).toBe('closed')
    expect(mockPrepareAccountCall).not.toHaveBeenCalled()
  })

  it('owner DELETE (a): closing row whose child is already disabled on-chain -> closed, no prepare', async () => {
    const id = await seedRow('closing', 3600)
    mockDisabled.mockResolvedValue(true)
    const res = await app.inject({ method: 'DELETE', url: `/agents/${issuerId}/sub-budgets/${id}`, headers: ownerHeaders() })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('closed')
    expect(await statusOf(id)).toBe('closed')
    expect(mockPrepareAccountCall).not.toHaveBeenCalled()
  })

  it('owner DELETE (b): expired closing row, delegating agent REVOKED -> closed in Haven, no prepare', async () => {
    const id = await seedRow('closing', -60)
    await db.query(`UPDATE agents SET status = 'revoked' WHERE id = $1`, [issuerId])
    const res = await app.inject({ method: 'DELETE', url: `/agents/${issuerId}/sub-budgets/${id}`, headers: ownerHeaders() })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('closed')
    expect(await statusOf(id)).toBe('closed')
    expect(mockPrepareAccountCall).not.toHaveBeenCalled()
  })

  it('owner DELETE (c): expired closing row, delegating agent ARCHIVED -> closed in Haven, no prepare', async () => {
    const id = await seedRow('closing', -60)
    await db.query(`UPDATE agents SET archived_at = NOW() WHERE id = $1`, [issuerId])
    const res = await app.inject({ method: 'DELETE', url: `/agents/${issuerId}/sub-budgets/${id}`, headers: ownerHeaders() })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('closed')
    expect(await statusOf(id)).toBe('closed')
    expect(mockPrepareAccountCall).not.toHaveBeenCalled()
  })

  it('owner DELETE: UNEXPIRED closing row of a revoked agent is unchanged — re-prepared, still closing', async () => {
    const id = await seedRow('closing', 3600)
    await db.query(`UPDATE agents SET status = 'revoked' WHERE id = $1`, [issuerId])
    const res = await app.inject({ method: 'DELETE', url: `/agents/${issuerId}/sub-budgets/${id}`, headers: ownerHeaders() })
    expect(res.statusCode).toBe(200)
    expect(res.json().next_action).toBe('agent_signs_close_then_submits')
    expect(await statusOf(id)).toBe('closing')
    expect(mockPrepareAccountCall).toHaveBeenCalledTimes(1)
  })
})
