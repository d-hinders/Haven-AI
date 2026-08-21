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
let provider: unknown = { getTransaction, getTransactionReceipt, getTransactionCount }

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

const { classifyAnchorTxLiveness } = await import('../attestation.js')

/** A durable record stamped at broadcast: nonce 7, still open. */
function record(overrides: Record<string, unknown> = {}) {
  return { chain_id: 84532, nonce: '7', status: 'broadcast', tx_hash: TX, ...overrides }
}

beforeEach(() => {
  provider = { getTransaction, getTransactionReceipt, getTransactionCount }
  getTransaction.mockReset().mockResolvedValue(null)
  getTransactionReceipt.mockReset().mockResolvedValue(null)
  getTransactionCount.mockReset().mockResolvedValue(7)
  findOutboundTxByHash.mockReset().mockResolvedValue(record())
})

describe('what earns a `dead` verdict (#1745)', () => {
  it('the ONLY path to dead: the nonce slot burned by something else, receipt still absent', async () => {
    getTransactionCount.mockResolvedValue(8) // nonce 7 consumed, not by us
    expect(await classifyAnchorTxLiveness(84532, TX)).toBe('dead')
    // `latest`, never `pending` — a pending count includes the stuck
    // transaction itself and could never show its own slot as consumed.
    expect(getTransactionCount).toHaveBeenCalledWith(RELAYER, 'latest')
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
