/**
 * The chain reads behind the merchant inbound index (#4903).
 *
 * What is pinned here and nowhere else: the by-hash read returns the USDC
 * transfers the CHAIN says reached the account — never a caller's description
 * of one — and it distinguishes "there is none" from "the chain could not be
 * read". The range read returns every leg in the range with its exact log
 * index, which is what makes a multi-leg transaction countable in full.
 *
 * The provider is mocked at the `getProvider` seam; the settlement token is the
 * registry's own Base Sepolia USDC, so the token filter is exercised for real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ethers } from 'ethers'

const mocks = vi.hoisted(() => ({ getProvider: vi.fn() }))

vi.mock('../../../infra/chain/relayer-reads.js', () => ({ getProvider: mocks.getProvider }))

import {
  readInboundTransactionByTxHash,
  readInboundTransfersByTxHash,
  readInboundTransfersInBlockRange,
  readInboundTransfersViaIndex,
  resetBlockTimeCache,
  type ChainInboundLeg,
  type ChainTransactionRead,
  type IndexReadDeps,
} from '../chain-read.js'

const CHAIN = 84532
/** Circle's canonical Base Sepolia USDC — the registry's settlement asset. */
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const ACCOUNT = '0x' + 'aa'.repeat(20)
const PAYER = '0x' + 'bb'.repeat(20)
const OTHER = '0x' + 'cc'.repeat(20)
const TX = '0x' + '11'.repeat(32)

const IFACE = new ethers.Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])

function transferLog(opts: {
  from?: string
  to?: string
  value?: bigint
  index?: number
  blockNumber?: number
  token?: string
  txHash?: string
}) {
  const encoded = IFACE.encodeEventLog(IFACE.getEvent('Transfer')!, [
    opts.from ?? PAYER,
    opts.to ?? ACCOUNT,
    opts.value ?? 1_000_000n,
  ])
  return {
    address: opts.token ?? USDC,
    topics: encoded.topics,
    data: encoded.data,
    index: opts.index ?? 0,
    blockNumber: opts.blockNumber ?? 100,
    transactionHash: opts.txHash ?? TX,
  }
}

function providerWith(opts: {
  receipt?: unknown
  logs?: unknown[]
  blockTimestamp?: number
  getReceiptError?: Error
  getLogsError?: Error
}) {
  return {
    getTransactionReceipt: vi.fn(async () => {
      if (opts.getReceiptError) throw opts.getReceiptError
      return opts.receipt ?? null
    }),
    getLogs: vi.fn(async () => {
      if (opts.getLogsError) throw opts.getLogsError
      return opts.logs ?? []
    }),
    getBlock: vi.fn(async () => ({ timestamp: opts.blockTimestamp ?? 1_790_000_000 })),
    getBlockNumber: vi.fn(async () => 1_000),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetBlockTimeCache()
})

