/**
 * #4853: the reconciliation script's logic, against a mocked chain and Stripe.
 * It records a missed payment once, is a no-op on the second run, and leaves a
 * non-EIP-3009 transfer unrecorded.
 */
import { describe, expect, it } from 'vitest'
import { createPublicClient, custom, pad, toEventSelector, toHex, type Address, type Hex, type PublicClient } from 'viem'
import { baseSepolia } from 'viem/chains'
import { LogWindows } from './log-range.js'
import { USDC_ADDRESS } from './products.js'
import { createStripeRecording, type StripeHttpClient, type StripeHttpRequest } from './stripe.js'
import {
  createViemReconcileChainReader,
  reconcileStripe,
  type DepositTransfer,
  type ReconcileChainReader,
} from './stripe-reconcile.js'

const DEPOSIT = '0x3333333333333333333333333333333333333333' as Address
const PAYER = '0x5555555555555555555555555555555555555555' as Address
const OTHER = '0x6666666666666666666666666666666666666666' as Address
const PRICE = 10_000n
/** Obviously fake: a test key, never a real one. */
const FAKE_KEY = 'sk_test_fake_key_for_tests_only'

const EIP3009_TX = `0x${'a1'.repeat(32)}` as Hex
const PLAIN_TX = `0x${'b2'.repeat(32)}` as Hex
const WRONG_AMOUNT_TX = `0x${'c3'.repeat(32)}` as Hex

function fakeChain(transfers: DepositTransfer[], eip3009: Set<Hex>): ReconcileChainReader {
  return {
    async findTransfersTo() {
      return transfers
    },
    async isEip3009Transfer({ txHash }) {
      return eip3009.has(txHash)
    },
  }
}

