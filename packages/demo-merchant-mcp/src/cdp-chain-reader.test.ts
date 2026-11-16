/**
 * #4851: how the CDP path tells a payment from a cancelled or reused
 * authorization — `authorizationState` reads "used" for all three — from
 * USDC's own `AuthorizationUsed` event inside the authorization's window.
 *
 * Review of #4851: these run a REAL viem public client over a stub JSON-RPC
 * transport, so what is asserted is what the node would receive (the topics
 * of `eth_getLogs`), not the arguments handed to a fake. viem drops `args`
 * from the topics when given `events: [...]`; only a real client shows that.
 */
import { describe, expect, it } from 'vitest'
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  getAddress,
  pad,
  toEventSelector,
  toHex,
  type Address,
  type Hex,
} from 'viem'
import { base } from 'viem/chains'
import { USDC_ADDRESS } from './products.js'
import { CdpTimeoutError, createCdpChainReader, withCdpTimeout, type ChainReadClient } from './cdp.js'

const PAYER = getAddress('0x1a642f0e3c3af545e7acbd38b07251b3990914f1')
const MERCHANT = getAddress('0x15179876c595922999c2d5dc7c23cc7711fe799a')
const OTHER = getAddress('0x2222222222222222222222222222222222222222')
const NONCE = `0x${'ab12'.repeat(16)}` as Hex
const TX = `0x${'cd'.repeat(32)}` as Hex
const USED_TOPIC = toEventSelector('AuthorizationUsed(address,bytes32)')
const TRANSFER_TOPIC = toEventSelector('Transfer(address,address,uint256)')
const NOW = 1_800_000_000n
const LATEST = 30_000_000n
const BLOCK_HASH = `0x${'11'.repeat(32)}` as Hex

interface ChainState {
  /** The AuthorizationUsed events the chain holds. */
  used?: Array<{ authorizer: Address; nonce: Hex; block: bigint; tx: Hex }>
  /** The receipt returned for any transaction. */
  receipt?: { status: '0x1' | '0x0'; transfers: Array<{ from: Address; to: Address; value: bigint; token?: Address }> }
  authorizationState?: boolean
  /**
   * #4866: the widest `eth_getLogs` range the node serves, inclusive. Wider is
   * refused the way the public Base Sepolia RPC refuses it (-32614).
   */
  maxRange?: bigint
}

interface Recorded {
  getLogs: Array<{ address: string; topics: Array<string | string[] | null>; fromBlock: bigint; toBlock: bigint }>
  /** #4866: `eth_getLogs` calls the node refused for their range. */
  refused: Array<{ fromBlock: bigint; toBlock: bigint }>
  ethCalls: Hex[]
}

function topicAddress(address: Address): Hex {
  return pad(address.toLowerCase() as Hex, { size: 32 })
}

function rawLog(fields: { address: Address; topics: Hex[]; data: Hex; block: bigint; tx: Hex }) {
  return {
    address: fields.address,
    topics: fields.topics,
    data: fields.data,
    blockNumber: toHex(fields.block),
    blockHash: BLOCK_HASH,
    transactionHash: fields.tx,
    transactionIndex: '0x0',
    logIndex: '0x0',
    removed: false,
  }
}

/** A real viem client over a stub node. The stub filters `eth_getLogs` by its
 *  topics exactly as a node does: a topic slot that is absent matches anything. */
