import { describe, expect, it, vi } from 'vitest'
import type { Hex } from 'viem'
import { createInMemoryConsumedPaymentStore, paymentStoreKey } from './consumed-payment-store.js'
import {
  AuthorizationAlreadyUsedError,
  PaymentError,
  SettlementRevertedError,
  ZERO_TX_HASH,
} from './payment-checks.js'
import { createSettleOnce, type VerifiedPayment } from './settle-once.js'

const PAYER = '0x1a642F0E3c3aF545E7AcBD38b07251B3990914F1' as const
const MERCHANT = '0x15179876c595922999C2d5DC7c23Cc7711fE799a' as const
const NONCE = `0x${'ab'.repeat(32)}` as Hex
const TX = `0x${'cd'.repeat(32)}` as Hex
const TX_2 = `0x${'ef'.repeat(32)}` as Hex
const KEY = paymentStoreKey('eip3009', 8453, PAYER, NONCE)

function verified(submit: () => Promise<Hex>, overrides: Partial<VerifiedPayment> = {}): VerifiedPayment {
  return {
    payer: PAYER,
    payTo: MERCHANT,
    nonce: NONCE,
    settlementMethod: 'eip3009',
    passportReference: null,
    validBefore: 1_800_000_300,
    authorizationDigest: 'digest',
    submit,
    ...overrides,
  }
}

function harness(waitForReceipt: (txHash: Hex) => Promise<void> = async () => {}) {
  const store = createInMemoryConsumedPaymentStore()
  const settleOnce = createSettleOnce({ store, chainId: 8453, waitForReceipt })
  return { store, settleOnce }
}

