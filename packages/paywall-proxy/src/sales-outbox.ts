/**
 * The proxy's sales outbox (docs/architecture/12-merchant-kit.md §5 *Delivery*,
 * §12): a bounded, persistent JSON Lines file at `SALES_OUTBOX` holding every
 * sale record from the moment it is built, replayed by a background task every
 * 60 s.
 *
 * **Queue-first (#5032).** The record is written here *before* the first
 * attempt, so a proxy that stops mid-delivery — between resends, or inside one —
 * loses nothing: the file is the durable record a restart replays. The record is
 * removed by key when Haven accepts it or refuses it for good (a 4xx other than
 * 429 and 425); a record whose first delivery round ended without an answer
 * stays and waits for a replay.
 *
 * A record in its first delivery round is **held**: the reporter is delivering
 * it right now, so a replay skips it. The hold is in memory only — a restart
 * holds nothing, which is exactly what makes the record replayable.
 *
 * The file is rewritten whole (temp file, then rename) on every change, so a
 * crash leaves either the old file or the new one, never a half-written line. A
 * replay takes a snapshot of the records waiting, attempts each one, and then
 * removes only the snapshot's entries by id: a sale that settles while a replay
 * is running is appended and survives the merge. A crash mid-replay leaves every
 * entry in the file, so the next replay sends it again — Haven's ingest is
 * idempotent on an identical record (§5).
 *
 * The bound is 10,000 records (§12). When it is full the proxy keeps what it has
 * and logs `sales_outbox_full` for each record it cannot add; the merchant clears
 * the cause (§12). A record is replayed at most `SALES_OUTBOX_MAX_ATTEMPTS`
 * times, one minute apart, and then logged as `sales_outbox_gave_up` and dropped.
 *
 * No entry, log line or error from here carries the merchant key: the key is the
 * reporter's, and this module never sees it.
 */
import { randomBytes } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { SaleRecord, SaleReportOutcome } from '@haven_ai/merchant-payments'
import type { LogFn } from './log.js'

/** §12: the outbox holds at most this many records. */
export const SALES_OUTBOX_MAX_RECORDS = 10_000

/** §5: the background task replays the outbox every 60 s. */
export const SALES_OUTBOX_REPLAY_INTERVAL_MS = 60_000

/**
 * How many times the outbox replays one record before it gives up on it. The
 * README states this number; the core reporter's own three resends happen before
 * a record ever reaches the outbox.
 */
export const SALES_OUTBOX_MAX_ATTEMPTS = 5

/** One record waiting in the outbox, as stored. */
export interface SalesOutboxEntry {
  /** Unique per entry, so a replay can remove exactly what it attempted. */
  id: string
  /** The consumed-payment store's key for the payment, so an accepted replay can mark it reported. */
  key: string
  record: SaleRecord
  /** Replays already made. */
  attempts: number
  queued_at: string
  /** The last answer's status, or `null` when the last attempt got none. */
  last_status: number | null
  last_code: string | null
}

export interface SalesOutboxDeps {
  path: string
  /**
   * One attempt at one record: the core reporter with no inline retries, so the
   * outbox's own cadence is the retry. Never throws.
   */
  send: (record: SaleRecord, key: string) => Promise<SaleReportOutcome>
  log: LogFn
  now?: () => Date
  maxRecords?: number
  maxAttempts?: number
  replayIntervalMs?: number
}

export interface SalesOutbox {
  /**
   * Write the record before the first attempt, and hold its key from replay
   * until `release` or `remove`. Never throws.
   */
  queue(key: string, record: SaleRecord): Promise<void>
  /**
   * The first delivery round ended without an answer (a 5xx, a timeout, a
   * network failure, 425, or 429): the record now waits for a replay. Never
   * throws.
   */
  release(key: string, outcome: SaleReportOutcome): Promise<void>
  /**
   * Haven accepted the record, or refused it for good: remove it by key, so no
   * restart sends it again. Never throws.
   */
  remove(key: string, reason: 'accepted' | 'refused'): Promise<void>
  /** One pass over the records waiting for a replay. Never throws. */
  replay(): Promise<void>
  /**
   * How many records are waiting for a replay. A record in its first delivery
   * round is not counted: the reporter is delivering it, not the outbox.
   */
  depth(): number
  /** Start the 60 s replay task (unref'd: it never holds the process open). */
  start(): void
  stop(): void
}

