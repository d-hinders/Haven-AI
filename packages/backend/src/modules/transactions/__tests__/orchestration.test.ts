import { afterEach, describe, expect, it, vi } from 'vitest'
import { filterEnrichedTransactions, paginateByOffset } from '../orchestration.js'
import type { EnrichedTransaction } from '../types.js'

function enriched(overrides: Partial<EnrichedTransaction> = {}): EnrichedTransaction {
  return {
    hash: '0xaaa',
    type: 'native',
    from: '0xfrom',
    to: '0xto',
    value: '1000',
    valueFormatted: '0.001',
    asset: 'ETH',
    decimals: 18,
    direction: 'out',
    timestamp: 1000,
    blockNumber: 100,
    isError: false,
    chainId: 8453,
    safeId: 'safe-1',
    safeAddress: '0xsafe',
    safeName: 'Main',
    ...overrides,
  }
}

describe('filterEnrichedTransactions (module internals, no HTTP)', () => {
  it('agentId=user selects unattributed OUTBOUND transactions only', () => {
    const outboundUnattributed = enriched({ direction: 'out', agentId: undefined })
    const outboundAttributed = enriched({ direction: 'out', agentId: 'agent-1' })
    const inboundUnattributed = enriched({ direction: 'in', agentId: undefined })

    const result = filterEnrichedTransactions(
      [outboundUnattributed, outboundAttributed, inboundUnattributed],
      { agentId: 'user' },
    )

    expect(result).toEqual([outboundUnattributed])
  })

  it('a specific agentId selects only that agent\'s transactions', () => {
    const forAgentA = enriched({ agentId: 'agent-a' })
    const forAgentB = enriched({ agentId: 'agent-b' })

    expect(filterEnrichedTransactions([forAgentA, forAgentB], { agentId: 'agent-a' })).toEqual([
      forAgentA,
    ])
  })

  it('a native tokenFilter excludes ERC-20 transactions and matches the chain', () => {
    const nativeOnBase = enriched({ type: 'native', chainId: 8453 })
    const erc20OnBase = enriched({ type: 'erc20', chainId: 8453, tokenAddress: '0xusdc' })
    const nativeOnGnosis = enriched({ type: 'native', chainId: 100 })

    const result = filterEnrichedTransactions(
      [nativeOnBase, erc20OnBase, nativeOnGnosis],
      { tokenFilter: { chainId: 8453, address: null } },
    )

    expect(result).toEqual([nativeOnBase])
  })

  it('an ERC-20 tokenFilter matches only that token address (case-insensitively)', () => {
    const usdc = enriched({ type: 'erc20', tokenAddress: '0xUSDC' })
    const dai = enriched({ type: 'erc20', tokenAddress: '0xDAI' })

    const result = filterEnrichedTransactions([usdc, dai], {
      tokenFilter: { chainId: 8453, address: '0xusdc' },
    })

    expect(result).toEqual([usdc])
  })

  it('with no filters, passes every transaction through unchanged', () => {
    const a = enriched({ hash: '0x1' })
    const b = enriched({ hash: '0x2' })
    expect(filterEnrichedTransactions([a, b], {})).toEqual([a, b])
  })
})

describe('paginateByOffset (module internals, no HTTP)', () => {
  it('slices [offset, offset+limit) and reports hasMore when items remain', () => {
    const items = [1, 2, 3, 4, 5]
    expect(paginateByOffset(items, 0, 2)).toEqual({ page: [1, 2], hasMore: true })
    expect(paginateByOffset(items, 2, 2)).toEqual({ page: [3, 4], hasMore: true })
    expect(paginateByOffset(items, 4, 2)).toEqual({ page: [5], hasMore: false })
  })

  it('an offset past the end returns an empty page with hasMore false', () => {
    expect(paginateByOffset([1, 2, 3], 10, 5)).toEqual({ page: [], hasMore: false })
  })
})

describe('aggregateSafeTransactions (module internals, no HTTP)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('tags each fetched transaction with its own Safe and collects per-Safe failures', async () => {
    // The top-level `import { filterEnrichedTransactions, paginateByOffset }` above
    // already cached the real (unmocked) '../aggregate.js' transitively — reset
    // the module registry BEFORE mocking so the dynamic import below picks up
    // the mock rather than the cached real module.
    vi.resetModules()
    vi.doMock('../aggregate.js', () => ({
      fetchSafeTransactions: vi.fn(async ({ safeId }: { safeId: string }) => {
        if (safeId === 'safe-fail') {
          return { transactions: [], hadFailures: true }
        }
        return {
          transactions: [
            {
              hash: `0x${safeId}`,
              type: 'native',
              from: '0xfrom',
              to: '0xto',
              value: '1',
              valueFormatted: '0.000000000000000001',
              asset: 'ETH',
              decimals: 18,
              direction: 'in',
              timestamp: 1,
              blockNumber: 1,
              isError: false,
            },
          ],
          hadFailures: false,
        }
      }),
    }))

    const { aggregateSafeTransactions } = await import('../orchestration.js')
    const log = { warn: vi.fn() } as unknown as import('fastify').FastifyBaseLogger

    const result = await aggregateSafeTransactions(
      [
        { id: 'safe-ok', safe_address: '0xok', chain_id: 8453, name: 'OK' },
        { id: 'safe-fail', safe_address: '0xfail', chain_id: 100, name: 'Fail' },
      ],
      log,
      false,
    )

    expect(result.failedSafeIds).toEqual(['safe-fail'])
    expect(result.merged).toHaveLength(1)
    expect(result.merged[0]).toMatchObject({
      hash: '0xsafe-ok',
      safeId: 'safe-ok',
      chainId: 8453,
      safeAddress: '0xok',
      safeName: 'OK',
    })
  })

  it('a thrown fetch error is caught, logged, and counted as a failed Safe — not propagated', async () => {
    vi.resetModules()
    vi.doMock('../aggregate.js', () => ({
      fetchSafeTransactions: vi.fn(async () => {
        throw new Error('explorer API down')
      }),
    }))

    const { aggregateSafeTransactions } = await import('../orchestration.js')
    const warn = vi.fn()
    const log = { warn } as unknown as import('fastify').FastifyBaseLogger

    const result = await aggregateSafeTransactions(
      [{ id: 'safe-1', safe_address: '0xa', chain_id: 8453, name: 'A' }],
      log,
      false,
    )

    expect(result.merged).toEqual([])
    expect(result.failedSafeIds).toEqual(['safe-1'])
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ safeId: 'safe-1' }),
      'Safe transaction aggregation failed',
    )
  })
})
