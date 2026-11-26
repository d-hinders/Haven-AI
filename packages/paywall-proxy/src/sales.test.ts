import { describe, expect, it } from 'vitest'
import type { ConsumedPaymentRecord, SaleRecord, SaleReportOutcome } from '@haven_ai/merchant-payments'
import type { Product } from './products.js'
import { createSalesReporter, saleRecordFor, type SalesSettings } from './sales.js'
import type { SalesOutbox } from './sales-outbox.js'

const PRODUCT: Product = {
  id: 'chat-sol-1k',
  name: 'Chat, 1,000 output tokens',
  method: 'POST',
  path: '/v3/compat/chat/completions',
  route: 'POST /v3/compat/chat/completions',
  model: 'openai/gpt-6-sol',
  price: 10000n,
  outputTokenCap: 1000,
  description: 'One chat completion on openai/gpt-6-sol, up to 1,000 output tokens.',
}

const RECORD: ConsumedPaymentRecord = {
  key: 'eip3009:84532:0x7a3f9c2e1b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a:0xnonce',
  state: 'forwarding',
  productId: PRODUCT.id,
  chain: 'eip155:84532',
  payer: '0x7a3f9c2e1b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a',
  amount: '10000',
  validBefore: 1_800_000_000,
  reservedAt: '2026-11-18T10:00:00.000Z',
  merchantReference: 'sale_01JB8Z3K4M5N6P7Q8R9S0T1V2W',
  authorizationDigest: 'digest',
  txHash: `0x${'1'.repeat(64)}`,
  settledAt: '2026-11-18T10:00:01.000Z',
  forwardingStartedAt: '2026-11-18T10:00:01.000Z',
  forwardCount: 1,
  saleReported: false,
}

const SETTINGS: SalesSettings = {
  havenBaseUrl: 'https://api.haven.example',
  merchantKey: '«redacted:sk_…»',
  outboxPath: '/tmp/sales-outbox.jsonl',
}

