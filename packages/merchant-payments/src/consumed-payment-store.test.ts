import { describe, expect, it } from 'vitest'
import {
  MAX_FORWARDS_PER_PAYMENT,
  createInMemoryConsumedPaymentStore,
  paymentStoreKey,
} from './consumed-payment-store.js'

const NOW = '2026-11-17T10:00:00.000Z'
const LATER = '2026-11-17T10:00:05.000Z'

function input(overrides: Partial<Parameters<ReturnType<typeof createInMemoryConsumedPaymentStore>['reserve']>[0]> = {}) {
  return {
    key: 'eip3009:8453:0xpayer:0xnonce',
    productId: 'joke',
    chain: 'eip155:8453',
    payer: '0xPayer',
    amount: '10000',
    validBefore: 1_800_000_300,
    merchantReference: 'ref-1',
    authorizationDigest: 'digest-1',
    now: NOW,
    ...overrides,
  }
}

describe('paymentStoreKey (#4890)', () => {
  it('lower-cases the EIP-3009 form', () => {
    expect(paymentStoreKey('eip3009', 8453, '0xAbC', '0xDEF')).toBe('eip3009:8453:0xabc:0xdef')
  })

  it('lower-cases the ERC-7710 form', () => {
    expect(paymentStoreKey('erc7710', 84532, '0xDeLeGaToR', '0xHASH')).toBe('erc7710:84532:0xdelegator:0xhash')
  })
})