function chain(state: ChainState): { client: ChainReadClient; recorded: Recorded } {
  const recorded: Recorded = { getLogs: [], refused: [], ethCalls: [] }
  const transport = custom({
    async request({ method, params }: { method: string; params?: unknown }) {
      const p = (params ?? []) as unknown[]
      switch (method) {
        case 'eth_chainId':
          return toHex(base.id)
        case 'eth_getBlockByNumber':
          return {
            number: toHex(LATEST),
            timestamp: toHex(NOW),
            hash: BLOCK_HASH,
            parentHash: BLOCK_HASH,
            transactions: [],
            gasLimit: '0x0',
            gasUsed: '0x0',
            baseFeePerGas: '0x0',
          }
        case 'eth_getLogs': {
          const filter = p[0] as { address: string; topics: Array<string | string[] | null>; fromBlock: Hex; toBlock: Hex }
          const fromBlock = BigInt(filter.fromBlock)
          const toBlock = BigInt(filter.toBlock)
          if (state.maxRange !== undefined && toBlock - fromBlock + 1n > state.maxRange) {
            recorded.refused.push({ fromBlock, toBlock })
            throw { code: -32614, message: `eth_getLogs is limited to a ${state.maxRange} range` }
          }
          recorded.getLogs.push({ address: filter.address, topics: filter.topics, fromBlock, toBlock })
          const matches = (slot: string | string[] | null | undefined, value: Hex) =>
            slot == null || (Array.isArray(slot) ? slot.includes(value) : slot === value)
          return (state.used ?? [])
            .filter((event) => event.block >= fromBlock && event.block <= toBlock)
            .map((event) => ({ ...event, topics: [USED_TOPIC, topicAddress(event.authorizer), event.nonce] as Hex[] }))
            .filter((event) => event.topics.every((topic, i) => matches(filter.topics[i], topic)))
            .map((event) => rawLog({ address: USDC_ADDRESS, topics: event.topics, data: '0x', block: event.block, tx: event.tx }))
        }
        case 'eth_getTransactionReceipt': {
          const receipt = state.receipt ?? { status: '0x1', transfers: [{ from: PAYER, to: MERCHANT, value: 10_000n }] }
          return {
            transactionHash: p[0],
            transactionIndex: '0x0',
            blockHash: BLOCK_HASH,
            blockNumber: toHex(LATEST - 10n),
            from: OTHER,
            to: USDC_ADDRESS,
            cumulativeGasUsed: '0x0',
            gasUsed: '0x0',
            effectiveGasPrice: '0x0',
            contractAddress: null,
            logsBloom: `0x${'0'.repeat(512)}`,
            type: '0x2',
            status: receipt.status,
            logs: receipt.transfers.map((t) =>
              rawLog({
                address: t.token ?? USDC_ADDRESS,
                topics: [TRANSFER_TOPIC, topicAddress(t.from), topicAddress(t.to)],
                data: toHex(t.value, { size: 32 }),
                block: LATEST - 10n,
                tx: p[0] as Hex,
              }),
            ),
          }
        }
        case 'eth_call': {
          const call = p[0] as { data: Hex }
          recorded.ethCalls.push(call.data)
          return encodeAbiParameters([{ type: 'bool' }], [state.authorizationState ?? true])
        }
        default:
          throw new Error(`stub node: unexpected ${method}`)
      }
    },
  }, { retryCount: 0 })
  return { client: createPublicClient({ chain: base, transport }) as ChainReadClient, recorded }
}

/** A window 300 blocks back (validAfter) to 150 back (validBefore). */
const PARAMS = {
  authorizer: PAYER,
  nonce: NONCE,
  to: MERCHANT,
  value: 10_000n,
  validAfter: NOW - 600n,
  validBefore: NOW - 300n,
}
/** Wide enough to need two 500-block chunks: 600 blocks back to 150 back. */
const WIDE = { ...PARAMS, validAfter: NOW - 1_200n }
/** A window that closed long ago: 900 blocks back to 600 back. */
const CLOSED = { ...PARAMS, validAfter: NOW - 1_800n, validBefore: NOW - 1_200n }

