/**
 * Real-Postgres proof for migration 113 — the sync ledger's document kind
 * (#3918). No mocks — #1219's rule.
 *
 * Pins the acceptance criterion directly: a pre-existing row reads as the
 * underlag kind, TWO documents of one payment (underlag + merchant invoice)
 * now fit the ledger, a duplicate of the SAME kind still collides, and
 * up/down round-trips restore the exact 033 shape.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../../db.js'
import {
  assertWorkerSchemaAtHead,
  describeDb,
  initDbHarness,
  resetDb,
} from '../../../infra/__tests__/helpers/db-harness.js'
import { down, up, version } from '../113_sync_document_kind.js'

async function runUp(): Promise<void> {
  const client = await db.connect()
  try {
    await up(client)
  } finally {
    client.release()
  }
}

async function runDown(): Promise<void> {
  const client = await db.connect()
  try {
    await down(client)
  } finally {
    client.release()
  }
}

let seq = 0
async function seedUser(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`sync-kind-mig-${++seq}-${Date.now()}@test.example`],
  )
  return rows[0].id
}

async function insertSyncRow(userId: string, documentKind: string | null): Promise<'ok' | 'conflict'> {
  const kindColumn = documentKind ? ', document_kind' : ''
  const kindPlaceholder = documentKind ? ', $2' : ''
  try {
    await db.query(
      `INSERT INTO accounting_feed_syncs (user_id, provider, payment_id, status, attempts, external_ref${kindColumn})
       VALUES ($1, 'accounted', 'pay-mig', 'pushed', 1, 'accounted:document:d1'${kindPlaceholder})`,
      documentKind ? [userId, documentKind] : [userId],
    )
    return 'ok'
  } catch {
    return 'conflict'
  }
}

describeDb('migration 113_sync_document_kind', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
  })
  afterAll(async () => {
    await assertWorkerSchemaAtHead()
  })

  it('names itself', () => {
    expect(version).toBe('113_sync_document_kind')
  })

  it('two documents of one payment fit the ledger; a duplicate kind still collides; existing rows read as the underlag', async () => {
    const userId = await seedUser()
    await runUp()

    // The underlag row, written the way every pre-113 writer did — the kind
    // defaults, so existing inserts keep working verbatim.
    expect(await insertSyncRow(userId, null)).toBe('ok')
    // The merchant invoice: the SAME (provider, payment_id, user_id), a
    // different kind — exactly the second row #3918 needs.
    expect(await insertSyncRow(userId, 'merchant_invoice')).toBe('ok')
    // A duplicate of the SAME kind is still the double-post the ledger exists
    // to refuse.
    expect(await insertSyncRow(userId, 'merchant_invoice')).toBe('conflict')

    const kinds = await db.query<{ document_kind: string; external_ref: string }>(
      `SELECT document_kind, external_ref FROM accounting_feed_syncs WHERE user_id = $1 ORDER BY document_kind`,
      [userId],
    )
    expect(kinds.rows).toEqual([
      { document_kind: 'merchant_invoice', external_ref: 'accounted:document:d1' },
      { document_kind: 'underlag', external_ref: 'accounted:document:d1' },
    ])
  })

  it('down restores the exact 033 shape: the kind column is gone and a second row collides again', async () => {
    const userId = await seedUser()
    await runUp()
    try {
      await insertSyncRow(userId, null)
      await runDown()

      const columns = await db.query<{ n: number }>(
        // Anchored on the worker schema's own relation (search_path), not a
        // name search across every schema in the database.
        `SELECT count(*)::int AS n FROM pg_attribute a
         WHERE a.attrelid = 'accounting_feed_syncs'::regclass AND a.attname = 'document_kind' AND NOT a.attisdropped`,
      )
      expect(columns.rows[0].n).toBe(0)
      expect(await insertSyncRow(userId, null)).toBe('conflict')
    } finally {
      // Head shape again — assertWorkerSchemaAtHead fingerprints the schema.
      await runUp()
    }
  })
})
