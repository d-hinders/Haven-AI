/**
 * #3392 — POST /x402 (delegation rail) idempotent replay refuses a
 * `task_budget` mismatch.
 *
 * `delegationReplay` used to answer 200 for ANY request body once the row was
 * `confirmed`, before any mismatch check; the budget was not part of the pin
 * on any path. The budget comparison now runs on `pending_signature`
 * (unexpired) and `confirmed` rows BEFORE the confirmed-200 branch, at all
 * three call sites (they share `replayContext`). Expired rows are never
 * compared — a lazily expired row frees the key exactly as before (case 4).
 *
 * Every assertion here is about what the replay reads from, or writes to,
 * `payment_intents`, so the idempotency-key lookup, the hourly-cap reads and
 * the lazy-expiry UPDATE run as REAL SQL against seeded rows
 * (`delegation-authorize-refusal-ledger.test.ts` pattern) — never
 * `vi.mock('db.js')`. The mocks are the collaborators this file does not own:
 * the rail's selector/prepare, the hybrid provisioner, the intent INSERT
 * stub, the expected-context signer. The lost-race sites (insert returns
 * null → the winner is replayed) are not reachable on a real database and
 * live in the sibling lost-race file, which stubs the repository lookup.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
// #3500: the task-budget cap pre-check reads the enforcer's spentMap — never a live chain here.
vi.mock('../../infra/chain/task-budget-spent-reader.js', () => ({ readTaskBudgetSpent: async () => 0n }))
import { privateKeyToAccount } from 'viem/accounts'

const {
  mockSelect,
  mockPrepare,
  mockCompute,
  mockEnsureDeployed,
  mockCreateIntent,
  mockSignExpected,
} = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockPrepare: vi.fn(),
  mockCompute: vi.fn(),
  mockEnsureDeployed: vi.fn(),
  mockCreateIntent: vi.fn(),
  mockSignExpected: vi.fn(),
}))

vi.mock('../../rails/delegation-authorization.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rails/delegation-authorization.js')>()
  return { ...actual, selectDelegation: mockSelect, prepareDelegationPayment: mockPrepare }
})
vi.mock('../../infra/chain/delegation-budget-reader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../infra/chain/delegation-budget-reader.js')>()
  return { ...actual, readRemainingBudget: vi.fn().mockResolvedValue({ remainingAtomic: '5000000', fromChain: true }) }
})
vi.mock('../../rails/hybrid-provisioning.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rails/hybrid-provisioning.js')>()
  return { ...actual, computeHybridAccountAddress: mockCompute, ensureHybridDeployed: mockEnsureDeployed }
})
vi.mock('../../infra/repositories/payment-intents.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../infra/repositories/payment-intents.js')>()
  return { ...actual, insertMachineIntent: mockCreateIntent }
})
vi.mock('../../infra/chain/x402-binding-signer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../infra/chain/x402-binding-signer.js')>()
  return {
    ...actual,
    signX402ExpectedContext: (...a: unknown[]) => mockSignExpected(...a),
    x402PayerContextFields: () => ({}),
    x402PayerWireFields: () => ({}),
  }
})

import db from '../../db.js'
import { assertWorkerSchemaAtHead, describeDb, initDbHarness, resetDb } from '../../infra/__tests__/helpers/db-harness.js'
import { runDelegationAuthorize } from '../../modules/x402/delegation-authorize.js'
import type { AgentContext } from '../../middleware/agentAuth.js'
import { buildBudgetDelegation } from '../../rails/delegation-policy.js'

const DELEGATE_SIGNER = privateKeyToAccount(('0x' + '11'.repeat(32)) as `0x${string}`)
const CHAIN_ID = 84532
const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const MERCHANT = ('0x' + 'cc'.repeat(20)) as string
const ACCOUNT_ADDRESS = ('0x' + 'aa'.repeat(20)) as string
const RESOURCE_URL = 'https://merchant.example/3392'
const BUDGET_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const BUDGET_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const NOW = Math.floor(Date.now() / 1000)

const SIGNED_BUDGET = {
  ...buildBudgetDelegation({
    agentId: 'unused-the-seed-assigns-the-real-one',
    chainId: CHAIN_ID,
    treasuryAddress: ACCOUNT_ADDRESS as `0x${string}`,
    delegateAccountAddress: DELEGATE_SIGNER.address as `0x${string}`,
    tokenAddress: USDC as `0x${string}`,
    budgetAtomic: 5_000_000n,
    periodSeconds: 86_400,
    startDate: NOW - 60,
    expiresAt: NOW + 86_400,
    version: 1,
  }),
  signature: '0x' + 'ab'.repeat(65),
}

let seq = 0

/** An OPEN task budget owned by the agent — the FK target for seeded intents. */
async function seedTaskBudget(agentId: string, id: string): Promise<string> {
  await db.query(
    `INSERT INTO agent_task_budgets
       (id, agent_id, chain_id, token_address, recipient_address, parent_delegation_hash,
        delegation_hash, delegation_json, max_atomic, status, expires_at)
     VALUES ($1, $2, $3, $4, NULL, $5, $6, '{}', '1000000', 'open', 9999999999)`,
    [id, agentId, CHAIN_ID, USDC, `0x${String(++seq).padStart(64, '3')}`, `0x${String(++seq).padStart(64, '4')}`],
  )
  return id
}