describe('findAuthorizationOutcome (#4851)', () => {
  it('asks the node for THIS authorization only: one event, authorizer and nonce as topics', async () => {
    const { client, recorded } = chain({})
    await createCdpChainReader(client).findAuthorizationOutcome(PARAMS)
    expect(recorded.getLogs.length).toBeGreaterThan(0)
    for (const call of recorded.getLogs) {
      expect(getAddress(call.address)).toBe(getAddress(USDC_ADDRESS))
      expect(call.topics).toEqual([USED_TOPIC, topicAddress(PAYER), NONCE.toLowerCase()])
    }
  })

  it('an uppercase nonce is searched in lowercase, and still finds its event', async () => {
    const upper = `0x${NONCE.slice(2).toUpperCase()}` as Hex
    const { client, recorded } = chain({ used: [{ authorizer: PAYER, nonce: NONCE.toLowerCase() as Hex, block: LATEST - 200n, tx: TX }] })
    const outcome = await createCdpChainReader(client).findAuthorizationOutcome({ ...PARAMS, nonce: upper })
    expect(outcome).toEqual({ kind: 'settled', txHash: TX })
    expect(recorded.getLogs[0].topics[2]).toBe(NONCE.toLowerCase())
  })

  it('AuthorizationUsed in the window whose transaction paid the merchant the price: settled, with that hash', async () => {
    const { client } = chain({ used: [{ authorizer: PAYER, nonce: NONCE, block: LATEST - 200n, tx: TX }] })
    expect(await createCdpChainReader(client).findAuthorizationOutcome(PARAMS)).toEqual({ kind: 'settled', txHash: TX })
  })

  it.each<[string, ChainState['receipt']]>([
    ['paid someone else', { status: '0x1', transfers: [{ from: PAYER, to: OTHER, value: 10_000n }] }],
    ['paid a different amount', { status: '0x1', transfers: [{ from: PAYER, to: MERCHANT, value: 9_999n }] }],
    ['moved a different token', { status: '0x1', transfers: [{ from: PAYER, to: MERCHANT, value: 10_000n, token: OTHER }] }],
    ['came from someone else', { status: '0x1', transfers: [{ from: OTHER, to: MERCHANT, value: 10_000n }] }],
    ['reverted', { status: '0x0', transfers: [{ from: PAYER, to: MERCHANT, value: 10_000n }] }],
  ])('AuthorizationUsed whose transaction %s: used_elsewhere', async (_label, receipt) => {
    const { client } = chain({ used: [{ authorizer: PAYER, nonce: NONCE, block: LATEST - 200n, tx: TX }], receipt })
    expect(await createCdpChainReader(client).findAuthorizationOutcome(PARAMS)).toEqual({ kind: 'used_elsewhere', txHash: TX })
  })

  it('a window that closed long ago, searched whole and empty (cancelled, or the nonce spent outside it): not_in_window', async () => {
    // An event for the same nonce long before the window, as a cancellation or
    // an early reuse would leave, and one for another payer inside it.
    const { client } = chain({
      used: [
        { authorizer: PAYER, nonce: NONCE, block: LATEST - 5_000n, tx: TX },
        { authorizer: OTHER, nonce: NONCE, block: LATEST - 700n, tx: TX },
      ],
    })
    expect(await createCdpChainReader(client).findAuthorizationOutcome(CLOSED)).toEqual({ kind: 'not_in_window' })
  })

  it('head lags the block that mined the payment, window still open: null (served), never not_in_window', async () => {
    // Review of #4851 (round 2, blocking): the eth_call that said "used" was
    // answered by a node one block ahead of the one answering getBlock/getLogs.
    const { client } = chain({ used: [{ authorizer: PAYER, nonce: NONCE, block: LATEST + 1n, tx: TX }] })
    const now = { ...PARAMS, validAfter: NOW - 60n, validBefore: NOW + 240n }
    expect(await createCdpChainReader(client).findAuthorizationOutcome(now)).toBeNull()
  })

  it('a window that closed too recently to rule out a lagging node: an empty result is null, not proof', async () => {
    // Review of #4851: an empty result refuses the buyer, so it must not come
    // from a log read that may lag the node which said "used".
    const { client } = chain({})
    expect(await createCdpChainReader(client).findAuthorizationOutcome(PARAMS)).toBeNull()
  })

  it('a window longer than the search cap: searched from its end, and an empty result is null, not proof', async () => {
    const { client, recorded } = chain({})
    const outcome = await createCdpChainReader(client).findAuthorizationOutcome({ ...PARAMS, validAfter: 0n })
    expect(outcome).toBeNull()
    expect(recorded.getLogs.length).toBeLessThanOrEqual(44)
  })

  it('searches the signed window in contiguous chunks of at most 500 blocks', async () => {
    const { client, recorded } = chain({})
    await createCdpChainReader(client).findAuthorizationOutcome(WIDE)
    const calls = recorded.getLogs
    expect(calls.length).toBe(2)
    for (const call of calls) expect(call.toBlock - call.fromBlock).toBeLessThan(500n)
    for (let i = 1; i < calls.length; i++) expect(calls[i].fromBlock).toBe(calls[i - 1].toBlock + 1n)
    // validAfter is 600 blocks back, validBefore 150 back; 150 blocks of margin each side.
    expect(calls[0].fromBlock).toBe(LATEST - 750n)
    expect(calls.at(-1)!.toBlock).toBe(LATEST)
  })

  it('finds an event in a later chunk', async () => {
    const { client } = chain({ used: [{ authorizer: PAYER, nonce: NONCE, block: LATEST - 100n, tx: TX }] })
    expect(await createCdpChainReader(client).findAuthorizationOutcome(WIDE)).toEqual({ kind: 'settled', txHash: TX })
  })
})

