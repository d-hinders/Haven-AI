/**
 * Real-Postgres proof for migration 098 — owner company details (#3332). No
 * mocks — #1219's rule.
 *
 * Pins: the table exists keyed on `user_id`, `down()` drops exactly what
 * `up()` created, `up()` is idempotent, every CHECK constraint actually
 * rejects a bad row, and deleting the owning user cascades — deleting the
 * account deletes the details with it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../../db.js'
import {
  assertWorkerSchemaAtHead,
  describeDb,
  initDbHarness,
  resetDb,
  withMigrationReverted,
} from '../../../infra/__tests__/helpers/db-harness.js'
import { down, up, version } from '../098_owner_company_details.js'

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
  seq += 1
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`ocd-mig-${seq}-${Date.now()}@test.example`],
  )
  return rows[0].id
}

async function insertDetails(
  userId: string,
  overrides: Partial<{
    legal_name: string
    country: string
    org_number: string
    vat_number: string | null
    vies_status: string | null
  }> = {},
): Promise<void> {
  const row = {
    legal_name: 'Acme AB',
    country: 'SE',
    org_number: '556677-8899',
    vat_number: null,
    vies_status: null,
    ...overrides,
  }
  await db.query(
    `INSERT INTO owner_company_details (user_id, legal_name, country, org_number, vat_number, vies_status)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, row.legal_name, row.country, row.org_number, row.vat_number, row.vies_status],
  )
}

describeDb('migration 098_owner_company_details', () => {
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
    expect(version).toBe('098_owner_company_details')
  })

  it('creates the table; down() drops it', async () => {
    await runUp()
    const present = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_tables
       WHERE schemaname = current_schema() AND tablename = 'owner_company_details'`,
    )
    expect(present.rows[0].count).toBe('1')
    await withMigrationReverted(
      () => runDown(),
      async () => {
        const gone = await db.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM pg_tables
           WHERE schemaname = current_schema() AND tablename = 'owner_company_details'`,
        )
        expect(gone.rows[0].count).toBe('0')
      },
      () => runUp(),
    )
  })

  it('is idempotent (IF NOT EXISTS re-run)', async () => {
    await runUp()
    await runUp()
  })

  it('inserts and reads a full row, keyed on user_id (PK)', async () => {
    await runUp()
    const userId = await seedUser()
    await insertDetails(userId, { vat_number: 'SE556677889901', vies_status: 'valid' })
    const { rows } = await db.query(`SELECT * FROM owner_company_details WHERE user_id = $1`, [userId])
    expect(rows).toHaveLength(1)
    expect(rows[0].vat_number).toBe('SE556677889901')
    expect(rows[0].vies_status).toBe('valid')
    // A second row for the same user is refused by the PK.
    await expect(insertDetails(userId)).rejects.toMatchObject({ code: '23505' })
  })

  it('rejects a lowercase or malformed country code', async () => {
    await runUp()
    const userId = await seedUser()
    await expect(insertDetails(userId, { country: 'se' })).rejects.toMatchObject({ code: '23514' })
    await expect(insertDetails(userId, { country: 'SWE' })).rejects.toMatchObject({ code: '23514' })
  })

  it('rejects a blank legal name', async () => {
    await runUp()
    const userId = await seedUser()
    await expect(insertDetails(userId, { legal_name: '   ' })).rejects.toMatchObject({ code: '23514' })
  })

  it('rejects a VAT number that is not normalised (lowercase or spaces)', async () => {
    await runUp()
    const userId = await seedUser()
    await expect(insertDetails(userId, { vat_number: 'se556677889901' })).rejects.toMatchObject({
      code: '23514',
    })
    await expect(insertDetails(userId, { vat_number: 'SE 556677889901' })).rejects.toMatchObject({
      code: '23514',
    })
  })

  it('rejects an unknown vies_status', async () => {
    await runUp()
    const userId = await seedUser()
    await expect(insertDetails(userId, { vies_status: 'verified' })).rejects.toMatchObject({
      code: '23514',
    })
  })

  it('accepts every documented vies_status, and NULL', async () => {
    await runUp()
    for (const status of ['pending', 'valid', 'invalid', 'not_verifiable', null]) {
      const userId = await seedUser()
      await expect(insertDetails(userId, { vies_status: status })).resolves.toBeUndefined()
    }
  })

  it('deleting the owning user cascades: the details row is deleted with the account', async () => {
    await runUp()
    const userId = await seedUser()
    await insertDetails(userId)
    await db.query(`DELETE FROM users WHERE id = $1`, [userId])
    const rows = await db.query(`SELECT 1 FROM owner_company_details WHERE user_id = $1`, [userId])
    expect(rows.rows).toHaveLength(0)
  })
})
