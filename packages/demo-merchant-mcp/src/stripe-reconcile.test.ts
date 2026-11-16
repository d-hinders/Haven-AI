/**
 * #4853: the reconciliation script's logic, against a mocked chain and Stripe.
 * It records a missed payment once, is a no-op on the second run, and leaves a
 * non-EIP-3009 transfer unrecorded.
 */
import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import { createStripeRecording, type StripeHttpClient, type StripeHttpRequest } from './stripe.js'
import { reconcileStripe, type DepositTransfer, type ReconcileChainReader } from './stripe-reconcile.js'

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
        return { status: 200, body: { data: id ? [{ id }] : [] } }
      }
      if (opts.failCreate) {
        return { status: 402, body: { error: { type: 'card_error', code: 'crypto_declined' } } }
      }
      const tx = request.form?.['metadata[transaction_hash]']
      if (!tx) return { status: 400, body: { error: { type: 'invalid_request_error' } } }
      const id = `pi_test_${nextId++}`
      byTx.set(tx, id)
      return { status: 200, body: { id } }
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
      not_recorded: [],
      failed: [],
    })
  })
})