describe('authorizationUsed (#4851)', () => {
  it('reads USDC authorizationState with the nonce in lowercase', async () => {
    const { client, recorded } = chain({ authorizationState: true })
    const upper = `0x${NONCE.slice(2).toUpperCase()}` as Hex
    expect(await createCdpChainReader(client).authorizationUsed(PAYER, upper)).toBe(true)
    const decoded = decodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'authorizationState',
          stateMutability: 'view',
          inputs: [
            { name: 'authorizer', type: 'address' },
            { name: 'nonce', type: 'bytes32' },
          ],
          outputs: [{ type: 'bool' }],
        },
      ],
      data: recorded.ethCalls[0],
    })
    expect(decoded.args).toEqual([PAYER, NONCE.toLowerCase()])
  })
})

describe('withCdpTimeout (#4851)', () => {
  it('rejects with a typed CdpTimeoutError when the call does not answer in time', async () => {
    await expect(withCdpTimeout('settle', 10, () => new Promise(() => {}))).rejects.toBeInstanceOf(CdpTimeoutError)
  })

  it('returns the answer when it comes in time', async () => {
    await expect(withCdpTimeout('verify', 1_000, async () => 'ok')).resolves.toBe('ok')
  })
})

describe('the recovery search fits the RPC provider\'s block-range limit (#4866)', () => {
  it('a node that serves at most 200 blocks: learns the limit, searches the whole window, and proves not_in_window', async () => {
    const { client, recorded } = chain({ maxRange: 200n })
    // Before #4866 the first 500-block chunk was refused and the search threw,
    // so a closed window could never be proven empty on such a node.
    expect(await createCdpChainReader(client).findAuthorizationOutcome(CLOSED)).toEqual({ kind: 'not_in_window' })
    expect(recorded.refused).toHaveLength(1)
    for (const call of recorded.getLogs) expect(call.toBlock - call.fromBlock + 1n).toBeLessThanOrEqual(200n)
    for (let i = 1; i < recorded.getLogs.length; i++) {
      expect(recorded.getLogs[i].fromBlock).toBe(recorded.getLogs[i - 1].toBlock + 1n)
    }
    // The refused call's start is covered from the first successful window on.
    expect(recorded.getLogs[0].fromBlock).toBe(recorded.refused[0].fromBlock)
  })

  it('finds the event on such a node, too', async () => {
    const { client } = chain({ maxRange: 200n, used: [{ authorizer: PAYER, nonce: NONCE, block: LATEST - 400n, tx: TX }] })
    expect(await createCdpChainReader(client).findAuthorizationOutcome(WIDE)).toEqual({ kind: 'settled', txHash: TX })
  })

  it('keeps a learned limit for the next search on the same reader: no second refusal', async () => {
    const { client, recorded } = chain({ maxRange: 200n })
    const reader = createCdpChainReader(client)
    await reader.findAuthorizationOutcome(CLOSED)
    await reader.findAuthorizationOutcome(CLOSED)
    expect(recorded.refused).toHaveLength(1)
  })
})