describe('readInboundTransfersByTxHash (#4903)', () => {
  it('returns the USDC legs the chain says reached the account, with their log indices', async () => {
    const provider = providerWith({
      receipt: {
        hash: TX,
        blockNumber: 100,
        logs: [
          transferLog({ index: 3, value: 1_000_000n }),
          transferLog({ index: 7, value: 2_500_000n }),
        ],
      },
    })
    mocks.getProvider.mockReturnValue(provider)

    const read = await readInboundTransfersByTxHash(CHAIN, ACCOUNT, TX)

    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.legs).toHaveLength(2)
    expect(read.legs.map((leg) => leg.logIndex)).toEqual([3, 7])
    expect(read.legs.map((leg) => leg.amountRaw)).toEqual(['1000000', '2500000'])
    expect(read.legs.every((leg) => leg.payerAddress === PAYER.toLowerCase())).toBe(true)
    expect(read.legs.every((leg) => leg.tokenAddress === USDC.toLowerCase())).toBe(true)
    expect(read.legs[0]!.blockTime.toISOString()).toBe(
      new Date(1_790_000_000 * 1000).toISOString(),
    )
  })

  it('says there is none when the transaction did not pay the account', async () => {
    const provider = providerWith({
      receipt: {
        hash: TX,
        blockNumber: 100,
        logs: [
          // To someone else.
          transferLog({ to: OTHER }),
          // The right recipient, but a different token contract.
          transferLog({ token: OTHER }),
          // The right recipient and token, but zero value.
          transferLog({ value: 0n }),
        ],
      },
    })
    mocks.getProvider.mockReturnValue(provider)

    const read = await readInboundTransfersByTxHash(CHAIN, ACCOUNT, TX)

    expect(read).toEqual({ ok: true, legs: [] })
  })

  it('says there is none for an unknown or unmined hash', async () => {
    mocks.getProvider.mockReturnValue(providerWith({ receipt: null }))
    expect(await readInboundTransfersByTxHash(CHAIN, ACCOUNT, TX)).toEqual({
      ok: true,
      legs: [],
    })
  })

  it('reports an unreadable chain as NOT "none"', async () => {
    mocks.getProvider.mockReturnValue(
      providerWith({ getReceiptError: new Error('rpc down') }),
    )
    expect(await readInboundTransfersByTxHash(CHAIN, ACCOUNT, TX)).toEqual({
      ok: false,
      reason: 'rpc_unavailable',
    })
  })

  it('never returns a caller-supplied value: the receipt is the only source', async () => {
    // The caller names a payer and an amount; the chain says something else.
    const provider = providerWith({
      receipt: {
        hash: TX,
        blockNumber: 100,
        logs: [transferLog({ from: OTHER, value: 42n, index: 1 })],
      },
    })
    mocks.getProvider.mockReturnValue(provider)

    const read = await readInboundTransfersByTxHash(CHAIN, ACCOUNT, TX)

    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.legs).toHaveLength(1)
    expect(read.legs[0]!.payerAddress).toBe(OTHER.toLowerCase())
    expect(read.legs[0]!.amountRaw).toBe('42')
  })
})

describe('readInboundTransfersInBlockRange (#4903)', () => {
  it('returns every leg in the range, each with its own log index', async () => {
    const provider = providerWith({
      logs: [
        transferLog({ index: 0, blockNumber: 100, value: 1_000_000n }),
        transferLog({ index: 4, blockNumber: 100, value: 2_000_000n }),
        transferLog({ index: 9, blockNumber: 101, value: 3_000_000n }),
      ],
    })
    mocks.getProvider.mockReturnValue(provider)

    const read = await readInboundTransfersInBlockRange(CHAIN, ACCOUNT, 100, 101)

    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.legs.map((leg) => leg.logIndex)).toEqual([0, 4, 9])
    expect(read.legs.map((leg) => leg.amountRaw)).toEqual(['1000000', '2000000', '3000000'])
    // One getLogs for the whole range (500-block default span), one getBlock
    // per DISTINCT block.
    expect(provider.getLogs).toHaveBeenCalledTimes(1)
    expect(provider.getBlock).toHaveBeenCalledTimes(2)
  })

  it('chunks a range wider than the provider span', async () => {
    const provider = providerWith({ logs: [] })
    mocks.getProvider.mockReturnValue(provider)

    await readInboundTransfersInBlockRange(CHAIN, ACCOUNT, 1, 1_200)

    // 500-block default span: [1..500], [501..1000], [1001..1200].
    expect(provider.getLogs).toHaveBeenCalledTimes(3)
  })

  it('reports an unreadable chain as NOT an empty range', async () => {
    mocks.getProvider.mockReturnValue(providerWith({ getLogsError: new Error('rpc down') }))
    expect(await readInboundTransfersInBlockRange(CHAIN, ACCOUNT, 1, 10)).toEqual({
      ok: false,
      reason: 'rpc_unavailable',
      partial: null,
    })
  })

  /**
   * The dev Alchemy incident (2026-11-20): one failed chunk discarded every
   * chunk before it, so each tick asked for the whole range again. A failure
   * now keeps the chunks read before it, complete through their last block.
   */
  it('keeps the chunks read before a failed chunk, complete through the last block read', async () => {
    // Keyed on the chunk asked for: [1..500] and [501..1000] answer, [1001..] fails.
    const provider = {
      ...providerWith({}),
      getLogs: vi.fn(async (filter: { fromBlock: number }) => {
        if (filter.fromBlock === 1) return [transferLog({ index: 2, blockNumber: 120 })]
        if (filter.fromBlock === 501) return [transferLog({ index: 5, blockNumber: 730 })]
        throw new Error('429 Too Many Requests')
      }),
    }
    mocks.getProvider.mockReturnValue(provider)

    const read = await readInboundTransfersInBlockRange(CHAIN, ACCOUNT, 1, 1_200)

    expect(read.ok).toBe(false)
    if (read.ok) return
    // [1..500] and [501..1000] were read; [1001..1200] was not.
    expect(read.partial?.readThroughBlock).toBe(1_000)
    expect(read.partial?.legs.map((leg) => leg.blockNumber)).toEqual([120, 730])
    expect(provider.getLogs).toHaveBeenCalledTimes(3)
  })

  it('stops the partial result before a block whose time cannot be read', async () => {
    // Block 100's time reads; block 140's does not.
    const provider = {
      ...providerWith({
        logs: [
          transferLog({ index: 0, blockNumber: 100 }),
          transferLog({ index: 1, blockNumber: 140 }),
        ],
      }),
      getBlock: vi.fn(async (blockNumber: number) => {
        if (blockNumber === 140) throw new Error('rpc down')
        return { timestamp: 1_790_000_000 }
      }),
    }
    mocks.getProvider.mockReturnValue(provider)

    const read = await readInboundTransfersInBlockRange(CHAIN, ACCOUNT, 1, 400)

    expect(read.ok).toBe(false)
    if (read.ok) return
    // Block 100 is complete; nothing at or after block 140 is claimed.
    expect(read.partial?.readThroughBlock).toBe(139)
    expect(read.partial?.legs.map((leg) => leg.blockNumber)).toEqual([100])
  })

  it('is empty when the range is empty', async () => {
    const provider = providerWith({ logs: [] })
    mocks.getProvider.mockReturnValue(provider)
    expect(await readInboundTransfersInBlockRange(CHAIN, ACCOUNT, 10, 9)).toEqual({
      ok: true,
      legs: [],
    })
    expect(provider.getLogs).not.toHaveBeenCalled()
  })
})

