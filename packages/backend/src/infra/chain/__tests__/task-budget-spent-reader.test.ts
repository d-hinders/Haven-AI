/**
 * #3501: the bounds on the task-budget spent REPORT read — the same lesson
 * the delegation-budget-reader tests paid for once already (#1145's review):
 * `timeout` bounds an ATTEMPT and viem retries three times by default, so a
 * polled endpoint's "2s bound" is a lie unless `retryCount: 0` is pinned.
 * The REPORT read must be bounded (the GET endpoints carrying it are polled
 * by agents); the PAYMENT PRE-CHECK read must stay unbounded (the enforcer's
 * verdict is the gate there, and a slow-but-correct answer beats skipping
 * the check). Both claims are pinned here, against the real module.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockCreatePublicClient = vi.fn()
const mockRpcTransport = vi.fn((chainId: number, opts?: unknown) => ({ chainId, opts }))

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>()
  return { ...actual, createPublicClient: mockCreatePublicClient }
})
vi.mock('../rpc-transport.js', () => ({
  rpcTransport: mockRpcTransport,
  rpcEndpoints: () => ['https://dedicated', 'https://second', 'https://sepolia.base.org'],
}))
vi.mock('../../../rails/delegation-contracts.js', () => ({
  chainForId: () => ({ id: 84532 }),
  getDelegationContracts: () => ({
    delegationManager: '0x' + 'd1'.repeat(20),
    enforcers: { erc20TransferAmount: '0x' + 'e1'.repeat(20) },
  }),
}))

const { readTaskBudgetSpent, readTaskBudgetSpentBounded, TASK_BUDGET_SPENT_READ_TIMEOUT_MS } = await import(
  '../task-budget-spent-reader.js'
)

const HASH = `0x${'cd'.repeat(32)}` as const
const mockReadContract = vi.fn().mockResolvedValue(500n)

beforeEach(() => {
  vi.clearAllMocks()
  mockCreatePublicClient.mockReturnValue({ readContract: mockReadContract })
  mockReadContract.mockResolvedValue(500n)
})

describe('task-budget spent reads (#3501)', () => {
  it('the REPORT read is bounded: per-leg timeout share and retryCount 0, so legs × per-leg ≤ the total', async () => {
    await readTaskBudgetSpentBounded(84532, HASH)
    expect(mockRpcTransport).toHaveBeenCalledTimes(1)
    const [, opts] = mockRpcTransport.mock.calls[0]
    // Three legs → 666ms each; floor(2000/3) keeps the sum inside the 2s total.
    expect(opts).toEqual({ timeout: Math.floor(2000 / 3), retryCount: 0 })
    expect(TASK_BUDGET_SPENT_READ_TIMEOUT_MS).toBe(2_000)
  })

  it('the PRE-CHECK read stays unbounded: no options reach the transport (#3500 contract unchanged)', async () => {
    await readTaskBudgetSpent(84532, HASH)
    const [chainId, opts] = mockRpcTransport.mock.calls[0]
    expect(chainId).toBe(84532)
    expect(opts).toBeUndefined()
  })

  it('reads the enforcer spentMap for (delegationManager, hash) — the authority the chain applies', async () => {
    await readTaskBudgetSpentBounded(84532, HASH)
    expect(mockReadContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: 'spentMap',
        args: ['0x' + 'd1'.repeat(20), HASH],
      }),
    )
  })
})
