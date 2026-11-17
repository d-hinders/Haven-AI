/**
 * The proxy's consumed-payment store (docs/architecture/12-merchant-kit.md §6):
 * a SQLite file at `PAYMENTS_DB`, through `node:sqlite`, behind the core's
 * `ConsumedPaymentStore` interface. A payment buys one call and it is
 * remembered across restarts: a `delivered` record is never forwarded again.
 *
 * - One proxy process per file. The database is opened with
 *   `PRAGMA locking_mode=EXCLUSIVE` and a write transaction at startup; a
 *   second process gets SQLITE_BUSY and the store refuses to open
 *   (`StoreLockedError`). The operating system drops the lock when the process
 *   dies, so a crash never blocks the next start.
 * - Every reservation-token hash is cleared at startup. That is safe only
 *   because no other process holds one; a restart voids the "no proof needed"
 *   exemption of every payment in progress.
 * - Every state transition is ONE conditional UPDATE whose affected-row count
 *   is checked, so two concurrent requests can never both win a transition.
 * - The store keeps only the SHA-256 of a reservation token, in a column the
 *   record type omits; neither `reserve`'s known-key answer nor `get` returns it.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import type { StatementSync } from 'node:sqlite'
import {
  MAX_FORWARDS_PER_PAYMENT,
  type ConsumedPaymentRecord,
  type ConsumedPaymentState,
  type ConsumedPaymentStore,
} from '@haven_ai/merchant-payments'

// Loaded through `require`: the bundler rewrites a bare `node:sqlite` import to `sqlite`, which does not exist.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')

export class StoreLockedError extends Error {
  constructor() {
    super(
      'PAYMENTS_DB is locked by another process. Exactly one proxy may use a payments database at a time: ' +
        'stop the running proxy, then start this one.',
    )
    this.name = 'StoreLockedError'
  }
}

export interface SqliteConsumedPaymentStore extends ConsumedPaymentStore {
  /**
   * Clear a `settling` record's reservation-token hash, as one conditional
   * update (state still `settling`, `reservedAt` unchanged). A later request
   * calls it for a holder past `RESERVATION_DEADLINE_MS`. `false`: the update
   * changed no row, so the holder or another request got there first and the
   * caller must read the record again and act on what it finds.
   */
  clearReservation(key: string, reservedAt: string): Promise<boolean>
  /** True while the file can take a write; for the readiness route. */
  isWritable(): boolean
  close(): void
}

export interface SqliteStoreOptions {
  /** A `forwarding` record older than this (ms) is taken over: `UPSTREAM_TIMEOUT_MS` plus 30 s. */
  takeoverAfterMs: number
}

interface Row {
  key: string
  state: ConsumedPaymentState
  product_id: string
  chain: string
  payer: string
  amount: string
  valid_before: number
  reserved_at: string
  merchant_reference: string
  authorization_digest: string
  tx_hash: string | null
  settled_at: string | null
  forwarding_started_at: string | null
  forward_count: number
  delivered_at: string | null
  failed_at: string | null
  failure_reason: string | null
  upstream_status: number | null
  sale_reported: number
}

const RECORD_COLUMNS =
  'key, state, product_id, chain, payer, amount, valid_before, reserved_at, merchant_reference, ' +
  'authorization_digest, tx_hash, settled_at, forwarding_started_at, forward_count, delivered_at, ' +
  'failed_at, failure_reason, upstream_status, sale_reported'

