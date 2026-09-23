/**
 * The bound on the delegation budget read — the thing #1145 claimed and did
 * not have.
 *
 * #1145 mocked this module out wholesale in its route tests, so nothing ever
 * exercised the real transport configuration. The promotion-batch review found
 * the consequence: `timeout` bounds each ATTEMPT, viem retries three times by
 * default, and a `TimeoutError` is retryable — so the documented 2s was really
 * ~9s. These tests assert the configuration that makes the claim true, because
 * the failure is invisible to any test that stubs the reader.
 *
 * #3255 put the read behind the failover transport, where a timed-out leg
 * falls through to the next endpoint: the per-leg timeout is now the total
 * divided by the leg count, so the whole read keeps the same bound.
 * `rpc-transport.test.ts` proves, against stub nodes, that retryCount 0 makes
 * the worst case legs × per-leg timeout; this file pins the options that make
 * that product equal `REMAINING_READ_TIMEOUT_MS`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockCreatePublicClient = vi.fn()
const mockRpcTransport = vi.fn((chainId: number, opts?: unknown) => ({ chainId, opts }))
const endpoints = vi.hoisted(() => ({ list: ['https://rpc.test'] }))
const mockGetAvailable = vi.fn()

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>()
  return { ...actual, createPublicClient: mockCreatePublicClient }
})
vi.mock('../rpc-transport.js', () => ({
  rpcTransport: mockRpcTransport,
  rpcEndpoints: () => endpoints.list,
}))
vi.mock('@metamask/smart-accounts-kit', () => ({
  createCaveatEnforcerClient: () => ({
    getErc20PeriodTransferEnforcerAvailableAmount: mockGetAvailable,
  }),
}))
vi.mock('../../../rails/delegation-contracts.js', () => ({ chainForId: () => ({ id: 84532 }) }))
vi.mock('../../../rails/delegation-policy.js', () => ({ getDelegationEnvironment: () => ({}) }))

const {
  readRemainingBudget,
  remainingReadLegTimeoutMs,
  REMAINING_READ_TIMEOUT_MS,
  REMAINING_READ_RETRY_COUNT,
} = await import('../delegation-budget-reader.js')

const DELEGATION = JSON.stringify({ delegate: '0xd', delegator: '0xt', caveats: [] })

beforeEach(() => {
  vi.clearAllMocks()
  mockCreatePublicClient.mockReturnValue({})
  endpoints.list = ['https://rpc.test']
})

describe('the read is bounded in the way the docstring claims (#1145 review)', () => {
  it('disables retries — timeout alone bounds an ATTEMPT, not the call', async () => {
    // The defect: viem defaults to retryCount 3, and a TimeoutError falls
    // through shouldRetry to `return true`. Without this option the real
    // ceiling is ~4x the timeout plus backoff.
    mockGetAvailable.mockResolvedValue({ availableAmount: 5n })

    await readRemainingBudget(84532, DELEGATION, '9')

    const [chainId, opts] = mockRpcTransport.mock.calls[0]
    expect(chainId).toBe(84532)
    expect(opts).toMatchObject({
      timeout: REMAINING_READ_TIMEOUT_MS,
      retryCount: REMAINING_READ_RETRY_COUNT,
    })
    expect(REMAINING_READ_RETRY_COUNT).toBe(0)
  })

  it('splits the total across failover legs, so legs × per-leg timeout stays within the total (#3255)', async () => {
    mockGetAvailable.mockResolvedValue({ availableAmount: 5n })
    for (const list of [
      ['https://dedicated'],
      ['https://dedicated', 'https://sepolia.base.org'],
      ['https://dedicated', 'https://second', 'https://sepolia.base.org'],
    ]) {
      endpoints.list = list
      mockRpcTransport.mockClear()
      await readRemainingBudget(84532, DELEGATION, '9')
      const [, opts] = mockRpcTransport.mock.calls[0] as [number, { timeout: number; retryCount: number }]
      expect(opts.timeout).toBe(remainingReadLegTimeoutMs(84532))
      expect(opts.retryCount).toBe(0)
      expect(list.length * opts.timeout).toBeLessThanOrEqual(REMAINING_READ_TIMEOUT_MS)
    }
    expect(REMAINING_READ_TIMEOUT_MS).toBe(2_000)
  })

  it('reports the enforcer amount and marks it as chain-sourced', async () => {
    mockGetAvailable.mockResolvedValue({ availableAmount: 1_500_000n })

    expect(await readRemainingBudget(84532, DELEGATION, '5000000')).toEqual({
      remainingAtomic: '1500000',
      fromChain: true,
    })
  })

  it('falls back to the BUDGET on failure — never to zero', async () => {
    // Zero would tell a funded agent it cannot pay; the budget is the
    // pre-#1145 answer, so a failure is never worse than before.
    mockGetAvailable.mockRejectedValue(new Error('rpc down'))

    expect(await readRemainingBudget(84532, DELEGATION, '5000000')).toEqual({
      remainingAtomic: '5000000',
      fromChain: false,
    })
  })

  it('falls back when the delegation carries no period caveat at all', async () => {
    // The kit throws while searching for the caveat. A delegation of another
    // shape is not something this reader can speak for.
    mockGetAvailable.mockRejectedValue(new Error('caveat not found'))

    const { fromChain } = await readRemainingBudget(84532, DELEGATION, '7')
    expect(fromChain).toBe(false)
  })

  it('falls back on unparseable delegation JSON rather than throwing at the caller', async () => {
    expect(await readRemainingBudget(84532, 'not json', '42')).toEqual({
      remainingAtomic: '42',
      fromChain: false,
    })
    expect(mockGetAvailable).not.toHaveBeenCalled()
  })
})
