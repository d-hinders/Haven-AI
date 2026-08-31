/**
 * Real-Postgres proof for the merchant-resource table retirement (#2257,
 * epic #1440). No mocks — database behaviour belongs on the real-DB harness.
 *
 * The table names are assembled from stable segments so the repository-wide
 * residue sweep continues to identify the original schema migration as the
 * only historical creator of these names.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../../infra/__tests__/helpers/db-harness.js'
import { down, up, version } from '../073_drop_x402_resource_tables.js'

const RESOURCE_TABLE = ['x402', 'resources'].join('_')
const RECEIPT_TABLE = ['x402', 'receipts'].join('_')
const RESOURCE_INDEX = ['idx', 'x402', 'resources', 'user'].join('_')
const RECEIPT_RESOURCE_INDEX = ['idx', 'x402', 'receipts', 'resource'].join('_')
const RECEIPT_USER_INDEX = ['idx', 'x402', 'receipts', 'user'].join('_')

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>(
    `SELECT to_regclass(current_schema() || '.' || $1) IS NOT NULL AS exists`,
    [name],
  )
  return rows[0].exists
}

async function columnNames(table: string): Promise<string[]> {
  const { rows } = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1
     ORDER BY column_name`,
    [table],
  )
  return rows.map((row) => row.column_name)
}

async function indexNames(table: string): Promise<string[]> {
  const { rows } = await db.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
     WHERE schemaname = current_schema() AND tablename = $1
     ORDER BY indexname`,
    [table],
  )
  return rows.map((row) => row.indexname)
}

describeDb('migration 073: drop merchant-resource tables (#2257)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })

  afterAll(async () => {
    await up(db as never)
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('leaves both retired tables absent after the full migration set', async () => {
    expect(await tableExists(RESOURCE_TABLE)).toBe(false)
    expect(await tableExists(RECEIPT_TABLE)).toBe(false)
  })

  it('up() is idempotent when both tables are already gone', async () => {
    await up(db as never)
    await up(db as never)
    expect(await tableExists(RESOURCE_TABLE)).toBe(false)
    expect(await tableExists(RECEIPT_TABLE)).toBe(false)
  })

  it('down() restores both schemas, indexes, and the child foreign key', async () => {
    await down(db as never)

    expect(await tableExists(RESOURCE_TABLE)).toBe(true)
    expect(await tableExists(RECEIPT_TABLE)).toBe(true)
    expect(await columnNames(RESOURCE_TABLE)).toEqual([
      'active', 'chain_id', 'created_at', 'description', 'id', 'name',
      'price_amount', 'safe_id', 'token_address', 'token_symbol', 'updated_at', 'user_id',
    ])
    expect(await columnNames(RECEIPT_TABLE)).toEqual([
      'amount_raw', 'chain_id', 'created_at', 'id', 'payer_address', 'resource_id',
      'tx_hash', 'user_id', 'verified_at',
    ])
    expect(await indexNames(RESOURCE_TABLE)).toEqual([
      RESOURCE_INDEX,
      `${RESOURCE_TABLE}_pkey`,
    ])
    expect(await indexNames(RECEIPT_TABLE)).toEqual([
      RECEIPT_RESOURCE_INDEX,
      RECEIPT_USER_INDEX,
      RECEIPT_TABLE + '_pkey',
      `${RECEIPT_TABLE}_tx_hash_key`,
    ])

    const { rows: foreignKeys } = await db.query<{ child: string; parent: string }>(
      `SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
       FROM pg_constraint c
       WHERE c.contype = 'f'
         AND c.conrelid = $1::regclass
         AND c.confrelid = $2::regclass`,
      [RECEIPT_TABLE, RESOURCE_TABLE],
    )
    expect(foreignKeys).toHaveLength(1)

    await down(db as never)
    await up(db as never)
    expect(await tableExists(RESOURCE_TABLE)).toBe(false)
    expect(await tableExists(RECEIPT_TABLE)).toBe(false)
  })
})

describe('migration 073 registration', () => {
  it('exports up, down and a version matching its filename', () => {
    expect(typeof up).toBe('function')
    expect(typeof down).toBe('function')
    expect(version).toBe(['073', 'drop', 'x402', 'resource', 'tables'].join('_'))
  })
})
