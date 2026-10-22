import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  filterEnrichedTransactions,
  foldOwnAccountTransfers,
  paginateByOffset,
} from '../orchestration.js'
import type { EnrichedTransaction, SmartAccountRow } from '../types.js'

const ACCOUNT_A = '0x1111111111111111111111111111111111111111'
const ACCOUNT_B = '0x2222222222222222222222222222222222222222'
const FOREIGN = '0x3333333333333333333333333333333333333333'

const ownAccounts: SmartAccountRow[] = [
  { id: 'account-a', account_address: ACCOUNT_A, chain_id: 8453, name: 'Main account' },
  { id: 'account-b', account_address: ACCOUNT_B, chain_id: 8453, name: 'Savings' },
]

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
    timestampSource: 'block',
    blockNumber: 100,
    isError: false,
    chainId: 8453,
    accountId: 'safe-1',
    accountAddress: '0xsafe',
    accountName: 'Main',
    ...overrides,
  }
}

function ownTransferLegs(
  overrides: Partial<EnrichedTransaction> = {},
): [EnrichedTransaction, EnrichedTransaction] {
  const shared = {
    hash: '0xown',
    from: ACCOUNT_A,
    to: ACCOUNT_B,
    value: '500',
    valueFormatted: '0.5',
    chainId: 8453,
    initiatedBy: 'human' as const,
    ...overrides,
  }
  return [
    enriched({
      ...shared,
      direction: 'out',
      accountId: 'account-a',
      accountAddress: ACCOUNT_A,
      accountName: 'Main account',
    }),
    enriched({
      ...shared,
      direction: 'in',
      accountId: 'account-b',
      accountAddress: ACCOUNT_B,
      accountName: 'Savings',
      initiatedBy: undefined,
    }),
  ]
}