describe('readInboundTransactionByTxHash (#4897)', () => {
  it('tells a missing receipt from a receipt with no leg to the account, while the by-hash read folds both to "none"', async () => {
    mocks.getProvider.mockReturnValue(providerWith({}))
    const missing = await readInboundTransactionByTxHash(CHAIN, ACCOUNT, TX)
    expect(missing).toEqual({ ok: true, receiptFound: false, legs: [] })
    // The existing read, which the owner ingest route uses, is unchanged.
    expect(await readInboundTransfersByTxHash(CHAIN, ACCOUNT, TX)).toEqual({ ok: true, legs: [] })

    mocks.getProvider.mockReturnValue(
      providerWith({ receipt: { hash: TX, blockNumber: 100, logs: [transferLog({ to: OTHER })] } }),
    )
    const unpaid = await readInboundTransactionByTxHash(CHAIN, ACCOUNT, TX)
    expect(unpaid).toMatchObject({ ok: true, receiptFound: true, blockNumber: 100, latestBlock: 1_000, legs: [] })
    expect(await readInboundTransfersByTxHash(CHAIN, ACCOUNT, TX)).toEqual({ ok: true, legs: [] })
  })

  it('returns the legs, the receipt block and the head from the same provider', async () => {
    const provider = providerWith({
      receipt: { hash: TX, blockNumber: 100, logs: [transferLog({ index: 2 }), transferLog({ index: 5 })] },
    })
    mocks.getProvider.mockReturnValue(provider)
    const read = await readInboundTransactionByTxHash(CHAIN, ACCOUNT, TX)
    expect(read.ok && read.receiptFound && read.legs.map((l) => l.logIndex)).toEqual([2, 5])
    expect(read.ok && read.receiptFound && read.latestBlock).toBe(1_000)
  })

  it('reports an unreadable receipt or head as not readable, never as none', async () => {
    mocks.getProvider.mockReturnValue(providerWith({ getReceiptError: new Error('down') }))
    expect(await readInboundTransactionByTxHash(CHAIN, ACCOUNT, TX)).toEqual({
      ok: false,
      reason: 'rpc_unavailable',
    })

    const provider = providerWith({ receipt: { hash: TX, blockNumber: 100, logs: [transferLog({})] } })
    provider.getBlockNumber.mockRejectedValue(new Error('down'))
    mocks.getProvider.mockReturnValue(provider)
    expect(await readInboundTransactionByTxHash(CHAIN, ACCOUNT, TX)).toEqual({
      ok: false,
      reason: 'rpc_unavailable',
    })
  })

  it('drops a zero-value transfer: an all-zero transaction has no leg, so it is never a sale', async () => {
    mocks.getProvider.mockReturnValue(
      providerWith({ receipt: { hash: TX, blockNumber: 100, logs: [transferLog({ value: 0n })] } }),
    )
    expect(await readInboundTransactionByTxHash(CHAIN, ACCOUNT, TX)).toMatchObject({
      ok: true,
      receiptFound: true,
      legs: [],
    })
  })

  describe('the further recipients (#4952)', () => {
    const REGISTERED = '0x' + 'AB'.repeat(20)
    const UNNAMED = '0x' + 'dd'.repeat(20)
    const logs = () => [
      transferLog({ index: 1 }),
      transferLog({ index: 2, to: REGISTERED, value: 5n }),
      transferLog({ index: 3, to: UNNAMED }),
    ]

    it('returns the legs to the named addresses apart, with the address lower-cased', async () => {
      mocks.getProvider.mockReturnValue(providerWith({ receipt: { hash: TX, blockNumber: 100, logs: logs() } }))
      const read = await readInboundTransactionByTxHash(CHAIN, ACCOUNT, TX, [REGISTERED])
      expect(read.ok && read.receiptFound && read.otherLegs).toEqual([
        expect.objectContaining({
          toAddress: REGISTERED.toLowerCase(),
          leg: expect.objectContaining({ logIndex: 2, amountRaw: '5' }),
        }),
      ])
      expect(read.ok && read.receiptFound && read.legs.map((l) => l.logIndex)).toEqual([1])
    })

    it('an account named among the addresses is still only an account leg, never an other leg', async () => {
      mocks.getProvider.mockReturnValue(providerWith({ receipt: { hash: TX, blockNumber: 100, logs: logs() } }))
      const read = await readInboundTransactionByTxHash(CHAIN, ACCOUNT, TX, [ACCOUNT, REGISTERED])
      expect(read.ok && read.receiptFound && read.otherLegs?.map((o) => o.leg.logIndex)).toEqual([2])
      expect(read.ok && read.receiptFound && read.legs.map((l) => l.logIndex)).toEqual([1])
    })

    it('matches a log that is not an account leg against the named addresses', async () => {
      mocks.getProvider.mockReturnValue(
        providerWith({ receipt: { hash: TX, blockNumber: 100, logs: [transferLog({ index: 2, to: REGISTERED })] } }),
      )
      const read = await readInboundTransactionByTxHash(CHAIN, ACCOUNT, TX, [REGISTERED])
      expect(read).toMatchObject({ ok: true, receiptFound: true, legs: [] })
      expect(read.ok && read.receiptFound && read.otherLegs).toHaveLength(1)
    })

    it('with no address named the result has no otherLegs key', async () => {
      mocks.getProvider.mockReturnValue(providerWith({ receipt: { hash: TX, blockNumber: 100, logs: logs() } }))
      const read = await readInboundTransactionByTxHash(CHAIN, ACCOUNT, TX)
      expect(read.ok && 'otherLegs' in read).toBe(false)
    })
  })
})

