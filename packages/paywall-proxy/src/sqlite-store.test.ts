import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_FORWARDS_PER_PAYMENT } from '@haven_ai/merchant-payments'
import { StoreLockedError, openSqliteConsumedPaymentStore, type SqliteConsumedPaymentStore } from './sqlite-store.js'

const TAKEOVER_MS = 210_000
const T0 = '2026-11-17T10:00:00.000Z'
const iso = (offsetMs: number): string => new Date(Date.parse(T0) + offsetMs).toISOString()

const input = (key = 'eip3009:84532:0xpayer:0xnonce') => ({
  key,
  productId: 'p1',
  chain: 'eip155:84532',
  payer: '0xpayer',
  amount: '10000',
  validBefore: 1_900_000_000,
  merchantReference: 'ref-1',
  authorizationDigest: 'd'.repeat(64),
  now: T0,
})

let dir: string
let file: string
const opened: SqliteConsumedPaymentStore[] = []
const open = (): SqliteConsumedPaymentStore => {
  const store = openSqliteConsumedPaymentStore(file, { takeoverAfterMs: TAKEOVER_MS })
  opened.push(store)
  return store
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'paywall-store-'))
  file = join(dir, 'payments.sqlite')
})
afterEach(() => {
  for (const store of opened.splice(0)) {
    try {
      store.close()
    } catch {
      // already closed by the test
    }
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('sqlite consumed-payment store (real database)', () => {
  it('reserves a new key and answers the existing record for a known one, never returning the token', async () => {
    const store = open()
    const first = await store.reserve(input())
    expect(first.reserved).toBe(true)
    const second = await store.reserve(input())
    expect(second.reserved).toBe(false)
    if (!second.reserved) {
      expect(second.record.state).toBe('settling')
      expect(JSON.stringify(second.record)).not.toContain((first as { reservationToken: string }).reservationToken)
    }
    expect(JSON.stringify(await store.get(input().key))).not.toMatch(/token/i)
  })

  it('markSettled with the reservation token goes straight to forwarding with forwardCount 1', async () => {
    const store = open()
    const r = await store.reserve(input())
    if (!r.reserved) throw new Error('expected a reservation')
    await expect(store.markSettled(input().key, { txHash: '0xabc', settledAt: T0, reservationToken: 'wrong' })).resolves.toBe(
      'not_settleable',
    )
    await expect(
      store.markSettled(input().key, { txHash: '0xabc', settledAt: T0, reservationToken: r.reservationToken }),
    ).resolves.toBe('forward')
    const record = await store.get(input().key)
    expect(record).toMatchObject({ state: 'forwarding', forwardCount: 1, txHash: '0xabc', forwardingStartedAt: T0 })
    // a second holder-style call changes nothing
    await expect(
      store.markSettled(input().key, { txHash: '0xdef', settledAt: T0, reservationToken: r.reservationToken }),
    ).resolves.toBe('not_settleable')
  })

  it('markSettled without a token settles only a settlement_unknown or a tokenless settling record', async () => {
    const store = open()
    await store.reserve(input('k1'))
    // settling WITH a token hash: a tokenless markSettled changes nothing
    await expect(store.markSettled('k1', { txHash: '0x1', settledAt: T0 })).resolves.toBe('not_settleable')
    await store.markSettlementUnknown('k1', T0)
    expect((await store.get('k1'))?.state).toBe('settlement_unknown')
    await expect(store.markSettled('k1', { txHash: '0x1', settledAt: T0 })).resolves.toBe('settled')
    expect(await store.get('k1')).toMatchObject({ state: 'settled', txHash: '0x1', forwardCount: 0 })
    await expect(store.markSettled('k1', { txHash: '0x2', settledAt: T0 })).resolves.toBe('not_settleable')
    await expect(store.markSettled('missing', { txHash: '0x2', settledAt: T0 })).resolves.toBe('not_settleable')
  })

  it('clearing a reservation token (past the deadline) makes the record resolvable and voids the holder', async () => {
    const store = open()
    const r = await store.reserve(input('k2'))
    if (!r.reserved) throw new Error('expected a reservation')
    await expect(store.clearReservation('k2', 'not-the-reserved-at')).resolves.toBe(false)
    await expect(store.clearReservation('k2', T0)).resolves.toBe(true)
    await expect(store.clearReservation('k2', T0)).resolves.toBe(false)
    // a late holder is refused; a later request settles it
    await expect(store.markSettled('k2', { txHash: '0x1', settledAt: T0, reservationToken: r.reservationToken })).resolves.toBe(
      'not_settleable',
    )
    await expect(store.markSettled('k2', { txHash: '0x1', settledAt: T0 })).resolves.toBe('settled')
  })

  it('release removes a settling or settlement_unknown record and nothing else', async () => {
    const store = open()
    await store.reserve(input('a'))
    await store.release('a')
    expect(await store.get('a')).toBeNull()
    await store.reserve(input('b'))
    await store.markSettlementUnknown('b', T0)
    await store.release('b')
    expect(await store.get('b')).toBeNull()
    const r = await store.reserve(input('c'))
    if (!r.reserved) throw new Error('expected a reservation')
    await store.markSettled('c', { txHash: '0x1', settledAt: T0, reservationToken: r.reservationToken })
    await store.release('c')
    expect((await store.get('c'))?.state).toBe('forwarding')
  })

  it('beginForwarding: settled -> forward, delivered stays delivered, and the cap exhausts a payment', async () => {
    const store = open()
    await store.reserve(input('s'))
    await store.markSettlementUnknown('s', T0)
    await store.markSettled('s', { txHash: '0x1', settledAt: T0 })
    await expect(store.beginForwarding('s', iso(1))).resolves.toBe('forward')
    expect(await store.get('s')).toMatchObject({ state: 'forwarding', forwardCount: 1 })
    // a young forwarding record is in flight
    await expect(store.beginForwarding('s', iso(2))).resolves.toBe('in_flight')
    await store.markFailed('s', { reason: 'upstream_timeout', failedAt: iso(3) })
    await expect(store.beginForwarding('s', iso(4))).resolves.toBe('forward')
    await store.markFailed('s', { reason: 'upstream_timeout', failedAt: iso(5) })
    await expect(store.beginForwarding('s', iso(6))).resolves.toBe('forward')
    expect((await store.get('s'))?.forwardCount).toBe(MAX_FORWARDS_PER_PAYMENT)
    await store.markFailed('s', { reason: 'upstream_timeout', failedAt: iso(7) })
    await expect(store.beginForwarding('s', iso(8))).resolves.toBe('exhausted')
    expect((await store.get('s'))?.state).toBe('exhausted')
    await expect(store.beginForwarding('s', iso(9))).resolves.toBe('exhausted')
  })

  it('beginForwarding takes over a forwarding record only past the takeover threshold', async () => {
    const store = open()
    const r = await store.reserve(input('t'))
    if (!r.reserved) throw new Error('expected a reservation')
    await store.markSettled('t', { txHash: '0x1', settledAt: T0, reservationToken: r.reservationToken })
    await expect(store.beginForwarding('t', iso(TAKEOVER_MS - 1))).resolves.toBe('in_flight')
    await expect(store.beginForwarding('t', iso(TAKEOVER_MS + 1))).resolves.toBe('forward')
    expect(await store.get('t')).toMatchObject({ state: 'forwarding', forwardCount: 2, failureReason: 'forwarding_abandoned' })
  })

  it('markDelivered and markFailed only act on a forwarding record, and a delivered record is final', async () => {
    const store = open()
    await store.reserve(input('d'))
    await store.markDelivered('d', { upstreamStatus: 200, deliveredAt: T0 })
    expect((await store.get('d'))?.state).toBe('settling')
    const r = await store.reserve(input('e'))
    if (!r.reserved) throw new Error('expected a reservation')
    await store.markSettled('e', { txHash: '0x1', settledAt: T0, reservationToken: r.reservationToken })
    await store.markDelivered('e', { upstreamStatus: 200, deliveredAt: T0 })
    expect(await store.get('e')).toMatchObject({ state: 'delivered', upstreamStatus: 200, deliveredAt: T0 })
    await store.markFailed('e', { reason: 'x', failedAt: T0 })
    expect((await store.get('e'))?.state).toBe('delivered')
    await expect(store.beginForwarding('e', iso(TAKEOVER_MS * 3))).resolves.toBe('delivered')
  })

  it('one-call policy survives a restart: a delivered payment stays delivered in a fresh store on the same file', async () => {
    const first = open()
    const r = await first.reserve(input('persist'))
    if (!r.reserved) throw new Error('expected a reservation')
    await first.markSettled('persist', { txHash: '0xhash', settledAt: T0, reservationToken: r.reservationToken })
    await first.markDelivered('persist', { upstreamStatus: 200, deliveredAt: T0 })
    first.close()
    const second = open()
    expect(await second.get('persist')).toMatchObject({ state: 'delivered', txHash: '0xhash', forwardCount: 1 })
    await expect(second.beginForwarding('persist', iso(10 * TAKEOVER_MS))).resolves.toBe('delivered')
    const again = await second.reserve(input('persist'))
    expect(again.reserved).toBe(false)
  })

  it('clears every reservation-token hash at startup: a restart voids the holder', async () => {
    const first = open()
    const r = await first.reserve(input('restart'))
    if (!r.reserved) throw new Error('expected a reservation')
    first.close()
    const second = open()
    await expect(
      second.markSettled('restart', { txHash: '0x1', settledAt: T0, reservationToken: r.reservationToken }),
    ).resolves.toBe('not_settleable')
    // and the record is now resolvable by a later request
    await expect(second.markSettled('restart', { txHash: '0x1', settledAt: T0 })).resolves.toBe('settled')
  })

  it('refuses to open a database another process (connection) holds, and recovers once it is closed', () => {
    const first = open()
    expect(() => openSqliteConsumedPaymentStore(file, { takeoverAfterMs: TAKEOVER_MS })).toThrow(StoreLockedError)
    first.close()
    expect(() => open()).not.toThrow()
  })

  it('keeps the file locked against a plain reader while open (exclusive locking mode)', () => {
    open()
    const other = new DatabaseSync(file)
    expect(() => other.prepare('SELECT count(*) FROM payments').get()).toThrow(/locked/i)
    other.close()
  })

  it('reports writability', () => {
    const store = open()
    expect(store.isWritable()).toBe(true)
  })
})
