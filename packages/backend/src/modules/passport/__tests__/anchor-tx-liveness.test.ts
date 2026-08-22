/**
 * #1745 — `classifyAnchorTxLiveness`: the probe that must never guess.
 *
 * The one question worth testing here is not "does it return the right
 * string", it is **what does it take to get `'dead'` out of it**. Death is the
 * answer that unlocks a second real, revocable credential, so every test below
 * either withholds it or pins the single fact that earns it: the transaction's
 * nonce slot consumed by something other than the transaction.
 *
 * The chain is a collaborator this module does not own, so it is mocked
 * (`docs/contributing/testing-strategy.md`). The durable-record read is the
 * data layer and is exercised against real Postgres in
 * `infra/repositories/__tests__/outbound-txs.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const RELAYER = '0x' + '11'.repeat(20)
const TX = '0x' + 'ab'.repeat(32)

const getTransaction = vi.fn()
const getTransactionReceipt = vi.fn()
const getTransactionCount = vi.fn()
const getBlockNumber = vi.fn()
const getBlock = vi.fn()
let provider: unknown = {
  getTransaction,
  getTransactionReceipt,
  getTransactionCount,
  getBlockNumber,
  getBlock,
}

/** Chain head, and the finalized block a healthy OP-stack node reports. */
const HEAD = 1_000
const FINALIZED = 900

vi.mock('../../../infra/relayer.js', async () => {
  const actual = await vi.importActual<typeof import('../../../infra/relayer.js')>(
    '../../../infra/relayer.js',
  )
  return { ...actual, getRelayer: () => ({ address: RELAYER, provider }) }
})

const findOutboundTxByHash = vi.fn()
vi.mock('../../../infra/repositories/outbound-txs.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../infra/repositories/outbound-txs.js')
  >('../../../infra/repositories/outbound-txs.js')
  return { ...actual, findOutboundTxByHash: (...a: unknown[]) => findOutboundTxByHash(...a) }
})

const { classifyAnchorTxLiveness, SETTLED_CHAIN_READ_DEPTH_BLOCKS } = await import(
  '../attestation.js'
)

/** A durable record stamped at broadcast: nonce 7, still open. */
function record(overrides: Record<string, unknown> = {}) {
  return { chain_id: 84532, nonce: '7', status: 'broadcast', tx_hash: TX, ...overrides }
}

/**
 * Nonce as of a given block. Defaults to "slot 7 still open everywhere"; a
 * test that wants a burn says so per block, which is what lets the reorg case
 * (burned at the head, open at the finalized block) be expressed at all.
 */
function nonceByBlock(counts: Record<number, number>, fallback = 7) {
  return async (_addr: string, block: number) => counts[block] ?? fallback
}

beforeEach(() => {
  provider = {
    getTransaction,
    getTransactionReceipt,
    getTransactionCount,
    getBlockNumber,
    getBlock,
  }
  getTransaction.mockReset().mockResolvedValue(null)
  getTransactionReceipt.mockReset().mockResolvedValue(null)
  getTransactionCount.mockReset().mockResolvedValue(7)
  getBlockNumber.mockReset().mockResolvedValue(HEAD)
  getBlock.mockReset().mockResolvedValue({ number: FINALIZED })
  findOutboundTxByHash.mockReset().mockResolvedValue(record())
})

describe('what earns a `dead` verdict (#1745)', () => {
  it('the ONLY path to dead: the nonce slot burned by something else, receipt still absent', async () => {
    getTransactionCount.mockResolvedValue(8) // nonce 7 consumed, not by us
    expect(await classifyAnchorTxLiveness(84532, TX)).toBe('dead')
    // Read as of the FINALIZED block, never the head and never `pending` — a
    // pending count includes the stuck transaction itself and could never
    // show its own slot as consumed.
    expect(getTransactionCount).toHaveBeenCalledWith(RELAYER, FINALIZED)
  })

  it('the nonce still OPEN is live — this is the fee-stuck attest, and it may mine', async () => {
    getTransactionCount.mockResolvedValue(7) // slot 7 not yet mined
    expect(await classifyAnchorTxLiveness(84532, TX)).toBe('live')
  })

  it('a nonce BEHIND the record is live — the relayer has not even reached the slot', async () => {
    getTransactionCount.mockResolvedValue(3)
    expect(await classifyAnchorTxLiveness(84532, TX)).toBe('live')
  })

  it('a large nonce compares numerically, not lexically — "10" is past "7"', async () => {
    findOutboundTxByHash.mockResolvedValue(record({ nonce: '7' }))
    getTransactionCount.mockResolvedValue(10)
    expect(await classifyAnchorTxLiveness(84532, TX)).toBe('dead')
    // …and the inverse, which a string comparison would get backwards.
    findOutboundTxByHash.mockResolvedValue(record({ nonce: '10' }))
    getTransactionCount.mockResolvedValue(9)
    expect(await classifyAnchorTxLiveness(84532, TX)).toBe('live')
  })
})

/**
 * The reorg guard, and the fallback ladder underneath it (#1745 review).
 *
 * Nonce consumption is only as durable as the block that did the consuming.
 * Read at the head, a since-orphaned block can momentarily show the slot
 * taken — and acting on that re-mints while the original is still live, which
 * is the duplicate this whole probe exists to prevent.
 *
 * The two fallback branches below never execute on Base or Base Sepolia,
 * because those nodes answer `finalized` honestly. They are therefore the
 * branches most likely to rot unnoticed, which is exactly why they are
 * pinned here rather than left to a live RPC to exercise.
 */
