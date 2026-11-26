import { describe, expect, it, vi } from 'vitest'
import {
  SALE_REPORT_RETRY_DELAYS_MS,
  buildSaleRecord,
  reportSale,
  saleReportUrl,
  type SaleReportEvent,
} from './sale-report.js'

// Test fixtures only: a made-up key, hash and addresses.
const KEY = 'sk_merchant_test_0123456789abcdef'
const TX = '0xAB00000000000000000000000000000000000000000000000000000000000001' as const
const PAYER = '0x1111111111111111111111111111111111111111' as const

const record = buildSaleRecord({
  txHash: TX,
  chainId: 84532,
  productId: 'field_tip',
  productName: 'Haven Field Tip',
  amount: 5_000n,
  payer: PAYER,
  merchantReference: 'sale_01JB8Z3K4M5N6P7Q8R9S0T1V2W',
  receiptNumber: 'FAK-1',
  vatTreatment: 'SE_25',
})

function answer(status: number, body?: unknown, headers?: Record<string, string>): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

const NOT_VISIBLE = () =>
  answer(
    425,
    { error: 'transaction_not_visible', error_code: 'transaction_not_visible', message: 'later', retry_after_seconds: 10 },
    { 'retry-after': '10' },
  )

function harness(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const next = responses.shift()
    if (!next) throw new Error('no more answers')
    if (next instanceof Error) throw next
    return next
  }) as unknown as typeof fetch
  const sleeps: number[] = []
  const lines: Array<{ event: SaleReportEvent; fields: Record<string, unknown> }> = []
  return {
    calls,
    sleeps,
    lines,
    run: () =>
      reportSale({
        havenBaseUrl: 'https://haven.example/',
        salesKey: KEY,
        record,
        fetch: fetchMock,
        sleep: async (ms) => {
          sleeps.push(ms)
        },
        log: (event, fields) => lines.push({ event, fields }),
      }),
  }
}

describe('buildSaleRecord (§5)', () => {
  it('builds the version 1 record with a lower-case hash and the CAIP-2 chain', () => {
    expect(record).toEqual({
      version: 1,
      tx_hash: TX.toLowerCase(),
      chain: 'eip155:84532',
      product_id: 'field_tip',
      product_name: 'Haven Field Tip',
      amount: '5000',
      payer: PAYER,
      merchant_reference: 'sale_01JB8Z3K4M5N6P7Q8R9S0T1V2W',
      receipt_number: 'FAK-1',
      vat_treatment: 'SE_25',
    })
  })

  it('leaves absent optionals out rather than sending null', () => {
    const bare = buildSaleRecord({
      txHash: TX,
      chainId: 8453,
      productId: 'p',
      amount: 1n,
      payer: PAYER,
      merchantReference: 'sale_x',
    })
    expect(Object.keys(bare).sort()).toEqual(
      ['amount', 'chain', 'merchant_reference', 'payer', 'product_id', 'tx_hash', 'version'].sort(),
    )
  })
})

