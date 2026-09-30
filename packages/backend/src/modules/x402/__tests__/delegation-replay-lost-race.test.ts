/**
 * #3392 — the x402 replay's LOST-RACE sites refuse a task_budget mismatch.
 *
 * Two of the three `delegationReplay` call sites run after the intent INSERT
 * loses the idempotency race (`insertMachineIntent` returns null → the
 * concurrent winner is looked up and replayed). That race — a concurrent
 * insert winning between this request's lookup and its write — is not
 * reachable on a real database from a single-connection test, so the issue
 * carves these sites out explicitly: they are proven here with the lookup
 * STUBBED (`findX402IntentByIdempotencyKey`), not the database. The real-DB
 * coverage for the replay comparison itself (the pre-replay call site, on
 * `pending_signature` and `confirmed` rows) lives in
 * `routes/__tests__/x402-task-budget-replay.test.ts`; the 3009 funding-leg
 * machinery behind its site (prepare/insert) is stubbed to the minimum the
 * code must pass before it can lose the race.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
// #3500: the task-budget cap pre-check reads the enforcer's spentMap — never a live chain here.
vi.mock('../../../infra/chain/task-budget-spent-reader.js', () => ({ readTaskBudgetSpent: async () => 0n }))
import { privateKeyToAccount } from 'viem/accounts'

const { mockFindExisting, mockSelect, mockPrepare } = vi.hoisted(() => ({
  mockFindExisting: vi.fn(),
  mockSelect: vi.fn(),
  mockPrepare: vi.fn(),
}))

// The stub under test: the winner lookup every lost-race site falls back to.
vi.mock('../../../infra/repositories/x402-authorizations.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/repositories/x402-authorizations.js')>()
  return { ...actual, findX402IntentByIdempotencyKey: mockFindExisting }
})
vi.mock('../../../rails/delegation-authorization.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../rails/delegation-authorization.js')>()
  return { ...actual, selectDelegation: mockSelect, prepareDelegationPayment: mockPrepare }
})
// The hourly-cap read is the one helper seam this file stubs (spread-mock:
// `existingX402IntentMismatch`/`x402MetadataNetwork`, which replay.ts shares
// from this module, stay REAL). Without it the pre-insert cap check would
// issue real SQL for the synthetic agent id below.
vi.mock('../../../modules/x402/helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../modules/x402/helpers.js')>()
  return { ...actual, agentHourlyX402CapExceeded: vi.fn().mockResolvedValue(null) }
})
vi.mock('../../../infra/chain/delegation-budget-reader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/chain/delegation-budget-reader.js')>()
  return { ...actual, readRemainingBudget: vi.fn().mockResolvedValue({ remainingAtomic: '5000000', fromChain: true }) }
})
vi.mock('../../../rails/hybrid-provisioning.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../rails/hybrid-provisioning.js')>()
  return {
    ...actual,
    computeHybridAccountAddress: vi.fn().mockResolvedValue('0x' + 'dd'.repeat(20)),
    ensureHybridDeployed: vi.fn().mockResolvedValue(undefined),
  }
})
// The lost insert: createPaymentIntent's ON CONFLICT DO NOTHING returns null.
vi.mock('../../../infra/repositories/payment-intents.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/repositories/payment-intents.js')>()
  return { ...actual, insertMachineIntent: vi.fn().mockResolvedValue(null) }
})
vi.mock('../../../infra/chain/x402-binding-signer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/chain/x402-binding-signer.js')>()
  return {
    ...actual,
    signX402ExpectedContext: vi.fn().mockResolvedValue({ version: 2, declaration: 'mocked' }),
    x402PayerContextFields: () => ({}),
    x402PayerWireFields: () => ({}),
  }
})

import { runDelegationAuthorize } from '../../../modules/x402/delegation-authorize.js'
import type { AgentContext } from '../../../middleware/agentAuth.js'
import { buildBudgetDelegation } from '../../../rails/delegation-policy.js'

const DELEGATE_SIGNER = privateKeyToAccount(('0x' + '11'.repeat(32)) as `0x${string}`)
const CHAIN_ID = 84532
const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e'
const MERCHANT = ('0x' + 'cc'.repeat(20)) as string
const ACCOUNT_ADDRESS = ('0x' + 'aa'.repeat(20)) as string
const RESOURCE_URL = 'https://merchant.example/3392-race'
const BUDGET_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const WINNER_ID = '33333333-3333-3333-3333-333333333333'
const NOW = Math.floor(Date.now() / 1000)

const SIGNED_BUDGET = {
  ...buildBudgetDelegation({
    agentId: 'agent-1',
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

/** Minimal prepared funding result — the lost-race cases never reach the 201 assembly. */
const PREPARED = {
  delegationHash: `0x${'34'.repeat(32)}`,
  prepared: {
    userOperation: { sender: '0x' + 'dd'.repeat(20), nonce: '1' },
    userOpHash: `0x${'56'.repeat(32)}`,
    delegateAccountAddress: '0x' + 'dd'.repeat(20),
  },
}