describe('the nonce is read from settled state, not the head', () => {
  it('a burn visible ONLY at the head is not death — this is the reorg case', async () => {
    // Head says the slot is consumed; the finalized block says it is still
    // open. The head is the one that can be taken back.
    getTransactionCount.mockImplementation(nonceByBlock({ [HEAD]: 8, [FINALIZED]: 7 }))
    expect(await classifyAnchorTxLiveness(84532, TX)).toBe('live')
  })

  it('a burn settled at the finalized block IS death', async () => {
    getTransactionCount.mockImplementation(nonceByBlock({ [HEAD]: 8, [FINALIZED]: 8 }))
    expect(await classifyAnchorTxLiveness(84532, TX)).toBe('dead')
  })

  it('an unsupported `finalized` tag falls back to a buried block, never the head', async () => {
    getBlock.mockRejectedValue(new Error('unknown block tag "finalized"'))
    const buried = HEAD - SETTLED_CHAIN_READ_DEPTH_BLOCKS
    getTransactionCount.mockImplementation(nonceByBlock({ [buried]: 8 }))

    expect(await classifyAnchorTxLiveness(84532, TX)).toBe('dead')
    expect(getTransactionCount).toHaveBeenCalledWith(RELAYER, buried)
    expect(getTransactionCount).not.toHaveBeenCalledWith(RELAYER, HEAD)
  })

  it('a node that ECHOES the head for `finalized` is not trusted', async () => {
    // Some nodes accept the tag and return the head anyway. Believing that
    // would silently reinstate the reorg exposure this function removes.
    getBlock.mockResolvedValue({ number: HEAD })
    const buried = HEAD - SETTLED_CHAIN_READ_DEPTH_BLOCKS
    getTransactionCount.mockImplementation(nonceByBlock({ [buried]: 8, [HEAD]: 8 }))

    expect(await classifyAnchorTxLiveness(84532, TX)).toBe('dead')
    expect(getTransactionCount).toHaveBeenCalledWith(RELAYER, buried)
    expect(getTransactionCount).not.toHaveBeenCalledWith(RELAYER, HEAD)
  })

  it('NO settled vantage point (chain shorter than the depth) is live, not dead', async () => {
    getBlock.mockRejectedValue(new Error('unknown block tag "finalized"'))
    getBlockNumber.mockResolvedValue(10) // 10 - 300 < 0
    getTransactionCount.mockResolvedValue(9999) // would say "burned" if asked

    expect(await classifyAnchorTxLiveness(84532, TX)).toBe('live')
    // The point is that it never asks: with nowhere settled to read from
    // there is no evidence, and no evidence is never death.
    expect(getTransactionCount).not.toHaveBeenCalled()
  })
})

describe('everything that withholds it', () => {
  it('a transaction the node still knows is live — pending in the mempool', async () => {
    getTransaction.mockResolvedValue({ hash: TX, blockNumber: null })
    expect(await classifyAnchorTxLiveness(84532, TX)).toBe('live')
    expect(getTransactionCount).not.toHaveBeenCalled() // settled before the nonce test
  })

  it('a transaction the node knows as MINED is live — the caller re-reads its receipt (#690)', async () => {
    getTransaction.mockResolvedValue({ hash: TX, blockNumber: 42 })
    expect(await classifyAnchorTxLiveness(84532, TX)).toBe('live')
  })

  it('a burned nonce is OVERRULED by a receipt that appears on the re-read', async () => {
    // The load-balanced-fleet case: one read says the slot is consumed, and
    // the confirming read hands back OUR receipt — so the consumer was us and
    // the attestation is already on-chain. Re-minting here is the duplicate.
    getTransactionCount.mockResolvedValue(8)
    getTransactionReceipt.mockResolvedValue({ status: 1 })
    expect(await classifyAnchorTxLiveness(84532, TX)).toBe('live')
  })

  it('no durable record = no nonce = no evidence, whatever the chain says', async () => {
    findOutboundTxByHash.mockResolvedValue(null)
    getTransactionCount.mockResolvedValue(9999)
    expect(await classifyAnchorTxLiveness(84532, TX)).toBe('live')
  })

  it('a record with a NULL nonce (never stamped) is no evidence either', async () => {
    findOutboundTxByHash.mockResolvedValue(record({ nonce: null }))
    getTransactionCount.mockResolvedValue(9999)
    expect(await classifyAnchorTxLiveness(84532, TX)).toBe('live')
  })

  it('a REPLACED record is live — the replacement carries this payload at the same nonce', async () => {
    findOutboundTxByHash.mockResolvedValue(record({ status: 'replaced' }))
    getTransactionCount.mockResolvedValue(8)
    expect(await classifyAnchorTxLiveness(84532, TX)).toBe('live')
  })

  it('a MINED record is live — the reconciler already saw it land', async () => {
    findOutboundTxByHash.mockResolvedValue(record({ status: 'mined' }))
    getTransactionCount.mockResolvedValue(8)
    expect(await classifyAnchorTxLiveness(84532, TX)).toBe('live')
  })

  it('no provider at all is live — an unreadable chain proves nothing', async () => {
    provider = null
    expect(await classifyAnchorTxLiveness(84532, TX)).toBe('live')
  })

  it('the record is read CHAIN-SCOPED — a hash is only unique within a chain', async () => {
    await classifyAnchorTxLiveness(84532, TX)
    expect(findOutboundTxByHash).toHaveBeenCalledWith(84532, TX)
  })
})