describe('readInboundTransfersViaIndex (#5012)', () => {
  function chainLeg(txHash: string, logIndex: number, blockNumber: number): ChainInboundLeg {
    return {
      txHash,
      logIndex,
      payerAddress: PAYER.toLowerCase(),
      tokenAddress: USDC.toLowerCase(),
      amountRaw: '1000000',
      blockNumber,
      blockTime: new Date(1_790_000_000 * 1000),
    }
  }
  const H1 = '0x' + '01'.repeat(32)
  const H2 = '0x' + '02'.repeat(32)

  /** A receipt the chain has, carrying `legs`, in `blockNumber`. */
  function mined(blockNumber: number, legs: ChainInboundLeg[]): ChainTransactionRead {
    return { ok: true, receiptFound: true, blockNumber, latestBlock: 10_000, legs }
  }

  function depsWith(
    discover: IndexReadDeps['discover'],
    byHash: Record<string, ChainTransactionRead>,
  ): IndexReadDeps & { readByHash: ReturnType<typeof vi.fn> } {
    const readByHash = vi.fn(async (_chain: number, _account: string, txHash: string) => byHash[txHash]!)
    return { discover, readByHash }
  }

  it('costs one index call and no receipt for an idle range', async () => {
    const discover = vi.fn(async () => ({ ok: true as const, txHashes: [] }))
    const deps = depsWith(discover, {})
    expect(await readInboundTransfersViaIndex(CHAIN, ACCOUNT, 100, 400, deps)).toEqual({ ok: true, legs: [] })
    expect(discover).toHaveBeenCalledTimes(1)
    expect(deps.readByHash).not.toHaveBeenCalled()
  })

  it('reads each found transaction from the chain: two byte-identical legs stay two legs, each with its log index', async () => {
    const discover = vi.fn(async () => ({ ok: true as const, txHashes: [H1] }))
    const deps = depsWith(discover, { [H1]: mined(150, [chainLeg(H1, 2, 150), chainLeg(H1, 5, 150)]) })

    const read = await readInboundTransfersViaIndex(CHAIN, ACCOUNT, 100, 400, deps)

    expect(read?.ok).toBe(true)
    if (!read?.ok) return
    expect(read.legs.map((leg) => leg.logIndex)).toEqual([2, 5])
    expect(deps.readByHash).toHaveBeenCalledTimes(1)
    // The index is asked for the settlement token by address, never a caller value.
    expect(discover).toHaveBeenCalledWith(CHAIN, ACCOUNT, USDC.toLowerCase(), 100, 400)
  })

  it('answers null when the index is not configured, so the caller reads the range instead', async () => {
    const deps = depsWith(vi.fn(async () => null), {})
    expect(await readInboundTransfersViaIndex(CHAIN, ACCOUNT, 100, 400, deps)).toBeNull()
  })

  it('keeps a part-way discovery to the blocks it vouches for', async () => {
    const discover = vi.fn(async () => ({ ok: false as const, txHashes: [H1, H2], readThroughBlock: 139 }))
    const deps = depsWith(discover, {
      [H1]: mined(120, [chainLeg(H1, 0, 120)]),
      [H2]: mined(140, [chainLeg(H2, 0, 140)]),
    })

    const read = await readInboundTransfersViaIndex(CHAIN, ACCOUNT, 100, 400, deps)

    expect(read).toEqual({
      ok: false,
      reason: 'rpc_unavailable',
      partial: { legs: [chainLeg(H1, 0, 120)], readThroughBlock: 139 },
    })
  })

  it('stops before the block of a receipt it could not read, never claiming that block', async () => {
    const discover = vi.fn(async () => ({ ok: true as const, txHashes: [H1, H2] }))
    const deps = depsWith(discover, {
      [H1]: mined(150, [chainLeg(H1, 0, 150)]),
      [H2]: { ok: false, reason: 'rpc_unavailable' },
    })

    const read = await readInboundTransfersViaIndex(CHAIN, ACCOUNT, 100, 400, deps)

    // H2 may be in block 150 too, so nothing at or after 150 is claimed.
    expect(read).toEqual({
      ok: false,
      reason: 'rpc_unavailable',
      partial: { legs: [], readThroughBlock: 149 },
    })
  })

  it('treats a receipt the chain does not have as a failure, never as "none" (the index named it)', async () => {
    const discover = vi.fn(async () => ({ ok: true as const, txHashes: [H1, H2] }))
    const deps = depsWith(discover, {
      [H1]: mined(150, [chainLeg(H1, 0, 150)]),
      [H2]: { ok: true, receiptFound: false, legs: [] },
    })

    const read = await readInboundTransfersViaIndex(CHAIN, ACCOUNT, 100, 400, deps)

    expect(read).toEqual({
      ok: false,
      reason: 'rpc_unavailable',
      partial: { legs: [], readThroughBlock: 149 },
    })
  })
})