/**
 * The concurrent winner, as the stubbed lookup returns it. Defaults: a
 * confirmed erc7710 leg charging budget A; `to_address` moves to the funding
 * EOA for the 3009 site (there payTo is the agent's own delegate wallet).
 */
function winnerRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: WINNER_ID,
    status: 'confirmed',
    tx_hash: `0x${'99'.repeat(32)}`,
    chain_id: CHAIN_ID,
    account_address: ACCOUNT_ADDRESS,
    token_symbol: 'USDC',
    token_address: USDC,
    amount_raw: '100000',
    amount_human: '0.1',
    to_address: MERCHANT,
    x402_merchant_address: MERCHANT,
    x402_resource_url: RESOURCE_URL,
    machine_metadata: JSON.stringify({ network: 'eip155:84532' }),
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    prepared_user_op: null,
    task_budget_id: BUDGET_A,
    ...overrides,
  }
}

const agent: AgentContext = {
  id: 'agent-1',
  user_id: 'user-1',
  name: 'A',
  delegate_address: DELEGATE_SIGNER.address,
  account_address: ACCOUNT_ADDRESS,
  chain_id: CHAIN_ID,
  status: 'active',
  execution_rail: 'delegation',
  account_type: 'delegator_hybrid',
}

function authorizeInput(overrides: Record<string, unknown> = {}) {
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
    idempotencyKey: 'tb-race-key',
    ...overrides,
  } as Parameters<typeof runDelegationAuthorize>[0]
}

describe('#3392 — the x402 lost-race replay sites refuse a task_budget mismatch', () => {
  /**
   * The lost-race lookup: the FIRST call is the pre-replay miss, every later
   * call is a lost-race fallback that finds the winner. A counting
   * implementation (not positional `mockResolvedValueOnce` chains — the
   * db-mock ratchet is shrink-only on that pattern too).
   */
  let lookups: number

  function stageLostRace(winner: Record<string, unknown> | null): void {
    lookups = 0
    mockFindExisting.mockReset().mockImplementation(() => {
      lookups++
      if (lookups >= 2 && winner) return Promise.resolve(winner)
      return Promise.resolve(null)
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    stageLostRace(winnerRow())
    mockSelect.mockResolvedValue({
      delegation_hash: `0x${'12'.repeat(32)}`,
      delegation_json: JSON.stringify(SIGNED_BUDGET),
      recipient_address: null,
    })
  })

  it('erc7710: the concurrent winner charging budget A 409s a retry naming none', async () => {
    stageLostRace(winnerRow())
    const result = await runDelegationAuthorize(authorizeInput())

    expect(result.code).toBe(409)
    const body = result.body as { error: string; payment_id: string }
    expect(body.error).toBe('idempotencyKey already belongs to a different x402 task_budget')
    expect(body.payment_id).toBe(WINNER_ID)
    // Both lookups ran: the pre-replay miss and the lost-race fallback.
    expect(mockFindExisting).toHaveBeenCalledTimes(2)
  })

  it('erc7710: the winner replays 200 when both sides name no budget', async () => {
    stageLostRace(winnerRow({ task_budget_id: null }))

    const result = await runDelegationAuthorize(authorizeInput())

    expect(result.code).toBe(200)
    expect((result.body as { success: boolean }).success).toBe(true)
    expect((result.body as { payment_id: string }).payment_id).toBe(WINNER_ID)
  })

  it('eip3009 funding leg: the concurrent winner charging budget A 409s a retry naming none', async () => {
    stageLostRace(winnerRow({ to_address: agent.delegate_address }))
    mockPrepare.mockResolvedValue(PREPARED)

    const result = await runDelegationAuthorize(
      authorizeInput({ payTo: agent.delegate_address, settlementScheme: 'eip3009' }),
    )

    expect(result.code).toBe(409)
    expect((result.body as { error: string }).error).toBe('idempotencyKey already belongs to a different x402 task_budget')
    expect(mockFindExisting).toHaveBeenCalledTimes(2)
  })

  it('eip3009 funding leg: the winner replays 200 when both sides name no budget', async () => {
    stageLostRace(winnerRow({ to_address: agent.delegate_address, task_budget_id: null }))
    mockPrepare.mockResolvedValue(PREPARED)

    const result = await runDelegationAuthorize(
      authorizeInput({ payTo: agent.delegate_address, settlementScheme: 'eip3009' }),
    )

    expect(result.code).toBe(200)
    expect((result.body as { payment_id: string }).payment_id).toBe(WINNER_ID)
  })
})