function answer(status: number, body: unknown = {}): typeof fetch {
  return async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

interface FakeOutbox extends SalesOutbox {
  /** Every call, in order, so a test can pin that the record is durable before the first attempt. */
  calls: string[]
  queued: { key: string; record: SaleRecord }[]
  released: { key: string; outcome: SaleReportOutcome }[]
  removed: { key: string; reason: 'accepted' | 'refused' }[]
}

function fakeOutbox(): FakeOutbox {
  const calls: string[] = []
  const queued: { key: string; record: SaleRecord }[] = []
  const released: { key: string; outcome: SaleReportOutcome }[] = []
  const removed: { key: string; reason: 'accepted' | 'refused' }[] = []
  return {
    calls,
    queued,
    released,
    removed,
    queue: async (key, record) => {
      calls.push('queue')
      queued.push({ key, record })
    },
    release: async (key, outcome) => {
      calls.push('release')
      released.push({ key, outcome })
    },
    remove: async (key, reason) => {
      calls.push('remove')
      removed.push({ key, reason })
    },
    replay: async () => undefined,
    depth: () => released.length,
    start: () => undefined,
    stop: () => undefined,
  }
}

describe('the sale record (#4898)', () => {
  it('carries the settlement hash, the product, the amount, the payer and the reserved reference', () => {
    const sale = saleRecordFor(RECORD, PRODUCT, undefined, 84532)
    expect(sale).toEqual({
      version: 1,
      tx_hash: `0x${'1'.repeat(64)}`,
      chain: 'eip155:84532',
      product_id: 'chat-sol-1k',
      product_name: 'Chat, 1,000 output tokens',
      amount: '10000',
      payer: '0x7a3f9c2e1b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a',
      merchant_reference: 'sale_01JB8Z3K4M5N6P7Q8R9S0T1V2W',
    })
  })

  it('carries the receipt number and VAT treatment of the receipt the buyer got, and leaves both out when there was none', () => {
    const withReceipt = saleRecordFor(RECORD, PRODUCT, { fakturanummer: 'FAK-5552735618149454', momsbehandling: 'SE_25' }, 84532)
    expect(withReceipt.receipt_number).toBe('FAK-5552735618149454')
    expect(withReceipt.vat_treatment).toBe('SE_25')

    const without = saleRecordFor(RECORD, PRODUCT, undefined, 84532)
    expect('receipt_number' in without).toBe(false)
    expect('vat_treatment' in without).toBe(false)
  })

  it('sends the product id as the name when the products file has none', () => {
    const sale = saleRecordFor(RECORD, { id: 'lookup' }, undefined, 84532)
    expect(sale.product_name).toBe('lookup')
  })
})

describe('the reporter (#4898, #5032)', () => {
  it('writes the record to the outbox before the first attempt, and removes it by key when Haven accepts', async () => {
    const marked: string[] = []
    const outbox = fakeOutbox()
    const reporter = createSalesReporter({
      settings: SETTINGS,
      chainId: 84532,
      store: { markSaleReported: async (key) => void marked.push(key) },
      outbox,
      log: () => undefined,
      fetch: async () => new Response('{}', { status: 201 }),
    })

    reporter.report(RECORD, PRODUCT)
    await reporter.idle()
    expect(outbox.calls).toEqual(['queue', 'remove'])
    expect(outbox.queued).toEqual([{ key: RECORD.key, record: saleRecordFor(RECORD, PRODUCT, undefined, 84532) }])
    expect(outbox.removed).toEqual([{ key: RECORD.key, reason: 'accepted' }])
    expect(marked).toEqual([RECORD.key])
    expect(reporter.stats()).toMatchObject({ reported: 1, refused: 0, queued: 0 })
  })

  it('releases a record the reporter gave up on, and a 429, but removes a refusal', async () => {
    const outbox = fakeOutbox()
    const gaveUp = createSalesReporter({
      settings: SETTINGS,
      chainId: 84532,
      store: { markSaleReported: async () => undefined },
      outbox,
      log: () => undefined,
      fetch: answer(503, { error_code: 'chain_unavailable' }),
      retryDelaysMs: [],
    })
    gaveUp.report(RECORD, PRODUCT)
    await gaveUp.idle()
    expect(outbox.calls).toEqual(['queue', 'release'])
    expect(outbox.released[0]!.outcome).toMatchObject({ outcome: 'gave_up', status: 503 })

    const limited = createSalesReporter({
      settings: SETTINGS,
      chainId: 84532,
      store: { markSaleReported: async () => undefined },
      outbox,
      log: () => undefined,
      fetch: answer(429, { error_code: 'rate_limited' }),
      retryDelaysMs: [],
    })
    limited.report(RECORD, PRODUCT)
    await limited.idle()
    expect(outbox.calls).toEqual(['queue', 'release', 'queue', 'release'])
    expect(outbox.released[1]!.outcome).toMatchObject({ outcome: 'refused', status: 429 })

    const refused = createSalesReporter({
      settings: SETTINGS,
      chainId: 84532,
      store: { markSaleReported: async () => undefined },
      outbox,
      log: () => undefined,
      fetch: answer(422, { error_code: 'no_payment_to_account' }),
      retryDelaysMs: [],
    })
    refused.report(RECORD, PRODUCT)
    await refused.idle()
    expect(outbox.calls).toEqual(['queue', 'release', 'queue', 'release', 'queue', 'remove'])
    expect(outbox.removed).toEqual([{ key: RECORD.key, reason: 'refused' }])
    expect(refused.stats()).toMatchObject({ refused: 1 })
  })

  it('stops writing to the store and the outbox once the proxy is closing', async () => {
    const marked: string[] = []
    const outbox = fakeOutbox()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const reporter = createSalesReporter({
      settings: SETTINGS,
      chainId: 84532,
      store: { markSaleReported: async (key) => void marked.push(key) },
      outbox,
      log: () => undefined,
      fetch: async () => {
        await gate
        return new Response('{}', { status: 201 })
      },
    })

    reporter.report(RECORD, PRODUCT)
    // The record is durable before the first attempt; the proxy then stops.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(outbox.calls).toEqual(['queue'])
    reporter.stop()
    release?.()
    await reporter.idle()

    // The late answer writes nothing: the record is in the outbox, and the next
    // proxy replays it.
    expect(outbox.calls).toEqual(['queue'])
    expect(marked).toEqual([])
  })

  it('returns at once and never throws, whatever Haven does', async () => {
    const reporter = createSalesReporter({
      settings: SETTINGS,
      chainId: 84532,
      store: { markSaleReported: async () => undefined },
      outbox: fakeOutbox(),
      log: () => undefined,
      fetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200))
        return new Response('{}', { status: 201 })
      },
    })

    const started = Date.now()
    expect(() => reporter.report(RECORD, PRODUCT)).not.toThrow()
    expect(Date.now() - started).toBeLessThan(50)
    expect(reporter.stats().pending).toBe(1)
    await reporter.idle()
    expect(reporter.stats().pending).toBe(0)
  })

  it('reports a payment once: a record already marked reported is not sent again', async () => {
    let calls = 0
    const outbox = fakeOutbox()
    const reporter = createSalesReporter({
      settings: SETTINGS,
      chainId: 84532,
      store: { markSaleReported: async () => undefined },
      outbox,
      log: () => undefined,
      fetch: async () => {
        calls += 1
        return new Response('{}', { status: 201 })
      },
    })

    reporter.report({ ...RECORD, saleReported: true }, PRODUCT)
    await reporter.idle()
    expect(calls).toBe(0)
    expect(outbox.calls).toEqual([])
  })
})
