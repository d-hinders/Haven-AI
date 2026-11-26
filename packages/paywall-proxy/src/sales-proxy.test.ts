import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { receiptNumberForTransaction, type HexString } from '@haven_ai/merchant-payments'
import { reportSaleAgain, runReportSaleCommand } from './report-sale.js'
import {
  CHAT_PATH,
  chatRequest,
  newBuyer,
  SALES_KEY,
  startHarness,
  startHaven,
  until,
  type Harness,
  type MockHaven,
} from './test-harness.js'

const TX_HASH = `0x${'1'.repeat(64)}`

let harness: Harness | undefined
let haven: MockHaven | undefined

afterEach(async () => {
  await harness?.stop()
  await haven?.close()
  harness = undefined
  haven = undefined
})

function salesDir(): string {
  return mkdtempSync(join(tmpdir(), 'paywall-sales-'))
}

/** The outbox file's lines, so a test can pin what is durable on disk. */
function outboxLines(dir: string): unknown[] {
  const text = readFileSync(join(dir, 'sales-outbox.jsonl'), 'utf8')
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as unknown)
}

function salesEnv(mock: MockHaven | undefined, dir: string): Record<string, string> {
  return {
    HAVEN_MERCHANT_KEY: SALES_KEY,
    HAVEN_SALES_URL: mock?.url ?? 'http://127.0.0.1:1',
    SALES_OUTBOX: join(dir, 'sales-outbox.jsonl'),
  }
}

/** Fast resends and a short attempt limit, so a test never waits on §5's real 1/4/16 s. */
const FAST = { salesRetryDelaysMs: [10, 10, 10], salesAttemptTimeoutMs: 300, salesOutboxReplayMs: 10_000 }