describe('reportSale', () => {
  it('posts the record once to /merchant/sales with the key as the bearer token', async () => {
    const h = harness([answer(201, { id: 'x' })])
    const outcome = await h.run()
    expect(outcome).toEqual({ outcome: 'accepted', status: 201, attempts: 1 })
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0].url).toBe('https://haven.example/merchant/sales')
    expect(saleReportUrl('https://haven.example')).toBe('https://haven.example/merchant/sales')
    expect(h.calls[0].init.method).toBe('POST')
    const headers = h.calls[0].init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${KEY}`)
    expect(headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(String(h.calls[0].init.body))).toEqual(record)
    expect(h.lines.map((l) => l.event)).toEqual(['sales_report_accepted'])
  })

  it('treats an identical resend (200) as accepted', async () => {
    const h = harness([answer(200, { id: 'x' })])
    expect((await h.run()).outcome).toBe('accepted')
  })

  it('resends after "not visible yet", waiting at least the answer\'s Retry-After', async () => {
    const h = harness([NOT_VISIBLE(), NOT_VISIBLE(), answer(201, {})])
    const outcome = await h.run()
    expect(outcome).toEqual({ outcome: 'accepted', status: 201, attempts: 3 })
    // Backoff 1 s and 4 s, each raised to the 10 s Retry-After.
    expect(h.sleeps).toEqual([10_000, 10_000])
    expect(h.lines.map((l) => l.event)).toEqual(['sales_report_retry', 'sales_report_retry', 'sales_report_accepted'])
    // Every send carries the same record, so Haven sees one record for the transaction.
    const bodies = h.calls.map((c) => String(c.init.body))
    expect(new Set(bodies).size).toBe(1)
  })

  it('retries a 5xx and a network failure on the 1 s, 4 s, 16 s schedule', async () => {
    const h = harness([answer(503, { error_code: 'chain_unavailable' }), new TypeError('fetch failed'), answer(502), answer(201, {})])
    const outcome = await h.run()
    expect(outcome).toEqual({ outcome: 'accepted', status: 201, attempts: 4 })
    expect(h.sleeps).toEqual([...SALE_REPORT_RETRY_DELAYS_MS])
  })

  it('treats an attempt that does not answer in time as a timeout and retries it', async () => {
    const hanging = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    ) as unknown as typeof fetch
    const lines: Array<{ event: SaleReportEvent; fields: Record<string, unknown> }> = []
    const outcome = await reportSale({
      havenBaseUrl: 'https://haven.example',
      salesKey: KEY,
      record,
      fetch: hanging,
      sleep: async () => {},
      attemptTimeoutMs: 5,
      retryDelaysMs: [1],
      log: (event, fields) => lines.push({ event, fields }),
    })
    expect(outcome).toEqual({ outcome: 'gave_up', status: null, code: null, attempts: 2 })
    expect(lines.map((l) => [l.event, l.fields.code])).toEqual([
      ['sales_report_retry', 'Timeout'],
      ['sales_report_gave_up', 'Timeout'],
    ])
  })

  it('gives up after the last retry and says so once', async () => {
    const h = harness([NOT_VISIBLE(), NOT_VISIBLE(), NOT_VISIBLE(), NOT_VISIBLE(), answer(201, {})])
    const outcome = await h.run()
    expect(outcome).toEqual({ outcome: 'gave_up', status: 425, code: 'transaction_not_visible', attempts: 4 })
    expect(h.calls).toHaveLength(4)
    expect(h.lines.filter((l) => l.event === 'sales_report_gave_up')).toHaveLength(1)
  })

  it.each([
    [400, 'unsupported_record_version'],
    [401, 'MERCHANT_KEY_INVALID'],
    [403, 'MERCHANT_SERVICES_OFF'],
    [409, 'sale_record_conflict'],
    [422, 'no_payment_to_account'],
    [429, 'RATE_LIMITED'],
  ])('logs a %i refusal once and never resends it', async (status, code) => {
    const h = harness([answer(status, { error: code, error_code: code, message: 'no' }), answer(201, {})])
    const outcome = await h.run()
    expect(outcome).toEqual({ outcome: 'refused', status, code, attempts: 1 })
    expect(h.calls).toHaveLength(1)
    expect(h.sleeps).toEqual([])
    expect(h.lines).toEqual([
      {
        event: 'sales_report_refused',
        fields: { tx_hash: record.tx_hash, merchant_reference: record.merchant_reference, status, code, attempts: 1 },
      },
    ])
  })

  it('never puts the key in a log line or an outcome, whatever the answer', async () => {
    const leaky = new Error(`connect failed for Bearer ${KEY}`)
    const h = harness([
      leaky,
      answer(500, { message: `echo ${KEY}` }),
      NOT_VISIBLE(),
      answer(401, { error_code: 'MERCHANT_KEY_INVALID', message: `bad key ${KEY}` }),
    ])
    const outcome = await h.run()
    const written = JSON.stringify({ outcome, lines: h.lines })
    expect(written).not.toContain(KEY)
    expect(written).not.toContain('sk_merchant_')
  })

  it('never throws, even when the fetch implementation does', async () => {
    const h = harness([new Error('boom'), new Error('boom'), new Error('boom'), new Error('boom')])
    await expect(h.run()).resolves.toMatchObject({ outcome: 'gave_up', attempts: 4 })
  })
})