function isEntry(value: unknown): value is SalesOutboxEntry {
  if (value === null || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  const record = entry.record
  if (record === null || typeof record !== 'object') return false
  const sale = record as Record<string, unknown>
  return (
    typeof entry.id === 'string' &&
    typeof entry.key === 'string' &&
    typeof entry.attempts === 'number' &&
    typeof sale.tx_hash === 'string' &&
    typeof sale.merchant_reference === 'string' &&
    typeof sale.product_id === 'string'
  )
}

/** Read the file, skipping a line that is not an entry (a hand-edited or truncated file). */
function loadEntries(path: string, log: LogFn): SalesOutboxEntry[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    // No file yet: an empty outbox.
    return []
  }
  const entries: SalesOutboxEntry[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      log('sales_outbox_line_skipped', { reason: 'not_json' })
      continue
    }
    if (!isEntry(parsed)) {
      log('sales_outbox_line_skipped', { reason: 'not_an_entry' })
      continue
    }
    entries.push(parsed)
  }
  return entries
}

export function openSalesOutbox(deps: SalesOutboxDeps): SalesOutbox {
  const { path, send, log } = deps
  const now = deps.now ?? (() => new Date())
  const maxRecords = deps.maxRecords ?? SALES_OUTBOX_MAX_RECORDS
  const maxAttempts = deps.maxAttempts ?? SALES_OUTBOX_MAX_ATTEMPTS
  const replayIntervalMs = deps.replayIntervalMs ?? SALES_OUTBOX_REPLAY_INTERVAL_MS

  const entries = loadEntries(path, log)
  if (entries.length > 0) log('sales_outbox_loaded', { depth: entries.length })

  // Keys whose first delivery round is running: a replay skips them. In memory
  // only, so a restart holds nothing and replays everything the file holds.
  const held = new Set<string>()

  /** The records a replay may attempt: everything not in its first delivery round. */
  function waiting(): SalesOutboxEntry[] {
    return entries.filter((entry) => !held.has(entry.key))
  }

  // Every change to `entries` and the file runs one at a time, in call order.
  let tail: Promise<unknown> = Promise.resolve()
  function serial<T>(op: () => Promise<T> | T): Promise<T> {
    const run = tail.then(op, op)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  function persist(): void {
    const text = entries.map((entry) => JSON.stringify(entry)).join('\n')
    const temporary = `${path}.tmp`
    writeFileSync(temporary, text === '' ? '' : `${text}\n`, 'utf8')
    renameSync(temporary, path)
  }

  let timer: ReturnType<typeof setInterval> | undefined

  const outbox: SalesOutbox = {
    async queue(key, record) {
      try {
        await serial(() => {
          held.add(key)
          // One record per payment: a key already in the file is not added twice.
          if (entries.some((entry) => entry.key === key)) return
          if (entries.length >= maxRecords) {
            log('sales_outbox_full', {
              tx_hash: record.tx_hash,
              merchant_reference: record.merchant_reference,
              depth: entries.length,
            })
            return
          }
          entries.push({
            id: randomBytes(8).toString('hex'),
            key,
            record,
            attempts: 0,
            queued_at: now().toISOString(),
            last_status: null,
            last_code: null,
          })
          persist()
        })
      } catch (err) {
        // A full disk is not a reason to fail a settled call; the record is lost
        // and the line says so.
        log('sales_outbox_write_failed', {
          tx_hash: record.tx_hash,
          merchant_reference: record.merchant_reference,
          error: err instanceof Error ? err.name : 'UnknownError',
        })
      }
    },

    async release(key, outcome) {
      let record: SaleRecord | undefined
      try {
        await serial(() => {
          held.delete(key)
          const index = entries.findIndex((entry) => entry.key === key)
          if (index === -1) return
          const entry = entries[index]!
          record = entry.record
          entries[index] = {
            ...entry,
            last_status: outcome.status ?? null,
            last_code: outcome.outcome === 'accepted' ? null : outcome.code,
          }
          persist()
          log('sales_outbox_queued', {
            tx_hash: entry.record.tx_hash,
            merchant_reference: entry.record.merchant_reference,
            status: outcome.status ?? null,
            code: outcome.outcome === 'accepted' ? null : outcome.code,
            depth: waiting().length,
          })
        })
      } catch (err) {
        log('sales_outbox_write_failed', {
          tx_hash: record?.tx_hash ?? null,
          merchant_reference: record?.merchant_reference ?? null,
          error: err instanceof Error ? err.name : 'UnknownError',
        })
      }
    },

    async remove(key, reason) {
      let record: SaleRecord | undefined
      try {
        await serial(() => {
          held.delete(key)
          const index = entries.findIndex((entry) => entry.key === key)
          if (index === -1) return
          const [entry] = entries.splice(index, 1)
          record = entry!.record
          persist()
          log('sales_outbox_removed', {
            tx_hash: entry!.record.tx_hash,
            merchant_reference: entry!.record.merchant_reference,
            reason,
            depth: waiting().length,
          })
        })
      } catch (err) {
        log('sales_outbox_write_failed', {
          tx_hash: record?.tx_hash ?? null,
          merchant_reference: record?.merchant_reference ?? null,
          error: err instanceof Error ? err.name : 'UnknownError',
        })
      }
    },

    async replay() {
      try {
        const snapshot = await serial(() => waiting())
        if (snapshot.length === 0) return
        const survivors: SalesOutboxEntry[] = []
        for (const entry of snapshot) {
          const outcome = await send(entry.record, entry.key)
          if (outcome.outcome === 'accepted') {
            log('sales_outbox_accepted', {
              tx_hash: entry.record.tx_hash,
              merchant_reference: entry.record.merchant_reference,
              status: outcome.status,
              attempts: entry.attempts + 1,
            })
            continue
          }
          if (outcome.outcome === 'refused' && outcome.status !== 429) {
            log('sales_outbox_refused', {
              tx_hash: entry.record.tx_hash,
              merchant_reference: entry.record.merchant_reference,
              status: outcome.status,
              code: outcome.code,
              attempts: entry.attempts + 1,
            })
            continue
          }
          const attempts = entry.attempts + 1
          if (attempts >= maxAttempts) {
            log('sales_outbox_gave_up', {
              tx_hash: entry.record.tx_hash,
              merchant_reference: entry.record.merchant_reference,
              status: outcome.status ?? null,
              code: outcome.code ?? null,
              attempts,
            })
            continue
          }
          survivors.push({
            ...entry,
            attempts,
            last_status: outcome.status ?? null,
            last_code: outcome.code ?? null,
          })
        }
        await serial(() => {
          // Remove exactly what this pass attempted; keep anything added while it ran.
          const attempted = new Set(snapshot.map((entry) => entry.id))
          const added = entries.filter((entry) => !attempted.has(entry.id))
          entries.length = 0
          entries.push(...survivors, ...added)
          persist()
          log('sales_outbox_replayed', {
            attempted: snapshot.length,
            kept: survivors.length,
            depth: waiting().length,
          })
        })
      } catch (err) {
        log('sales_outbox_replay_failed', { error: err instanceof Error ? err.name : 'UnknownError' })
      }
    },

    depth: () => waiting().length,

    start() {
      if (timer !== undefined) return
      timer = setInterval(() => {
        void outbox.replay()
      }, replayIntervalMs)
      timer.unref()
    },

    stop() {
      if (timer === undefined) return
      clearInterval(timer)
      timer = undefined
    },
  }

  return outbox
}