async function seedAgent(): Promise<{ userId: string; agentId: string; agent: AgentContext }> {
  const tag = `3392-${seq++}-${Date.now()}-${Math.random()}`
  const { rows: userRows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`x402-tbreplay-${tag}@test.example`],
  )
  const userId = userRows[0].id
  const { rows: agentRows } = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name, delegate_address) VALUES ($1, $2, $3) RETURNING id`,
    [userId, `x402-tbreplay-agent-${tag}`, DELEGATE_SIGNER.address],
  )
  const agentId = agentRows[0].id
  const agent: AgentContext = {
    id: agentId,
    user_id: userId,
    name: `x402-tbreplay-agent-${tag}`,
    delegate_address: DELEGATE_SIGNER.address,
    account_address: ACCOUNT_ADDRESS,
    chain_id: CHAIN_ID,
    status: 'active',
    execution_rail: 'delegation',
    account_type: 'delegator_hybrid',
  }
  return { userId, agentId, agent }
}

/**
 * A stored x402 delegation-rail intent, the shape `findX402IntentByIdempotencyKey`
 * (SELECT *) hands `delegationReplay`. Defaults: confirmed with tx_hash,
 * charging budget A, every field matching the default input — per-case
 * overrides move exactly one thing.
 */
async function seedIntent(
  owner: { userId: string; agentId: string },
  key: string,
  overrides: Partial<{ status: string; txHash: string | null; taskBudgetId: string | null; expiresAt: Date }> = {},
): Promise<string> {
  const row = {
    status: 'confirmed',
    txHash: `0x${'99'.repeat(32)}` as string | null,
    taskBudgetId: BUDGET_A as string | null,
    expiresAt: new Date(Date.now() + 10 * 60_000),
    ...overrides,
  }
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO payment_intents
       (agent_id, user_id, account_address, token_symbol, token_address, to_address,
        amount_raw, amount_human, delegate_address, allowance_nonce, sign_hash,
        status, tx_hash, expires_at, execution_rail, chain_id, source, payment_rail,
        x402_resource_url, x402_merchant_address, machine_metadata,
        x402_idempotency_key, machine_idempotency_key, task_budget_id)
     VALUES ($1, $2, $3, 'USDC', $4, $5, '100000', '0.1', $6, 0, $7,
             $8, $9, $10, 'delegation', $11, 'x402', 'x402',
             $12, $13, $14, $15, $15, $16)
     RETURNING id`,
    [
      owner.agentId,
      owner.userId,
      ACCOUNT_ADDRESS,
      USDC,
      MERCHANT,
      DELEGATE_SIGNER.address,
      `0x${'77'.repeat(32)}`,
      row.status,
      row.txHash,
      row.expiresAt,
      CHAIN_ID,
      RESOURCE_URL,
      MERCHANT,
      JSON.stringify({ network: 'eip155:84532' }),
      key,
      row.taskBudgetId,
    ],
  )
  return rows[0].id
}

async function findIntent(id: string): Promise<Record<string, unknown> | undefined> {
  const { rows } = await db.query(`SELECT * FROM payment_intents WHERE id = $1`, [id])
  return rows[0] as Record<string, unknown> | undefined
}

function authorizeInput(agent: AgentContext, overrides: Record<string, unknown> = {}) {
  return {
    agent,
    url: RESOURCE_URL,
    payTo: MERCHANT,
    merchantPayTo: MERCHANT,
    amountRaw: 100_000n,
    amountHuman: '0.1',
    network: 'base-sepolia',
    tokenConfig: { symbol: 'USDC', decimals: 6, address: USDC },
    tokenAddress: USDC,
    idempotencyKey: 'tb-replay-key',
    ...overrides,
  } as Parameters<typeof runDelegationAuthorize>[0]
}