describe('the in-memory consumed-payment store (#4890)', () => {
  it('reserves a new key, and answers a known key with its record and no token', async () => {
    const store = createInMemoryConsumedPaymentStore()
    const first = await store.reserve(input())
    expect(first.reserved).toBe(true)
    const second = await store.reserve(input({ now: LATER }))
    expect(second.reserved).toBe(false)
    if (second.reserved) throw new Error('unreachable')
    expect(second.record).toMatchObject({ state: 'settling', productId: 'joke', reservedAt: NOW, forwardCount: 0, saleReported: false })
    expect(JSON.stringify(second.record)).not.toContain(first.reserved ? first.reservationToken : 'x')
    expect('tokenHash' in second.record).toBe(false)
  })

  it('markSettled with the reservation token moves settling straight to forwarding', async () => {
    const store = createInMemoryConsumedPaymentStore()
    const reservation = await store.reserve(input())
    if (!reservation.reserved) throw new Error('unreachable')
    expect(await store.markSettled(input().key, { txHash: '0xtx', settledAt: LATER, reservationToken: reservation.reservationToken })).toBe('forward')
    expect(await store.get(input().key)).toMatchObject({ state: 'forwarding', forwardCount: 1, txHash: '0xtx', settledAt: LATER })
  })

  it('markSettled with a wrong token changes nothing', async () => {
    const store = createInMemoryConsumedPaymentStore()
    await store.reserve(input())
    expect(await store.markSettled(input().key, { txHash: '0xtx', settledAt: LATER, reservationToken: 'not-the-token' })).toBe('not_settleable')
    expect((await store.get(input().key))?.state).toBe('settling')
  })

  it('markSettled without a token does not settle a record whose holder still has its token', async () => {
    const store = createInMemoryConsumedPaymentStore()
    await store.reserve(input())
    expect(await store.markSettled(input().key, { txHash: '0xtx', settledAt: LATER })).toBe('not_settleable')
  })

  it('markSettled without a token settles a settlement_unknown record, without forwarding it', async () => {
    const store = createInMemoryConsumedPaymentStore()
    await store.reserve(input())
    await store.markSettlementUnknown(input().key, LATER)
    expect((await store.get(input().key))?.state).toBe('settlement_unknown')
    expect(await store.markSettled(input().key, { txHash: '0xtx', settledAt: LATER })).toBe('settled')
    expect(await store.get(input().key)).toMatchObject({ state: 'settled', forwardCount: 0, txHash: '0xtx' })
  })

  it('markSettlementUnknown clears the token: the holder can no longer forward', async () => {
    const store = createInMemoryConsumedPaymentStore()
    const reservation = await store.reserve(input())
    if (!reservation.reserved) throw new Error('unreachable')
    await store.markSettlementUnknown(input().key, LATER)
    expect(await store.markSettled(input().key, { txHash: '0xtx', settledAt: LATER, reservationToken: reservation.reservationToken })).toBe('not_settleable')
  })

  it('release removes a settling record, so the key can be reserved again', async () => {
    const store = createInMemoryConsumedPaymentStore()
    await store.reserve(input())
    await store.release(input().key)
    expect(await store.get(input().key)).toBeNull()
    expect((await store.reserve(input())).reserved).toBe(true)
  })

  it('release leaves a settled-and-forwarding record alone', async () => {
    const store = createInMemoryConsumedPaymentStore()
    const reservation = await store.reserve(input())
    if (!reservation.reserved) throw new Error('unreachable')
    await store.markSettled(input().key, { txHash: '0xtx', settledAt: LATER, reservationToken: reservation.reservationToken })
    await store.release(input().key)
    expect((await store.get(input().key))?.state).toBe('forwarding')
  })

  it('get returns a copy: editing it does not edit the store', async () => {
    const store = createInMemoryConsumedPaymentStore()
    await store.reserve(input())
    const record = await store.get(input().key)
    record!.state = 'delivered'
    expect((await store.get(input().key))?.state).toBe('settling')
  })

  it('a delivered record answers beginForwarding with delivered', async () => {
    const store = createInMemoryConsumedPaymentStore()
    const reservation = await store.reserve(input())
    if (!reservation.reserved) throw new Error('unreachable')
    await store.markSettled(input().key, { txHash: '0xtx', settledAt: LATER, reservationToken: reservation.reservationToken })
    await store.markDelivered(input().key, { upstreamStatus: 200, deliveredAt: LATER })
    expect(await store.beginForwarding(input().key, LATER)).toBe('delivered')
    expect(await store.get(input().key)).toMatchObject({ state: 'delivered', upstreamStatus: 200 })
  })

  it('a failed record is forwarded again, up to the cap, then exhausted', async () => {
    const store = createInMemoryConsumedPaymentStore()
    const reservation = await store.reserve(input())
    if (!reservation.reserved) throw new Error('unreachable')
    await store.markSettled(input().key, { txHash: '0xtx', settledAt: LATER, reservationToken: reservation.reservationToken })
    // The first forward was the markSettled one; two more are allowed.
    for (let forward = 2; forward <= MAX_FORWARDS_PER_PAYMENT; forward++) {
      await store.markFailed(input().key, { reason: 'boom', failedAt: LATER })
      expect(await store.beginForwarding(input().key, LATER)).toBe('forward')
      expect((await store.get(input().key))?.forwardCount).toBe(forward)
    }
    await store.markFailed(input().key, { reason: 'boom', failedAt: LATER })
    expect(await store.beginForwarding(input().key, LATER)).toBe('exhausted')
    expect((await store.get(input().key))?.state).toBe('exhausted')
  })

  it('a younger forwarding record is in flight; markSaleReported is recorded', async () => {
    const store = createInMemoryConsumedPaymentStore()
    const reservation = await store.reserve(input())
    if (!reservation.reserved) throw new Error('unreachable')
    await store.markSettled(input().key, { txHash: '0xtx', settledAt: LATER, reservationToken: reservation.reservationToken })
    expect(await store.beginForwarding(input().key, LATER)).toBe('in_flight')
    await store.markSaleReported(input().key)
    expect((await store.get(input().key))?.saleReported).toBe(true)
  })

  it('a stale forwarding record is taken over once the threshold has passed', async () => {
    const store = createInMemoryConsumedPaymentStore({ takeoverAfterMs: 1_000 })
    const reservation = await store.reserve(input())
    if (!reservation.reserved) throw new Error('unreachable')
    await store.markSettled(input().key, { txHash: '0xtx', settledAt: NOW, reservationToken: reservation.reservationToken })
    expect(await store.beginForwarding(input().key, LATER)).toBe('forward')
    expect((await store.get(input().key))?.forwardCount).toBe(2)
  })
})
