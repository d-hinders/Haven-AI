import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SaleRecord, SaleReportOutcome } from '@haven_ai/merchant-payments'
import { openSalesOutbox, SALES_OUTBOX_MAX_ATTEMPTS } from './sales-outbox.js'

const RECORD: SaleRecord = {
  version: 1,
  tx_hash: `0x${'1'.repeat(64)}`,
  chain: 'eip155:84532',
  product_id: 'chat-sol-1k',
  product_name: 'Chat, 1,000 output tokens',
  amount: '10000',
  payer: '0x7a3f9c2e1b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a',
  merchant_reference: 'sale_01JB8Z3K4M5N6P7Q8R9S0T1V2W',
}

const GAVE_UP: SaleReportOutcome = { outcome: 'gave_up', status: 503, code: 'chain_unavailable', attempts: 4 }
const ACCEPTED: SaleReportOutcome = { outcome: 'accepted', status: 201, attempts: 1 }
const REFUSED_422: SaleReportOutcome = { outcome: 'refused', status: 422, code: 'no_payment_to_account', attempts: 1 }
const REFUSED_429: SaleReportOutcome = { outcome: 'refused', status: 429, code: 'rate_limited', attempts: 1 }

const dirs: string[] = []

function outboxPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sales-outbox-'))
  dirs.push(dir)
  return join(dir, 'sales-outbox.jsonl')
}

function lines(path: string): unknown[] {
  const text = readFileSync(path, 'utf8')
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as unknown)
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the sales outbox (#4898)', () => {
  it('queues a record the reporter gave up on and replays it until Haven accepts', async () => {
    const path = outboxPath()
    const logs: Record<string, unknown>[] = []
    const outbox = openSalesOutbox({
      path,
      log: (event, fields) => logs.push({ event, ...fields }),
      send: async () => ACCEPTED,
    })

    await outbox.add('key', RECORD, GAVE_UP)
    expect(outbox.depth()).toBe(1)
    expect(lines(path)).toHaveLength(1)
    expect(logs.map((line) => line.event)).toContain('sales_outbox_queued')

    await outbox.replay()
    expect(outbox.depth()).toBe(0)
    expect(lines(path)).toHaveLength(0)
    expect(logs.map((line) => line.event)).toContain('sales_outbox_accepted')
  })

  it('keeps a record Haven asks to be retried, and drops it after the attempt limit', async () => {
    const path = outboxPath()
    const logs: Record<string, unknown>[] = []
    const outbox = openSalesOutbox({
      path,
      log: (event, fields) => logs.push({ event, ...fields }),
      send: async () => GAVE_UP,
    })

    await outbox.add('key', RECORD, GAVE_UP)
    for (let attempt = 1; attempt < SALES_OUTBOX_MAX_ATTEMPTS; attempt += 1) {
      await outbox.replay()
      expect(outbox.depth()).toBe(1)
      expect(lines(path)).toHaveLength(1)
    }
    await outbox.replay()
    expect(outbox.depth()).toBe(0)
    const gaveUp = logs.find((line) => line.event === 'sales_outbox_gave_up')
    expect(gaveUp).toMatchObject({ attempts: SALES_OUTBOX_MAX_ATTEMPTS, status: 503, code: 'chain_unavailable' })
  })

  it('drops a refusal and never resends it', async () => {
    const path = outboxPath()
    const logs: Record<string, unknown>[] = []
    let sends = 0
    const outbox = openSalesOutbox({
      path,
      log: (event, fields) => logs.push({ event, ...fields }),
      send: async () => {
        sends += 1
        return REFUSED_422
      },
    })

    await outbox.add('key', RECORD, REFUSED_422)
    await outbox.replay()
    expect(outbox.depth()).toBe(0)
    expect(sends).toBe(1)
    expect(logs.find((line) => line.event === 'sales_outbox_refused')).toMatchObject({
      status: 422,
      code: 'no_payment_to_account',
    })
  })

  it('keeps a 429: the rate limit is "could not be sent", not a refusal', async () => {
    const path = outboxPath()
    const outbox = openSalesOutbox({ path, log: () => undefined, send: async () => REFUSED_429 })

    await outbox.add('key', RECORD, REFUSED_429)
    await outbox.replay()
    expect(outbox.depth()).toBe(1)
    expect(lines(path)).toHaveLength(1)
  })

  it('keeps what it has when it is full, and logs each record it cannot add', async () => {
    const path = outboxPath()
    const logs: Record<string, unknown>[] = []
    const outbox = openSalesOutbox({ path, log: (event, fields) => logs.push({ event, ...fields }), send: async () => ACCEPTED, maxRecords: 1 })

    await outbox.add('key', RECORD, GAVE_UP)
    await outbox.add('key2', { ...RECORD, merchant_reference: 'sale_second' }, GAVE_UP)
    expect(outbox.depth()).toBe(1)
    expect(logs.filter((line) => line.event === 'sales_outbox_full')).toHaveLength(1)
  })

  it('keeps a record added while a replay is running', async () => {
    const path = outboxPath()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const outbox = openSalesOutbox({
      path,
      log: () => undefined,
      send: async () => {
        await gate
        return ACCEPTED
      },
    })

    await outbox.add('key', RECORD, GAVE_UP)
    const replaying = outbox.replay()
    await outbox.add('key3', { ...RECORD, merchant_reference: 'sale_added_during_replay' }, GAVE_UP)
    release?.()
    await replaying

    expect(outbox.depth()).toBe(1)
    const kept = lines(path) as { record: SaleRecord }[]
    expect(kept).toHaveLength(1)
    expect(kept[0]!.record.merchant_reference).toBe('sale_added_during_replay')
  })

  it('skips a line that is not an entry and keeps the rest', async () => {
    const path = outboxPath()
    const logs: Record<string, unknown>[] = []
    writeFileSync(
      path,
      `${JSON.stringify({ id: 'a', key: 'key', record: RECORD, attempts: 0, queued_at: '2026-11-18T00:00:00.000Z', last_status: 503, last_code: null })}\nnot json\n{"id":"b"}\n`,
    )
    const outbox = openSalesOutbox({ path, log: (event, fields) => logs.push({ event, ...fields }), send: async () => ACCEPTED })
    expect(outbox.depth()).toBe(1)
    expect(logs.filter((line) => line.event === 'sales_outbox_line_skipped')).toHaveLength(2)
  })

  it('survives a restart: the file is the record', async () => {
    const path = outboxPath()
    const first = openSalesOutbox({ path, log: () => undefined, send: async () => ACCEPTED })
    await first.add('key', RECORD, GAVE_UP)
    first.stop()

    const second = openSalesOutbox({ path, log: () => undefined, send: async () => ACCEPTED })
    expect(second.depth()).toBe(1)
    await second.replay()
    expect(second.depth()).toBe(0)
  })
})