describeDb('x402 delegation-rail replay refuses a task_budget mismatch (#3392)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  afterAll(() => {
    assertWorkerSchemaAtHead()
  })

  beforeEach(async () => {
    await resetDb()
    mockSelect.mockReset()
    mockPrepare.mockReset()
    mockCompute.mockReset()
    mockEnsureDeployed.mockReset()
    mockCreateIntent.mockReset()
    // Default: a usable budget delegation, so a fresh create after the key
    // frees can proceed to the stubbed insert (the ledger test's pattern).
    mockSelect.mockResolvedValue({
      delegation_hash: `0x${'12'.repeat(32)}`,
      delegation_json: JSON.stringify(SIGNED_BUDGET),
      recipient_address: null,
    })
    // The erc7710 branch reads the live remaining budget before it builds a
    // settlement child; a usable enforcer read keeps the #2706 pre-check open.
    vi.mocked(
      (await import('../../infra/chain/delegation-budget-reader.js')).readRemainingBudget,
    ).mockResolvedValue({ remainingAtomic: '5000000', fromChain: true })
    mockCompute.mockResolvedValue('0x' + 'dd'.repeat(20))
    mockEnsureDeployed.mockResolvedValue(undefined)
    mockSignExpected.mockReset()
    mockSignExpected.mockResolvedValue({ version: 2, declaration: 'mocked' })
  })

  it('a confirmed row charging budget A refuses a retry naming budget B with 409 (not 200)', async () => {
    const { userId, agentId, agent } = await seedAgent()
    await seedTaskBudget(agentId, BUDGET_A)
    await seedTaskBudget(agentId, BUDGET_B)
    const paymentId = await seedIntent({ userId, agentId }, 'tb-replay-key', { taskBudgetId: BUDGET_A })

    const result = await runDelegationAuthorize(authorizeInput(agent, { taskBudgetId: BUDGET_B }))

    expect(result.code).toBe(409)
    const body = result.body as { error: string; payment_id: string }
    expect(body.error).toBe('idempotencyKey already belongs to a different x402 task_budget')
    expect(body.payment_id).toBe(paymentId)
    // The refusal happens at the replay stage — no intent was created.
    expect(mockCreateIntent).not.toHaveBeenCalled()
    // A confirmed row is never lazily expired — the row is untouched.
    expect(await findIntent(paymentId)).toBeTruthy()
  })

  it('a confirmed row replays 200 when the retry names the SAME budget', async () => {
    const { userId, agentId, agent } = await seedAgent()
    await seedTaskBudget(agentId, BUDGET_B)
    const paymentId = await seedIntent({ userId, agentId }, 'tb-replay-key', { taskBudgetId: BUDGET_B })

    const result = await runDelegationAuthorize(authorizeInput(agent, { taskBudgetId: BUDGET_B }))

    expect(result.code).toBe(200)
    const body = result.body as { success: boolean; payment_id: string }
    expect(body.success).toBe(true)
    expect(body.payment_id).toBe(paymentId)
    expect(mockCreateIntent).not.toHaveBeenCalled()
  })

  it('an unexpired pending_signature row refuses A→B with 409', async () => {
    const { userId, agentId, agent } = await seedAgent()
    await seedTaskBudget(agentId, BUDGET_A)
    await seedTaskBudget(agentId, BUDGET_B)
    const paymentId = await seedIntent({ userId, agentId }, 'tb-replay-key', {
      status: 'pending_signature',
      txHash: null,
      taskBudgetId: BUDGET_A,
    })

    const result = await runDelegationAuthorize(authorizeInput(agent, { taskBudgetId: BUDGET_B }))

    expect(result.code).toBe(409)
    expect((result.body as { error: string }).error).toBe('idempotencyKey already belongs to a different x402 task_budget')
    expect((result.body as { payment_id: string }).payment_id).toBe(paymentId)
    expect(mockCreateIntent).not.toHaveBeenCalled()
  })

  it('an EXPIRED pending row is never compared — it frees the key and a budget-less retry creates fresh', async () => {
    const { agentId, agent } = await seedAgent()
    await seedTaskBudget(agentId, BUDGET_A)
    const paymentId = await seedIntent({ userId: agent.user_id, agentId }, 'tb-replay-key', {
      status: 'pending_signature',
      txHash: null,
      // Expired: charging budget A would 409 an A→none retry if compared.
      expiresAt: new Date(Date.now() - 60_000),
    })
    mockCreateIntent.mockResolvedValue({ id: 'pay_fresh', status: 'pending_signature', expires_at: 'x' })

    const result = await runDelegationAuthorize(authorizeInput(agent))

    expect(result.code).toBe(201)
    expect((result.body as { payment_id: string }).payment_id).toBe('pay_fresh')
    // The lazy expiry flipped the stale row's status in the database.
    expect(await findIntent(paymentId)).toMatchObject({ status: 'expired' })
    // The fresh intent records NO task budget (none was named on the retry).
    expect(mockCreateIntent.mock.calls[0][0]).toMatchObject({ taskBudgetId: null })
  })
})