async function paidCall(h: Harness): Promise<{ status: number; body: string; elapsed: number }> {
  const buyer = newBuyer()
  const { header } = await buyer.pay(h, CHAT_PATH, chatRequest())
  const started = Date.now()
  const res = await fetch(`${h.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': header }))
  const body = await res.text()
  return { status: res.status, body, elapsed: Date.now() - started }
}

describe('sales reporting (#4898)', () => {
  it('reports one sale record for a settled call, with the settlement hash, the product and the reserved reference', async () => {
    haven = await startHaven()
    const dir = salesDir()
    harness = await startHarness({ dir, env: salesEnv(haven, dir), overrides: FAST })

    const buyer = newBuyer()
    const { header } = await buyer.pay(harness, CHAT_PATH, chatRequest())
    const res = await fetch(`${harness.base}${CHAT_PATH}`, chatRequest({ 'payment-signature': header }))
    expect(res.status).toBe(200)

    await until(() => haven!.seen.length === 1)
    const sent = JSON.parse(haven.seen[0]!.body) as Record<string, unknown>
    expect(sent).toMatchObject({
      version: 1,
      tx_hash: TX_HASH,
      chain: 'eip155:84532',
      product_id: 'chat-sol-1k',
      product_name: 'Chat, 1,000 output tokens',
      amount: '10000',
      payer: buyer.address,
    })
    expect(sent.merchant_reference).toMatch(/^sale_[0-9A-Z]{26}$/)
    expect(haven.seen[0]!.url).toBe('/merchant/sales')
    expect(haven.seen[0]!.headers.authorization).toBe(`Bearer ${SALES_KEY}`)

    await harness.proxy.sales!.idle()
    const record = await harness.proxy.store.findByTxHash(TX_HASH)
    expect(record?.merchantReference).toBe(sent.merchant_reference)
    expect(record?.saleReported).toBe(true)
    expect(harness.logs.find((line) => line.event === 'started')).toMatchObject({ sales_reporting: 'on' })
  })

  it('gives the buyer the same answer, as fast, whether Haven accepts, refuses, is slow or is unreachable', async () => {
    const scenarios: { name: string; behaviour?: Parameters<typeof startHaven>[0]; unreachable?: boolean }[] = [
      { name: 'accepts', behaviour: { status: 201 } },
      { name: 'refuses', behaviour: { status: 422, body: { error_code: 'no_payment_to_account' } } },
      { name: 'is slow', behaviour: { status: 201, delayMs: 5_000 } },
      { name: 'is unreachable', unreachable: true },
    ]
    const answers: { name: string; status: number; body: string; elapsed: number }[] = []

    for (const scenario of scenarios) {
      const mock = scenario.unreachable ? undefined : await startHaven(scenario.behaviour)
      const dir = salesDir()
      const h = await startHarness({ dir, env: salesEnv(mock, dir), overrides: FAST })
      try {
        const answer = await paidCall(h)
        answers.push({ name: scenario.name, ...answer })
      } finally {
        await h.stop()
        await mock?.close()
      }
    }

    // The same status and the same body in every case.
    expect(new Set(answers.map((answer) => `${answer.status} ${answer.body}`)).size).toBe(1)
    expect(answers[0]!.status).toBe(200)
    // And the buyer never waits on Haven: the slow and unreachable cases are
    // bounded by the upstream call, not by the reporter's 10 s attempt.
    for (const answer of answers) expect(answer.elapsed).toBeLessThan(1_500)
  })

  it('resends a record Haven answers "not visible yet" with, and accepts it once the transaction is visible', async () => {
    haven = await startHaven(undefined, [
      { status: 425, body: { error_code: 'transaction_not_visible', retry_after_seconds: 0 } },
      { status: 201, body: { sale: { id: 'sale-1' } } },
    ])
    const dir = salesDir()
    harness = await startHarness({ dir, env: salesEnv(haven, dir), overrides: FAST })

    const answer = await paidCall(harness)
    expect(answer.status).toBe(200)
    await until(() => harness!.logs.some((line) => line.event === 'sales_report_accepted'), 4_000)
    expect(haven.seen.length).toBeGreaterThanOrEqual(2)
    expect(harness.proxy.sales!.outboxDepth()).toBe(0)
    expect((await harness.proxy.store.findByTxHash(TX_HASH))?.saleReported).toBe(true)
  })

  it('resends a record Haven asks to be retried, from the outbox, and stops once Haven accepts', async () => {
    haven = await startHaven({ status: 503, body: { error_code: 'chain_unavailable' } })
    const dir = salesDir()
    harness = await startHarness({ dir, env: salesEnv(haven, dir), overrides: { ...FAST, salesOutboxReplayMs: 40 } })

    const answer = await paidCall(harness)
    expect(answer.status).toBe(200)

    // The core reporter's four attempts (the first and three resends) all fail,
    // so the record goes to the outbox.
    await until(() => haven!.seen.length >= 4, 4_000)
    await until(() => harness!.logs.some((line) => line.event === 'sales_outbox_queued'), 4_000)
    expect(harness.proxy.sales!.outboxDepth()).toBe(1)

    // Haven recovers; the outbox's next replay delivers the same record.
    haven.behaviour = { status: 201, body: { sale: { id: 'sale-1' } } }
    await until(() => harness!.logs.some((line) => line.event === 'sales_outbox_accepted'), 4_000)
    expect(harness.proxy.sales!.outboxDepth()).toBe(0)
    // The store's flag records that the sale reached Haven, however it got there.
    expect((await harness.proxy.store.findByTxHash(TX_HASH))?.saleReported).toBe(true)
    const resent = JSON.parse(haven.seen[haven.seen.length - 1]!.body) as Record<string, unknown>
    expect(resent.tx_hash).toBe(TX_HASH)
    expect(resent.merchant_reference).toBe(
      (JSON.parse(haven.seen[0]!.body) as Record<string, unknown>).merchant_reference,
    )
  })

  it('sends nothing and starts normally when no merchant key is configured', async () => {
    harness = await startHarness()
    expect(harness.proxy.sales).toBeUndefined()
    expect(harness.logs.find((line) => line.event === 'started')).toMatchObject({
      sales_reporting: 'off (no HAVEN_MERCHANT_KEY)',
    })

    const answer = await paidCall(harness)
    expect(answer.status).toBe(200)
    const health = (await (await fetch(`${harness.base}/healthz`)).json()) as Record<string, unknown>
    expect(health.sales).toBeUndefined()
  })

  it('never puts the merchant key in a log line or a response', async () => {
    haven = await startHaven({ status: 401, body: { error_code: 'invalid_key' } })
    const dir = salesDir()
    harness = await startHarness({ dir, env: salesEnv(haven, dir), overrides: FAST })

    const answer = await paidCall(harness)
    await harness.proxy.sales!.idle()
    await until(() => harness!.logs.some((line) => line.event === 'sales_report_refused'), 4_000)

    expect(answer.body).not.toContain(SALES_KEY)
    expect(JSON.stringify(harness.logs)).not.toContain(SALES_KEY)
    const health = await (await fetch(`${harness.base}/healthz`)).text()
    expect(health).not.toContain(SALES_KEY)
    expect(harness.logs.find((line) => line.event === 'sales_report_refused')).toMatchObject({ status: 401 })
  })

  it('carries the receipt number and VAT treatment of the receipt the buyer got, and leaves both out without a receipt', async () => {
    haven = await startHaven()
    const dir = salesDir()
    harness = await startHarness({
      dir,
      env: {
        ...salesEnv(haven, dir),
        VAT_RULE: 'SE_25_WITH_EU_REVERSE_CHARGE',
        SELLER_NAME: 'Acme AB',
        SELLER_ORG_NR: '556000-0000',
        SELLER_VAT_NR: 'SE556000000001',
      },
      overrides: FAST,
    })

    const answer = await paidCall(harness)
    expect(answer.status).toBe(200)
    await until(() => haven!.seen.length === 1)
    const sent = JSON.parse(haven.seen[0]!.body) as Record<string, unknown>
    expect(sent.receipt_number).toBe(receiptNumberForTransaction(TX_HASH as HexString))
    expect(sent.vat_treatment).toBe('SE_25')

    await harness.stop()
    harness = undefined

    // Without a VAT rule the deployment issues no receipt, so the record states neither.
    haven.behaviour = { status: 201 }
    const plainDir = salesDir()
    harness = await startHarness({ dir: plainDir, env: salesEnv(haven, plainDir), overrides: FAST })
    const plain = await paidCall(harness)
    expect(plain.status).toBe(200)
    await until(() => haven!.seen.length === 2)
    const withoutReceipt = JSON.parse(haven.seen[1]!.body) as Record<string, unknown>
    expect('receipt_number' in withoutReceipt).toBe(false)
    expect('vat_treatment' in withoutReceipt).toBe(false)
  })

  it('the command prints the outcome and exits 0 when Haven accepts', async () => {
    haven = await startHaven()
    const dir = salesDir()
    harness = await startHarness({ dir, env: salesEnv(haven, dir), overrides: FAST })

    const answer = await paidCall(harness)
    expect(answer.status).toBe(200)
    await until(() => haven!.seen.length === 1)
    await harness.proxy.close()

    const again = await startHaven()
    const printed: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((line: string) => void printed.push(line))
    try {
      const code = await runReportSaleCommand([TX_HASH], { ...harness.env, HAVEN_SALES_URL: again.url })
      expect(code).toBe(0)
      expect(printed).toHaveLength(1)
      const line = JSON.parse(printed[0]!) as Record<string, unknown>
      expect(line).toMatchObject({ outcome: 'accepted', status: 201, tx_hash: TX_HASH })
      expect(line.merchant_reference).toMatch(/^sale_[0-9A-Z]{26}$/)
      expect(printed[0]).not.toContain(SALES_KEY)
    } finally {
      log.mockRestore()
      await again.close()
    }
  })

  it('reports a past settled call again on request, with the reference the store reserved or a new one', async () => {
    haven = await startHaven()
    const dir = salesDir()
    harness = await startHarness({ dir, env: salesEnv(haven, dir), overrides: FAST })

    const answer = await paidCall(harness)
    expect(answer.status).toBe(200)
    await until(() => haven!.seen.length === 1)
    const first = JSON.parse(haven.seen[0]!.body) as Record<string, unknown>

    // The command opens PAYMENTS_DB, so the proxy must be stopped (§6).
    const config = harness.proxy.config
    const products = harness.proxy.products
    await harness.proxy.close()

    const again = await startHaven()
    try {
      const configWithHaven = { ...config, sales: { ...config.sales!, havenBaseUrl: again.url } }
      const resent = await reportSaleAgain(configWithHaven, products, { txHash: TX_HASH })
      expect(resent.outcome.outcome).toBe('accepted')
      expect(resent.record.merchant_reference).toBe(first.merchant_reference)
      expect(JSON.parse(again.seen[0]!.body)).toMatchObject({
        tx_hash: TX_HASH,
        product_id: 'chat-sol-1k',
        merchant_reference: first.merchant_reference,
      })

      const fresh = await reportSaleAgain(configWithHaven, products, { txHash: TX_HASH, newReference: true })
      expect(fresh.outcome.outcome).toBe('accepted')
      expect(fresh.record.merchant_reference).not.toBe(first.merchant_reference)
      expect(fresh.record.merchant_reference).toMatch(/^sale_[0-9A-Z]{26}$/)
    } finally {
      await again.close()
    }
  })

  it('delivers a sale whose report is between resends when the proxy stops, from the outbox of the next proxy (#5032)', async () => {
    // Haven answers 425 (the route's retry answer), so the reporter is in a
    // resend wait when close() is called.
    const first = await startHaven({ status: 425, body: { error_code: 'transaction_not_visible', retry_after_seconds: 0 } })
    const dir = salesDir()
    harness = await startHarness({
      dir,
      env: salesEnv(first, dir),
      overrides: { ...FAST, salesRetryDelaysMs: [300, 300, 300], salesAttemptTimeoutMs: 300 },
    })

    const answer = await paidCall(harness)
    expect(answer.status).toBe(200)
    await until(() => harness!.logs.some((line) => line.event === 'sales_report_retry'), 4_000)
    // The record is durable before the first attempt, and the reporter is now
    // waiting to resend it.
    expect(outboxLines(dir)).toHaveLength(1)

    // The deploy procedure stops the old process before starting the new one.
    const accepting = await startHaven()
    await harness.restart({ ...FAST, salesOutboxReplayMs: 40 }, { HAVEN_SALES_URL: accepting.url })
    await first.close()

    await until(() => accepting.seen.length === 1, 4_000)
    // The replay's accept is logged after the store's flag is set.
    await until(() => harness!.logs.some((line) => line.event === 'sales_outbox_accepted'), 4_000)
    expect((await harness.proxy.store.findByTxHash(TX_HASH))?.saleReported).toBe(true)
    expect(harness.proxy.sales!.outboxDepth()).toBe(0)
    expect(outboxLines(dir)).toHaveLength(0)
    await accepting.close()
  })

  it('removes an accepted record from the outbox, and a restarted proxy does not send it again (#5032)', async () => {
    haven = await startHaven()
    const dir = salesDir()
    harness = await startHarness({ dir, env: salesEnv(haven, dir), overrides: FAST })

    const answer = await paidCall(harness)
    expect(answer.status).toBe(200)
    await until(() => harness!.logs.some((line) => line.event === 'sales_report_accepted'), 4_000)
    await harness.proxy.sales!.idle()
    expect(outboxLines(dir)).toHaveLength(0)

    await harness.restart({ ...FAST, salesOutboxReplayMs: 40 })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(haven.seen).toHaveLength(1)
    expect(harness.proxy.sales!.outboxDepth()).toBe(0)
  })

  it('removes a record Haven refuses for good, and a restarted proxy does not send it again (#5032)', async () => {
    haven = await startHaven({ status: 422, body: { error_code: 'no_payment_to_account' } })
    const dir = salesDir()
    harness = await startHarness({ dir, env: salesEnv(haven, dir), overrides: FAST })

    const answer = await paidCall(harness)
    expect(answer.status).toBe(200)
    await until(() => harness!.logs.some((line) => line.event === 'sales_report_refused'), 4_000)
    await harness.proxy.sales!.idle()
    expect(outboxLines(dir)).toHaveLength(0)

    const second = await startHaven()
    await harness.restart({ ...FAST, salesOutboxReplayMs: 40 }, { HAVEN_SALES_URL: second.url })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(second.seen).toHaveLength(0)
    await second.close()
  })

  it('counts only records past their first delivery round in /healthz outbox_depth (#5032)', async () => {
    haven = await startHaven({ status: 503, body: { error_code: 'chain_unavailable' } })
    const dir = salesDir()
    harness = await startHarness({
      dir,
      env: salesEnv(haven, dir),
      overrides: { ...FAST, salesRetryDelaysMs: [300, 300, 300], salesOutboxReplayMs: 10_000 },
    })

    const answer = await paidCall(harness)
    expect(answer.status).toBe(200)
    // The record is in the file from the first moment...
    await until(() => outboxLines(dir).length === 1, 4_000)
    // ...but it is in its first delivery round, so it is not waiting for a replay.
    const during = (await (await fetch(`${harness.base}/healthz`)).json()) as { sales?: { outbox_depth?: number } }
    expect(during.sales?.outbox_depth).toBe(0)

    // The first round ended without an answer: now it waits.
    await until(() => harness!.logs.some((line) => line.event === 'sales_outbox_queued'), 4_000)
    const after = (await (await fetch(`${harness.base}/healthz`)).json()) as { sales?: { outbox_depth?: number } }
    expect(after.sales?.outbox_depth).toBe(1)
  })
})
