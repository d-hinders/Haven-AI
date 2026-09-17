/**
 * The two #3052 ledger writers on the EIP-3009 funding leg of the x402
 * authorize path, proven against REAL Postgres (epic #3056 slice 1;
 * the money-path playbook §2: a refusal row's landing is database behavio
 * — the insert itself plus the migration 086 CHECKs that pin the reason and
 * the detail — and the #1227/#1219 testing strategy puts that on this harness
 * rather than behind positional DB mocking).
 *
 * The route file `routes/__tests__/x402-delegation.test.ts` owns the other
 * half: which response a leg answers and that it stays byte-identical with
 * the ledger succeeding AND failing. Here the ledger is real all the way do
 * to the table. The mocks are collaborators this file does not own and the
 * chain: the delegation rail's selector, prepare, budget reader, the hybrid
 * provisioner, the intent insert, the expected-context signer, and the
 * authentication middleware (it hands the agent row's identity to the hand
 * the ledger FKs against). The three reads the handler itself runs on the
 * database — the idempotency-key lookup and the two hourly-cap reads — go t
 * real SQL against seeded rows, which is the point: the row the writer lea
 * is read back from the same database the refusal was booked into.
 *
 * Mutation-tested (#3052): removing the 502-catch writer turns red
 * 'a DEGRADED read (fromChain:false) plus an enforcer revert ... books it a
 * delegation_budget_exceeded'; removing the 403-branch writer turns red
 * 'a null prepare answers the unpinned-budget 403 and books it as
 * no_delegation_for_target'. Both proofs also flip the ledger-side write
 * itself (the row, not only the call) — the classifier's null path is prove
 * as booking NOTHING at all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { privateKeyToAccount } from 'viem/accounts'
const DELEGATE_SIGNER = privateKeyToAccount(('0x' + '11'.repeat(32)) as `0x${string}`)

const {
  mockSelect,
  mockPrepare,
  mockReadRemaining,
  mockCompute,
  mockEnsureDeployed,
  mockCreateIntent,
  mockSignExpected,
  mockGetTokenPrice,
} = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockPrepare: vi.fn(),
  mockReadRemaining: vi.fn(),
  mockCompute: vi.fn(),
  mockEnsureDeployed: vi.fn(),
  mockCreateIntent: vi.fn(),
  mockSignExpected: vi.fn(),
  mockGetTokenPrice: vi.fn(),
}))

// The rail's chain-touching collaborators: mocked, because the unit under
// test is what the handler decides to BOOK, and those collaborators' own
// semantics have their proven suites (rails/, infra/chain/). Spread from the
// ORIGINAL modules so transitive imports of unmocked exports (the module
// graph reaches `getIntentStatus` through helpers.ts, `withTransaction`
// through others) resolve against the real code.
vi.mock('../../../rails/delegation-authorization.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../rails/delegation-authorization.js')>()
  return { ...actual, selectDelegation: mockSelect, prepareDelegationPayment: mockPrepare }
})
vi.mock('../../../infra/chain/delegation-budget-reader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/chain/delegation-budget-reader.js')>()
  return { ...actual, readRemainingBudget: (...a: unknown[]) => mockReadRemaining(...a) }
})
vi.mock('../../../rails/hybrid-provisioning.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../rails/hybrid-provisioning.js')>()
  return {
    ...actual,
    computeHybridAccountAddress: mockCompute,
    ensureHybridDeployed: mockEnsureDeployed,
  }
})
vi.mock('../../../infra/repositories/payment-intents.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/repositories/payment-intents.js')>()
  return { ...actual, insertMachineIntent: mockCreateIntent }
})
vi.mock('../x402-delegation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../x402-delegation.js')>()
  return {
    ...actual,
    buildSettlementDelegation: vi.fn(),
    typedDataDigest: vi.fn(() => `0x${'77'.repeat(32)}`),
  }
})
// The x402 binding signer signs the expected-context declaration. Mocked:
// the real one refuses to load its key without X402_BINDING_PRIVATE_KEY, and
// the declaration's content is not what this suite is about.
vi.mock('../../../infra/chain/x402-binding-signer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/chain/x402-binding-signer.js')>()
  return {
    ...actual,
    signX402ExpectedContext: (...a: unknown[]) => mockSignExpected(...a),
    x402PayerContextFields: () => ({}),
    x402PayerWireFields: () => ({}),
  }
})

// Prices are STUBBED, not fetched: the ledger books `usd_value`/`eur_value`
// through `getFiatValuesForTokenAmount`, and the refusal-ledger suite stubs
// the same seam for the same two reasons — no network in the suite, and a
// known price is what makes the booking arithmetic assertable (the sibling
// modules/payments/__tests__/refusal-ledger.test.ts pins that math). The
// booking PATH itself stays real: only the price read is replaced.
vi.mock('../../../infra/prices.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/prices.js')>()
  return { ...actual, getTokenPrice: (...a: unknown[]) => mockGetTokenPrice(...a) }
})

import { buildBudgetDelegation } from '../../../rails/delegation-policy.js'
import db from '../../../db.js'
import { assertWorkerSchemaAtHead, describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { runDelegationAuthorize } from '../delegation-authorize.js'
import type { AgentContext } from '../../../middleware/agentAuth.js'

const CHAIN_ID = 84532
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const FUNDING_EOA = DELEGATE_SIGNER.address // payTo = the delegate EOA selects the 3009 leg
const MERCHANT = ('0x' + 'cc'.repeat(20)) as string
const ACCOUNT_ADDRESS = ('0x' + 'aa'.repeat(20)) as string
const RESOURCE_URL = 'https://merchant.example/3052'
const NOW = Math.floor(Date.now() / 1000)

/** The funding-leg budget: open (recipient_address NULL), so 3009-mode can fund it. */
const SIGNED_BUDGET = {
  ...buildBudgetDelegation({
    agentId: 'unused-the-seed-assigns-the-real-one',
    chainId: CHAIN_ID,
    treasuryAddress: ACCOUNT_ADDRESS as `0x${string}`,
    delegateAccountAddress: FUNDING_EOA as `0x${string}`,
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

/** Seed the agent row whose identity the handler books against. */
async function seedAgent(): Promise<{ userId: string; agentId: string; agent: AgentContext }> {
  const tag = `3052-${seq++}-${Date.now()}-${Math.random()}`
  const { rows: userRows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`x402-refusals-${tag}@test.example`],
  )
  const userId = userRows[0].id
  const { rows: agentRows } = await db.query<{ id: string }>(
    `INSERT INTO agents (user_id, name) VALUES ($1, $2) RETURNING id`,
    [userId, `x402-refusal-agent-${tag}`],
  )
  const agentId = agentRows[0].id
  const agent: AgentContext = {
    id: agentId,
    user_id: userId,
    name: `x402-refusal-agent-${tag}`,
    delegate_address: DELEGATE_SIGNER.address,
    account_address: ACCOUNT_ADDRESS,
    chain_id: CHAIN_ID,
    status: 'active',
    execution_rail: 'delegation',
    account_type: 'delegator_hybrid',
  }
  return { userId, agentId, agent }
}

function authorizeInput(agent: AgentContext, overrides: Record<string, unknown> = {}) {
  return {
    agent,
    url: RESOURCE_URL,
    payTo: FUNDING_EOA,
    merchantPayTo: MERCHANT,
    amountRaw: 100_000n,
    amountHuman: '0.1',
    network: 'base-sepolia',
    tokenConfig: { symbol: 'USDC', decimals: 6, address: USDC },
    tokenAddress: USDC,
    ...overrides,
  } as Parameters<typeof runDelegationAuthorize>[0]
}

interface RefusalRow {
  id: string
  user_id: string
  agent_id: string
  account_id: string | null
  chain_id: number
  token_symbol: string
  amount_atomic: string
  usd_value: string | null
  eur_value: string | null
  merchant_to: string | null
  resource_url: string | null
  reason: string
  source: string
  detail: Record<string, unknown> | null
  attempts: number
}

async function refusalRows(agentId: string): Promise<RefusalRow[]> {
  const { rows } = await db.query<RefusalRow>(
    `SELECT id, user_id, agent_id, account_id, chain_id, token_symbol, amount_atomic,
            usd_value, eur_value, merchant_to, resource_url, reason, source, detail, attempts
       FROM payment_refusals WHERE agent_id = $1 ORDER BY created_at, id`,
    [agentId],
  )
  return rows
}

/**
 * Poll (bounded) until the detached write has landed: the recorder returns
 * synchronously and its write crosses real I/O turns, so a single microtask
 * flush cannot observe it. Bounded so a vanished write fails the test loudl
 * rather than hanging it.
 */
async function waitForRows(agentId: string, expected: number): Promise<RefusalRow[]> {
  for (let i = 0; i < 100; i++) {
    const rows = await refusalRows(agentId)
    if (rows.length >= expected) return rows
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const final = await refusalRows(agentId)
  expect(final, `refusal rows never landed (wanted ${expected})`).toHaveLength(expected)
  return final
}

describeDb('the x402 authorize refusal ledger writers on the funding leg (#3052)', () => {
  beforeAll(async () => {
    await initDbHarness()
    // The two reads the handler runs itself (the idempotency-key lookup and
    // the hourly cap) answer from the seeded agent row through real SQL;
    // nothing seeds a payment intent here, so both find nothing and the
    // authorize proceeds to the leg under test.
    mockSignExpected.mockResolvedValue({ version: 2, declaration: 'mocked' })
    // USDC at $1 / €0.92 — the stub the fiat booking arithmetic is pinned
    // against (the same numbers the refusal-ledger suite pins its math on).
    mockGetTokenPrice.mockResolvedValue({ usd: 1, eur: 0.92, sek: 10.5 })
  })

  afterAll(() => {
    assertWorkerSchemaAtHead()
  })

  beforeEach(async () => {
    await resetDb()
    mockSelect.mockReset()
    mockPrepare.mockReset()
    mockReadRemaining.mockReset()
    mockCompute.mockReset()
    mockEnsureDeployed.mockReset()
    mockCreateIntent.mockReset()
    mockSignExpected.mockReset()
    // Default: a usable enforcer read (the full budget available), so the
    // #2706 pre-check stays put and control passes to the prepare seam.
    mockReadRemaining.mockResolvedValue({ remainingAtomic: '5000000', fromChain: true })
  })

  it('a DEGRADED read (fromChain:false) plus an enforcer revert at the prepare seam books delegation_budget_exceeded', async () => {
    // The epic's promotion box, on the real database. With the #2706
    // pre-check's read degraded the fail-fast gate fails open and the
    // period-budget enforcer inside prepare is the only gate left; its rever
    // arrives at the 502 catch, where the classifier names it and the ledge
    // records it. Before #3052 the x402 authorize path booked nothing her
    // while the byte-identical POST /payments sibling booked it.
    // MUTATION: removing the catch's writer turns this red.
    const { userId, agentId, agent } = await seedAgent()
    mockSelect.mockResolvedValue({
      delegation_hash: `0x${'12'.repeat(32)}`,
      delegation_json: JSON.stringify(SIGNED_BUDGET),
      recipient_address: null,
    })
    mockReadRemaining.mockResolvedValue({ remainingAtomic: '1', fromChain: false })
    mockPrepare.mockRejectedValue(
      new Error('EstimateGasExecutionError: ERC20PeriodTransferEnforcer:transfer-amount-exceeded'),
    )

    const result = await runDelegationAuthorize(authorizeInput(agent))

    // The refusal response stays the raw 502 it has always been — the write
    // records the decision, it does not make it.
    expect(result.code).toBe(502)
    expect((result.body as { error: string }).error)
      .toMatch(/Delegation-rail funding authorization failed \(on-chain policy or bundler\)/)

    const rows = await waitForRows(agentId, 1)
    const row = rows[0]
    expect(row.reason).toBe('delegation_budget_exceeded')
    expect(row.source).toBe('x402_authorize')
    // The merchant column holds the MERCHANT, not the funding target: on this
    // leg payTo is the agent's own delegate EOA, and a row that named it as
    // the merchant would be the account confusion the migration 086 CHECK
    // and the detail allowlist exist to make impossible.
    expect(row.merchant_to).toBe(MERCHANT.toLowerCase())
    expect(row.user_id).toBe(userId)
    expect(row.agent_id).toBe(agentId)
    expect(row.chain_id).toBe(CHAIN_ID)
    expect(row.token_symbol).toBe('USDC')
    expect(row.amount_atomic).toBe('100000')
    expect(row.resource_url).toBe(RESOURCE_URL)
    expect(row.detail).toEqual({ error_code: 'delegation_budget_exceeded' })
    expect(row.attempts).toBe(1)
  })

  it('a null prepare answers the unpinned-budget 403 and books it as no_delegation_for_target', async () => {
    // `prepareDelegationPayment` resolves null: no open (unpinned) budget
    // delegation can fund the EOA. The sibling branches for the identical
    // condition — the erc7710 no-delegation 403 and the POST /payments
    // funding 403 — booked it from the start; this leg booked nothing unt
    // til #3052 added the writer below.
    // MUTATION: removing the branch's writer turns this red.
    const { userId, agentId, agent } = await seedAgent()
    mockSelect.mockResolvedValue({
      delegation_hash: `0x${'12'.repeat(32)}`,
      delegation_json: JSON.stringify(SIGNED_BUDGET),
      recipient_address: null,
    })
    mockPrepare.mockResolvedValue(null)

    const result = await runDelegationAuthorize(authorizeInput(agent))

    expect(result.code).toBe(403)
    expect((result.body as { error: string }).error)
      .toMatch(/Agent has no delegation able to fund EIP-3009 settlement for USDC/)

    const rows = await waitForRows(agentId, 1)
    const row = rows[0]
    expect(row.reason).toBe('no_delegation_for_target')
    expect(row.source).toBe('x402_authorize')
    expect(row.merchant_to).toBe(MERCHANT.toLowerCase())
    expect(row.user_id).toBe(userId)
    expect(row.agent_id).toBe(agentId)
    expect(row.amount_atomic).toBe('100000')
    expect(row.resource_url).toBe(RESOURCE_URL)
    expect(row.detail).toEqual({ error_code: 'no_delegation_for_target' })
    expect(mockCreateIntent).not.toHaveBeenCalled()
  })

  it('an outage at the prepare seam is not a refusal: the 502 stands and the ledger books nothing', async () => {
    // The classifier's null path, end to end on the real database. A
    // bundler/transport failure is not a policy refusal — the guardrails
    // refused nothing, the infrastructure broke — so the catch classifies it
    // as null and no INSERT reaches the table, which a COUNT over the agent
    // rows confirms.
    const { agentId, agent } = await seedAgent()
    mockSelect.mockResolvedValue({
      delegation_hash: `0x${'12'.repeat(32)}`,
      delegation_json: JSON.stringify(SIGNED_BUDGET),
      recipient_address: null,
    })
    mockPrepare.mockRejectedValue(new Error('fetch failed: bundler unreachable (ETIMEDOUT)'))

    const result = await runDelegationAuthorize(authorizeInput(agent))

    expect(result.code).toBe(502)
    // Give any detached write every chance to arrive before reading the
    // table back: had one been issued, this poll would have found it.
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(await refusalRows(agentId)).toHaveLength(0)
  })

  it('a booked expiry revert is recorded: an expired-caveat revert at the seam books delegation_expired', async () => {
    // The timestamp enforcer's revert text, the way the kit surfaces it.
    // MUTATION-adjacent: removing the catch's writer also turns this red.
    const { agentId, agent } = await seedAgent()
    mockSelect.mockResolvedValue({
      delegation_hash: `0x${'12'.repeat(32)}`,
      delegation_json: JSON.stringify(SIGNED_BUDGET),
      recipient_address: null,
    })
    mockPrepare.mockRejectedValue(
      new Error("before execution's timestamp is before this caveat's beforeThreshold"),
    )

    const result = await runDelegationAuthorize(authorizeInput(agent))

    expect(result.code).toBe(502)
    const rows = await waitForRows(agentId, 1)
    expect(rows[0].reason).toBe('delegation_expired')
    expect(rows[0].source).toBe('x402_authorize')
    expect(rows[0].merchant_to).toBe(MERCHANT.toLowerCase())
    expect(rows[0].detail).toEqual({ error_code: 'delegation_expired' })
  })
})