function fakeStripe(opts: { failCreate?: boolean } = {}) {
  const byTx = new Map<string, string>()
  const requests: StripeHttpRequest[] = []
  let nextId = 1
  const client: StripeHttpClient = {
    async request(request) {
      requests.push(request)
      if (request.method === 'GET') {
        const query = new URLSearchParams(request.path.split('?')[1] ?? '').get('query') ?? ''
        const tx = /transaction_hash'\]\s*:\s*'([^']+)'/.exec(query)?.[1]
        const id = tx ? byTx.get(tx) : undefined
        return { status: 200, body: { data: id ? [{ id, status: 'succeeded' }] : [] } }
      }
      if (opts.failCreate) {
        return { status: 402, body: { error: { type: 'card_error', code: 'crypto_declined' } } }
      }
      const tx = request.form?.['metadata[transaction_hash]']
      if (!tx) return { status: 400, body: { error: { type: 'invalid_request_error' } } }
      const id = `pi_test_${nextId++}`
      byTx.set(tx, id)
      return { status: 200, body: { id, status: 'succeeded' } }
    },
  }
  return { client, byTx, requests }
}

function recordingFor(stripe: ReturnType<typeof fakeStripe>) {
  return createStripeRecording(
    {
      depositAddress: DEPOSIT,
      secretKey: FAKE_KEY,
      apiVersion: '2026-07-29.preview',
      network: 'base',
    },
    { http: stripe.client, log: () => {} },
  )
}

const TRANSFERS: DepositTransfer[] = [
  { txHash: EIP3009_TX, from: PAYER, value: PRICE },
  { txHash: PLAIN_TX, from: OTHER, value: PRICE },
  { txHash: WRONG_AMOUNT_TX, from: PAYER, value: 5_000n },
]

describe('reconcileStripe (#4853)', () => {
  it('records a missed EIP-3009 payment once and is a no-op on the second run', async () => {
    const stripe = fakeStripe()
    const recording = recordingFor(stripe)
    const chain = fakeChain(TRANSFERS, new Set([EIP3009_TX]))

    const first = await reconcileStripe({
      chain,
      recording,
      depositAddress: DEPOSIT,
      priceAtomic: PRICE,
      productId: 'joke',
      fromBlock: 100n,
      toBlock: 200n,
    })

    expect(first.transfers).toBe(3)
    expect(first.recorded).toEqual([{ tx_hash: EIP3009_TX, payment_intent: 'pi_test_1' }])
    expect(first.already_recorded).toEqual([])
    expect(first.failed).toEqual([])
    expect(first.not_recorded).toEqual([
      { tx_hash: PLAIN_TX, reason: 'not_eip3009' },
      { tx_hash: WRONG_AMOUNT_TX, reason: 'amount_mismatch' },
    ])

    const second = await reconcileStripe({
      chain,
      recording,
      depositAddress: DEPOSIT,
      priceAtomic: PRICE,
      productId: 'joke',
      fromBlock: 100n,
      toBlock: 200n,
    })

    expect(second.recorded).toEqual([])
    expect(second.already_recorded).toEqual([{ tx_hash: EIP3009_TX, payment_intent: 'pi_test_1' }])
    expect(stripe.requests.filter((request) => request.method === 'POST')).toHaveLength(1)
  })

  it('leaves a non-EIP-3009 transfer unrecorded and never asks Stripe about it', async () => {
    const stripe = fakeStripe()
    const recording = recordingFor(stripe)
    const chain = fakeChain([{ txHash: PLAIN_TX, from: OTHER, value: PRICE }], new Set())

    const report = await reconcileStripe({
      chain,
      recording,
      depositAddress: DEPOSIT,
      priceAtomic: PRICE,
      productId: 'joke',
      fromBlock: 1n,
      toBlock: 2n,
    })

    expect(report.not_recorded).toEqual([{ tx_hash: PLAIN_TX, reason: 'not_eip3009' }])
    expect(report.recorded).toEqual([])
    expect(stripe.requests).toHaveLength(0)
  })

  it('leaves a transfer of another amount unrecorded', async () => {
    const stripe = fakeStripe()
    const recording = recordingFor(stripe)
    const chain = fakeChain([{ txHash: WRONG_AMOUNT_TX, from: PAYER, value: 5_000n }], new Set([WRONG_AMOUNT_TX]))

    const report = await reconcileStripe({
      chain,
      recording,
      depositAddress: DEPOSIT,
      priceAtomic: PRICE,
      productId: 'joke',
      fromBlock: 1n,
      toBlock: 2n,
    })

    expect(report.not_recorded).toEqual([{ tx_hash: WRONG_AMOUNT_TX, reason: 'amount_mismatch' }])
    expect(stripe.requests).toHaveLength(0)
  })

  it('reports a payment Stripe refused in `failed`, and records the rest', async () => {
    const stripe = fakeStripe({ failCreate: true })
    const recording = recordingFor(stripe)
    const chain = fakeChain([{ txHash: EIP3009_TX, from: PAYER, value: PRICE }], new Set([EIP3009_TX]))

    const report = await reconcileStripe({
      chain,
      recording,
      depositAddress: DEPOSIT,
      priceAtomic: PRICE,
      productId: 'joke',
      fromBlock: 1n,
      toBlock: 2n,
    })

    expect(report.recorded).toEqual([])
    expect(report.failed).toEqual([{ tx_hash: EIP3009_TX, reason: 'card_error/crypto_declined' }])
  })

  it('reports an empty range as nothing to do', async () => {
    const stripe = fakeStripe()
    const recording = recordingFor(stripe)
    const report = await reconcileStripe({
      chain: fakeChain([], new Set()),
      recording,
      depositAddress: DEPOSIT,
      priceAtomic: PRICE,
      productId: 'joke',
      fromBlock: 1n,
      toBlock: 2n,
    })
    expect(report).toEqual({
      from_block: '1',
      to_block: '2',
      transfers: 0,
      recorded: [],
      already_recorded: [],
      pending: [],
      declined: [],
      not_recorded: [],
      failed: [],
    })
  })
})

describe('reconcileStripe reports Stripe’s verdict (#4866)', () => {
  it('a declined PaymentIntent the search finds is listed as declined, not already_recorded', async () => {
    const client: StripeHttpClient = {
      async request(request) {
        if (request.method === 'GET') {
          return {
            status: 200,
            body: {
              data: [
                {
                  id: 'pi_3DeclinedOne1',
                  status: 'requires_payment_method',
                  last_payment_error: { code: 'payment_method_provider_decline' },
                },
              ],
            },
          }
        }
        return { status: 500, body: { error: { type: 'api_error' } } }
      },
    }
    const recording = createStripeRecording(
      { depositAddress: DEPOSIT, secretKey: FAKE_KEY, apiVersion: '2026-07-29.preview', network: 'base' },
      { http: client, log: () => {}, sleep: async () => {} },
    )
    const report = await reconcileStripe({
      chain: fakeChain([{ txHash: EIP3009_TX, from: PAYER, value: PRICE }], new Set([EIP3009_TX])),
      recording,
      depositAddress: DEPOSIT,
      priceAtomic: PRICE,
      productId: 'joke',
      fromBlock: 1n,
      toBlock: 2n,
    })
    expect(report.already_recorded).toEqual([])
    expect(report.declined).toEqual([
      { tx_hash: EIP3009_TX, payment_intent: 'pi_3DeclinedOne1', code: 'payment_method_provider_decline' },
    ])
  })
})

describe('createViemReconcileChainReader reads in windows the RPC serves (#4866)', () => {
  /**
   * A REAL viem client over a stub node that refuses `eth_getLogs` wider than
   * 200 blocks exactly as the public Base Sepolia RPC does (-32614). Before
   * #4866 the whole range went in one call and the run stopped.
   */
  function stubNode(transferBlocks: bigint[]) {
    const calls: Array<{ fromBlock: bigint; toBlock: bigint }> = []
    const refused: Array<{ fromBlock: bigint; toBlock: bigint }> = []
    const transport = custom(
      {
        async request({ method, params }: { method: string; params?: unknown }) {
          if (method === 'eth_chainId') return toHex(baseSepolia.id)
          if (method !== 'eth_getLogs') throw new Error(`stub node: unexpected ${method}`)
          const filter = (params as Array<{ fromBlock: Hex; toBlock: Hex }>)[0]!
          const fromBlock = BigInt(filter.fromBlock)
          const toBlock = BigInt(filter.toBlock)
          if (toBlock - fromBlock + 1n > 200n) {
            refused.push({ fromBlock, toBlock })
            throw { code: -32614, message: 'eth_getLogs is limited to a 200 range' }
          }
          calls.push({ fromBlock, toBlock })
          return transferBlocks
            .filter((block) => block >= fromBlock && block <= toBlock)
            .map((block, i) => ({
              address: USDC_ADDRESS,
              topics: [
                toEventSelector('Transfer(address,address,uint256)'),
                pad(PAYER.toLowerCase() as Hex, { size: 32 }),
                pad(DEPOSIT.toLowerCase() as Hex, { size: 32 }),
              ],
              data: toHex(PRICE, { size: 32 }),
              blockNumber: toHex(block),
              blockHash: `0x${'11'.repeat(32)}`,
              transactionHash: `0x${block.toString(16).padStart(64, '0')}`,
              transactionIndex: '0x0',
              logIndex: toHex(i),
              removed: false,
            }))
        },
      },
      { retryCount: 0 },
    )
    const client = createPublicClient({ chain: baseSepolia, transport }) as PublicClient
    return { client, calls, refused }
  }

  it('a 1,001-block range completes on a node that serves 200, finding every transfer in it', async () => {
    const { client, calls, refused } = stubNode([1_050n, 1_500n, 2_000n])
    const transfers = await createViemReconcileChainReader(client).findTransfersTo({
      to: DEPOSIT,
      fromBlock: 1_000n,
      toBlock: 2_000n,
    })
    expect(transfers.map((t) => t.txHash)).toEqual([1_050n, 1_500n, 2_000n].map((b) => `0x${b.toString(16).padStart(64, '0')}`))
    expect(refused).toHaveLength(1)
    for (const call of calls) expect(call.toBlock - call.fromBlock + 1n).toBeLessThanOrEqual(200n)
    expect(calls[0]!.fromBlock).toBe(1_000n)
    expect(calls.at(-1)!.toBlock).toBe(2_000n)
    for (let i = 1; i < calls.length; i++) expect(calls[i]!.fromBlock).toBe(calls[i - 1]!.toBlock + 1n)
  })

  it('ETH_GETLOGS_MAX_BLOCK_RANGE removes the refused call', async () => {
    const { client, refused } = stubNode([])
    await createViemReconcileChainReader(client, new LogWindows({ maxSpan: 200n })).findTransfersTo({
      to: DEPOSIT,
      fromBlock: 1_000n,
      toBlock: 2_000n,
    })
    expect(refused).toHaveLength(0)
  })
})