describe('foldOwnAccountTransfers (module internals, no HTTP)', () => {
  it('pairs the two legs independent of input order and keeps the outbound fields', () => {
    const [outbound, inbound] = ownTransferLegs({
      paymentId: 'payment-1',
      convertedAmount: '5.25',
      accounting: { provider: 'fortnox', status: 'pushed', externalRef: 'ref', error: null },
    })

    for (const rows of [[outbound, inbound], [inbound, outbound]]) {
      const result = foldOwnAccountTransfers(rows, ownAccounts)
      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        accountId: 'account-a',
        direction: 'out',
        initiatedBy: 'human',
        paymentId: 'payment-1',
        convertedAmount: '5.25',
        accounting: { provider: 'fortnox', status: 'pushed' },
        ownTransfer: {
          toAccountId: 'account-b',
          toAccountName: 'Savings',
          toAccountAddress: ACCOUNT_B,
        },
      })
    }
  })

  it('pairs a multiset one-for-one without consuming an unrelated transfer', () => {
    const [outOne, inOne] = ownTransferLegs({ hash: '0xone', value: '1' })
    const [outTwo, inTwo] = ownTransferLegs({ hash: '0xtwo', value: '2' })
    const unrelated = enriched({ hash: '0xforeign', from: ACCOUNT_A, to: FOREIGN })

    const result = foldOwnAccountTransfers(
      [inTwo, unrelated, outOne, inOne, outTwo],
      ownAccounts,
    )
    expect(result).toHaveLength(3)
    expect(result.filter((row) => row.ownTransfer)).toHaveLength(2)
    expect(result).toContain(unrelated)
  })

  it.each([
    ['agent-initiated', { agentId: 'agent-1', initiatedBy: 'agent' as const }, ownAccounts],
    ['failed enrichment', { initiatedBy: undefined }, ownAccounts],
    ['foreign destination', { to: FOREIGN }, ownAccounts],
    [
      'destination owned by another user',
      {},
      [ownAccounts[0]],
    ],
    [
      'same address on another chain',
      {},
      [ownAccounts[0], { ...ownAccounts[1], chain_id: 100 }],
    ],
  ])('does not fold %s', (_label, overrides, accounts) => {
    const legs = ownTransferLegs(overrides as Partial<EnrichedTransaction>)
    expect(foldOwnAccountTransfers(legs, accounts as SmartAccountRow[])).toEqual(legs)
  })

  it('does not fold a self-send or a missing leg', () => {
    const self = ownTransferLegs({ from: ACCOUNT_A, to: ACCOUNT_A }).map((leg) => ({
      ...leg,
      accountId: 'account-a',
      accountAddress: ACCOUNT_A,
      accountName: 'Main account',
    }))
    expect(foldOwnAccountTransfers(self, ownAccounts)).toEqual(self)

    const [outbound] = ownTransferLegs()
    expect(foldOwnAccountTransfers([outbound], ownAccounts)).toEqual([outbound])
  })

  it('uses the unnamed-account fallback for an empty destination name', () => {
    const result = foldOwnAccountTransfers(ownTransferLegs(), [
      ownAccounts[0],
      { ...ownAccounts[1], name: '' },
    ])
    expect(result[0].ownTransfer?.toAccountName).toBe('Unnamed account')
  })

  it('folds before paging, so adjacent pages neither repeat nor skip the move', () => {
    const [outbound, inbound] = ownTransferLegs()
    const before = enriched({ hash: '0xbefore' })
    const after = enriched({ hash: '0xafter' })
    const folded = foldOwnAccountTransfers([before, outbound, inbound, after], ownAccounts)

    expect(paginateByOffset(folded, 0, 2).page).toEqual([
      before,
      expect.objectContaining({ ownTransfer: expect.any(Object) }),
    ])
    expect(paginateByOffset(folded, 2, 2).page).toEqual([after])
  })
})

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

  it('treats a folded move as neither inbound nor outbound, but includes it for agentId=user', () => {
    const [outbound, inbound] = ownTransferLegs()
    const [move] = foldOwnAccountTransfers([outbound, inbound], ownAccounts)

    expect(filterEnrichedTransactions([move], { direction: 'in' })).toEqual([])
    expect(filterEnrichedTransactions([move], { direction: 'out' })).toEqual([])
    expect(filterEnrichedTransactions([move], { agentId: 'user' })).toEqual([move])
  })

  it('searches both account names on a folded move', () => {
    const [outbound, inbound] = ownTransferLegs()
    const [move] = foldOwnAccountTransfers([outbound, inbound], ownAccounts)

    expect(filterEnrichedTransactions([move], { search: 'main account' })).toEqual([move])
    expect(filterEnrichedTransactions([move], { search: 'savings' })).toEqual([move])
    expect(filterEnrichedTransactions([move], { search: 'merchant' })).toEqual([])
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

describe('aggregateAccountTransactions (module internals, no HTTP)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('tags each fetched transaction with its own account and collects per-account failures', async () => {
    // The top-level `import { filterEnrichedTransactions, paginateByOffset }` above
    // already cached the real (unmocked) '../aggregate.js' transitively — reset
    // the module registry BEFORE mocking so the dynamic import below picks up
    // the mock rather than the cached real module.
    vi.resetModules()
    vi.doMock('../aggregate.js', () => ({
      fetchAccountTransactions: vi.fn(async ({ accountId }: { accountId: string }) => {
        if (accountId === 'safe-fail') {
          return { transactions: [], hadFailures: true }
        }
        return {
          transactions: [
            {
              hash: `0x${accountId}`,
              type: 'native',
              from: '0xfrom',
              to: '0xto',
              value: '1',
              valueFormatted: '0.000000000000000001',
              asset: 'ETH',
              decimals: 18,
              direction: 'in',
              timestamp: 1,
              timestampSource: 'block',
              blockNumber: 1,
              isError: false,
            },
          ],
          hadFailures: false,
        }
      }),
    }))

    const { aggregateAccountTransactions } = await import('../orchestration.js')
    const log = { warn: vi.fn() } as unknown as import('fastify').FastifyBaseLogger

    const result = await aggregateAccountTransactions(
      [
        { id: 'safe-ok', account_address: '0xok', chain_id: 8453, name: 'OK' },
        { id: 'safe-fail', account_address: '0xfail', chain_id: 100, name: 'Fail' },
      ],
      log,
      false,
    )

    expect(result.failedAccountIds).toEqual(['safe-fail'])
    expect(result.merged).toHaveLength(1)
    expect(result.merged[0]).toMatchObject({
      hash: '0xsafe-ok',
      accountId: 'safe-ok',
      chainId: 8453,
      accountAddress: '0xok',
      accountName: 'OK',
    })
  })

  it('a thrown fetch error is caught, logged, and counted as a failed account — not propagated', async () => {
    vi.resetModules()
    vi.doMock('../aggregate.js', () => ({
      fetchAccountTransactions: vi.fn(async () => {
        throw new Error('explorer API down')
      }),
    }))

    const { aggregateAccountTransactions } = await import('../orchestration.js')
    const warn = vi.fn()
    const log = { warn } as unknown as import('fastify').FastifyBaseLogger

    const result = await aggregateAccountTransactions(
      [{ id: 'safe-1', account_address: '0xa', chain_id: 8453, name: 'A' }],
      log,
      false,
    )

    expect(result.merged).toEqual([])
    expect(result.failedAccountIds).toEqual(['safe-1'])
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'safe-1' }),
      'Account transaction aggregation failed',
    )
  })
})