describe('settleOnce (#4890)', () => {
  it('settles once and re-serves the SAME payment object', async () => {
    const { settleOnce, store } = harness()
    const submit = vi.fn(async () => TX)
    const first = await settleOnce({ productId: 'joke', verified: verified(submit), expectedAmount: 10_000n })
    const again = await settleOnce({ productId: 'joke', verified: verified(submit), expectedAmount: 10_000n })
    expect(again).toBe(first)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(first).toMatchObject({ txHash: TX, settlement: 'settled_onchain', productId: 'joke', value: 10_000n })
    expect(first.paymentResponse).toMatchObject({ network: 'eip155:8453', amount: '10000', transaction: TX })
    // The store holds the record: forwarding, with the reservation's token spent on the first forward.
    expect(await store.get(KEY)).toMatchObject({
      state: 'forwarding',
      txHash: TX,
      productId: 'joke',
      chain: 'eip155:8453',
      amount: '10000',
      validBefore: 1_800_000_300,
      authorizationDigest: 'digest',
    })
  })

  it('refuses a different product on a settled authorization', async () => {
    const { settleOnce } = harness()
    await settleOnce({ productId: 'joke', verified: verified(async () => TX), expectedAmount: 10_000n })
    await expect(
      settleOnce({ productId: 'other', verified: verified(async () => TX), expectedAmount: 10_000n }),
    ).rejects.toThrow('Payment authorization has already settled a different product')
  })

  it('refuses a different product while the first is still settling, and shares the promise for the same product', async () => {
    const { settleOnce } = harness()
    let release!: (hash: Hex) => void
    const submit = vi.fn(() => new Promise<Hex>((resolve) => (release = resolve)))
    const first = settleOnce({ productId: 'joke', verified: verified(submit), expectedAmount: 10_000n })
    await expect(
      settleOnce({ productId: 'other', verified: verified(submit), expectedAmount: 10_000n }),
    ).rejects.toThrow('Payment authorization is already settling a different product')
    const second = settleOnce({ productId: 'joke', verified: verified(submit), expectedAmount: 10_000n })
    await vi.waitFor(() => expect(submit).toHaveBeenCalled())
    release(TX)
    expect(await second).toBe(await first)
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('a submit failure releases the reservation: a retry reserves again and submits again', async () => {
    const { settleOnce, store } = harness()
    const submit = vi
      .fn<() => Promise<Hex>>()
      .mockRejectedValueOnce(new PaymentError('rpc down'))
      .mockResolvedValueOnce(TX)
    await expect(settleOnce({ productId: 'joke', verified: verified(submit), expectedAmount: 10_000n })).rejects.toThrow('rpc down')
    expect(await store.get(KEY)).toBeNull()
    // A different product is not refused by the stale in-flight record either (#3099).
    const payment = await settleOnce({ productId: 'other', verified: verified(submit), expectedAmount: 10_000n })
    expect(payment.txHash).toBe(TX)
    expect(submit).toHaveBeenCalledTimes(2)
  })

  it('an already-used authorization is recorded as settled earlier, with no hash', async () => {
    const { settleOnce, store } = harness()
    const submit = async (): Promise<Hex> => {
      throw new AuthorizationAlreadyUsedError('used')
    }
    const payment = await settleOnce({ productId: 'joke', verified: verified(submit), expectedAmount: 10_000n })
    expect(payment).toMatchObject({ txHash: ZERO_TX_HASH, settlement: 'already_settled_earlier' })
    expect(await settleOnce({ productId: 'joke', verified: verified(submit), expectedAmount: 10_000n })).toBe(payment)
    expect(await store.get(KEY)).toMatchObject({ state: 'forwarding', txHash: ZERO_TX_HASH })
  })

  it('an already-used authorization whose transaction was recovered carries that hash', async () => {
    const { settleOnce } = harness()
    const submit = async (): Promise<Hex> => {
      throw new AuthorizationAlreadyUsedError('used', TX)
    }
    expect(await settleOnce({ productId: 'joke', verified: verified(submit), expectedAmount: 10_000n })).toMatchObject({
      txHash: TX,
      settlement: 'settled_onchain',
    })
  })

  it('a reverted transaction clears the attempt and the reservation: the retry resubmits', async () => {
    const waitForReceipt = vi
      .fn<(txHash: Hex) => Promise<void>>()
      .mockRejectedValueOnce(new SettlementRevertedError('reverted'))
      .mockResolvedValueOnce(undefined)
    const { settleOnce, store } = harness(waitForReceipt)
    const submit = vi.fn<() => Promise<Hex>>().mockResolvedValueOnce(TX).mockResolvedValueOnce(TX_2)
    await expect(settleOnce({ productId: 'joke', verified: verified(submit), expectedAmount: 10_000n })).rejects.toThrow(
      `Settlement transaction reverted on-chain (${TX})`,
    )
    expect(await store.get(KEY)).toBeNull()
    const payment = await settleOnce({ productId: 'joke', verified: verified(submit), expectedAmount: 10_000n })
    expect(payment.txHash).toBe(TX_2)
    expect(submit).toHaveBeenCalledTimes(2)
  })

  it('a transient receipt failure keeps the hash: the retry re-confirms without resubmitting', async () => {
    const waitForReceipt = vi
      .fn<(txHash: Hex) => Promise<void>>()
      .mockRejectedValueOnce(new Error('rpc timeout'))
      .mockResolvedValueOnce(undefined)
    const { settleOnce } = harness(waitForReceipt)
    const submit = vi.fn(async () => TX)
    await expect(settleOnce({ productId: 'joke', verified: verified(submit), expectedAmount: 10_000n })).rejects.toThrow('rpc timeout')
    const payment = await settleOnce({ productId: 'joke', verified: verified(submit), expectedAmount: 10_000n })
    expect(payment.txHash).toBe(TX)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(waitForReceipt).toHaveBeenCalledTimes(2)
  })

  it('a key already in the store but unknown to this process is not settled again', async () => {
    const { settleOnce, store } = harness()
    await store.reserve({
      key: KEY,
      productId: 'joke',
      chain: 'eip155:8453',
      payer: PAYER,
      amount: '10000',
      validBefore: 0,
      merchantReference: 'earlier',
      authorizationDigest: 'digest',
      now: '2026-11-17T10:00:00.000Z',
    })
    const submit = vi.fn(async () => TX)
    await expect(settleOnce({ productId: 'joke', verified: verified(submit), expectedAmount: 10_000n })).rejects.toBeInstanceOf(PaymentError)
    await expect(settleOnce({ productId: 'other', verified: verified(submit), expectedAmount: 10_000n })).rejects.toThrow(
      'already settled a different product',
    )
    expect(submit).not.toHaveBeenCalled()
  })
})