function toRecord(row: Row): ConsumedPaymentRecord {
  return {
    key: row.key,
    state: row.state,
    productId: row.product_id,
    chain: row.chain,
    payer: row.payer,
    amount: row.amount,
    validBefore: Number(row.valid_before),
    reservedAt: row.reserved_at,
    merchantReference: row.merchant_reference,
    authorizationDigest: row.authorization_digest,
    ...(row.tx_hash !== null ? { txHash: row.tx_hash } : {}),
    ...(row.settled_at !== null ? { settledAt: row.settled_at } : {}),
    ...(row.forwarding_started_at !== null ? { forwardingStartedAt: row.forwarding_started_at } : {}),
    forwardCount: Number(row.forward_count),
    ...(row.delivered_at !== null ? { deliveredAt: row.delivered_at } : {}),
    ...(row.failed_at !== null ? { failedAt: row.failed_at } : {}),
    ...(row.failure_reason !== null ? { failureReason: row.failure_reason } : {}),
    ...(row.upstream_status !== null ? { upstreamStatus: Number(row.upstream_status) } : {}),
    saleReported: row.sale_reported === 1,
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function isBusy(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = (err as { errcode?: number }).errcode
  return code === 5 || code === 6 || /database is locked|SQLITE_BUSY/i.test(err.message)
}

export function openSqliteConsumedPaymentStore(path: string, options: SqliteStoreOptions): SqliteConsumedPaymentStore {
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA locking_mode=EXCLUSIVE')
    // The startup write: takes the exclusive lock now, or fails with SQLITE_BUSY.
    db.exec('BEGIN EXCLUSIVE')
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS payments (
          key TEXT PRIMARY KEY,
          state TEXT NOT NULL,
          product_id TEXT NOT NULL,
          chain TEXT NOT NULL,
          payer TEXT NOT NULL,
          amount TEXT NOT NULL,
          valid_before INTEGER NOT NULL,
          reserved_at TEXT NOT NULL,
          merchant_reference TEXT NOT NULL,
          authorization_digest TEXT NOT NULL,
          reservation_token_hash TEXT,
          tx_hash TEXT,
          settled_at TEXT,
          forwarding_started_at TEXT,
          forward_count INTEGER NOT NULL DEFAULT 0,
          delivered_at TEXT,
          failed_at TEXT,
          failure_reason TEXT,
          upstream_status INTEGER,
          sale_reported INTEGER NOT NULL DEFAULT 0
        )
      `)
      // Every token hash goes: no other process holds a token, so none is valid.
      db.exec('UPDATE payments SET reservation_token_hash = NULL WHERE reservation_token_hash IS NOT NULL')
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  } catch (err) {
    try {
      db.close()
    } catch {
      // already unusable
    }
    if (isBusy(err)) throw new StoreLockedError()
    throw err
  }

  const prepare = (sql: string): StatementSync => db.prepare(sql)
  const insert = prepare(`
    INSERT INTO payments (key, state, product_id, chain, payer, amount, valid_before, reserved_at,
      merchant_reference, authorization_digest, reservation_token_hash, forward_count, sale_reported)
    VALUES (?, 'settling', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
    ON CONFLICT(key) DO NOTHING
  `)
  const select = prepare(`SELECT ${RECORD_COLUMNS} FROM payments WHERE key = ?`)
  const settleWithToken = prepare(`
    UPDATE payments SET state = 'forwarding', forward_count = 1, forwarding_started_at = ?, tx_hash = ?,
      settled_at = ?, reservation_token_hash = NULL
    WHERE key = ? AND state = 'settling' AND reservation_token_hash = ?
  `)
  const settleWithoutToken = prepare(`
    UPDATE payments SET state = 'settled', tx_hash = ?, settled_at = ?, reservation_token_hash = NULL
    WHERE key = ? AND (state = 'settlement_unknown' OR (state = 'settling' AND reservation_token_hash IS NULL))
  `)
  const markUnknown = prepare(`
    UPDATE payments SET state = 'settlement_unknown', reservation_token_hash = NULL
    WHERE key = ? AND state = 'settling'
  `)
  const remove = prepare(`DELETE FROM payments WHERE key = ? AND state IN ('settling', 'settlement_unknown')`)
  const clearToken = prepare(`
    UPDATE payments SET reservation_token_hash = NULL
    WHERE key = ? AND state = 'settling' AND reserved_at = ? AND reservation_token_hash IS NOT NULL
  `)
  const forwardFresh = prepare(`
    UPDATE payments SET state = 'forwarding', forward_count = forward_count + 1, forwarding_started_at = ?
    WHERE key = ? AND state IN ('settled', 'failed') AND forward_count < ?
  `)
  const forwardTakeover = prepare(`
    UPDATE payments SET state = 'forwarding', forward_count = forward_count + 1, forwarding_started_at = ?,
      failed_at = ?, failure_reason = 'forwarding_abandoned'
    WHERE key = ? AND state = 'forwarding' AND forwarding_started_at < ? AND forward_count < ?
  `)
  const exhaust = prepare(`
    UPDATE payments SET state = 'exhausted'
    WHERE key = ? AND forward_count >= ?
      AND (state IN ('settled', 'failed') OR (state = 'forwarding' AND forwarding_started_at < ?))
  `)
  const delivered = prepare(`
    UPDATE payments SET state = 'delivered', upstream_status = ?, delivered_at = ?
    WHERE key = ? AND state = 'forwarding'
  `)
  const failed = prepare(`
    UPDATE payments SET state = 'failed', failure_reason = ?, failed_at = ?
    WHERE key = ? AND state = 'forwarding'
  `)
  const reported = prepare('UPDATE payments SET sale_reported = 1 WHERE key = ?')
  const probe = prepare('BEGIN IMMEDIATE')
  let closed = false

  function read(key: string): ConsumedPaymentRecord | null {
    const row = select.get(key) as unknown as Row | undefined
    return row ? toRecord(row) : null
  }

  return {
    async reserve(input) {
      const reservationToken = randomBytes(32).toString('hex')
      const result = insert.run(
        input.key,
        input.productId,
        input.chain,
        input.payer,
        input.amount,
        input.validBefore,
        input.now,
        input.merchantReference,
        input.authorizationDigest,
        hashToken(reservationToken),
      )
      if (Number(result.changes) === 1) return { reserved: true, reservationToken }
      const record = read(input.key)
      // The row vanished between the conflict and the read (released): the caller tries again.
      if (!record) throw new Error('consumed-payment store: key disappeared during reserve')
      return { reserved: false, record }
    },

    async markSettled(key, input) {
      if (input.reservationToken !== undefined) {
        const result = settleWithToken.run(
          input.settledAt,
          input.txHash,
          input.settledAt,
          key,
          hashToken(input.reservationToken),
        )
        return Number(result.changes) === 1 ? 'forward' : 'not_settleable'
      }
      const result = settleWithoutToken.run(input.txHash, input.settledAt, key)
      return Number(result.changes) === 1 ? 'settled' : 'not_settleable'
    },

    async markSettlementUnknown(key) {
      markUnknown.run(key)
    },

    async release(key) {
      remove.run(key)
    },

    async clearReservation(key, reservedAt) {
      return Number(clearToken.run(key, reservedAt).changes) === 1
    },

    async beginForwarding(key, now) {
      const staleBefore = new Date(Date.parse(now) - options.takeoverAfterMs).toISOString()
      if (Number(forwardFresh.run(now, key, MAX_FORWARDS_PER_PAYMENT).changes) === 1) return 'forward'
      if (Number(forwardTakeover.run(now, now, key, staleBefore, MAX_FORWARDS_PER_PAYMENT).changes) === 1) {
        return 'forward'
      }
      exhaust.run(key, MAX_FORWARDS_PER_PAYMENT, staleBefore)
      const record = read(key)
      if (record?.state === 'delivered') return 'delivered'
      if (record?.state === 'exhausted') return 'exhausted'
      // forwarding and young, or a record the core resolves (settling, settlement_unknown), or gone.
      return 'in_flight'
    },

    async markDelivered(key, input) {
      delivered.run(input.upstreamStatus, input.deliveredAt, key)
    },

    async markFailed(key, input) {
      failed.run(input.reason, input.failedAt, key)
    },

    async markSaleReported(key) {
      reported.run(key)
    },

    async get(key) {
      return read(key)
    },

    isWritable() {
      try {
        probe.run()
        db.exec('ROLLBACK')
        return true
      } catch {
        return false
      }
    },

    close() {
      if (closed) return
      closed = true
      db.close()
    },
  }
}
