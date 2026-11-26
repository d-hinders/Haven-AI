/**
 * Real-Postgres proof for migration 129 — business details gain a receipt
 * email and two structured addresses (#4870, epic #4868). No mocks — #1219's
 * rule.
 *
 * Pins:
 *   - the three columns exist at head, all nullable, with no default;
 *   - `down()` removes them and `up()` restores them;
 *   - a row saved BEFORE the migration is unchanged and valid after it: the
 *     original columns keep their values and the three new ones read `NULL`,
 *     which is exactly "the owner has not saved these yet";
 *   - the schema is at head after the cycle.
 *
 * The fields' BEHAVIOUR (validation, "omitted keeps / `null` clears", the
 * buyer block staying untouched) is proven against real Postgres in
 * `routes/__tests__/owner-company-details.test.ts` and the repository tests.
 */
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import {
  assertWorkerSchemaAtHead,
  describeDb,
  initDbHarness,
  resetDb,
  withMigrationReverted,
} from '../../../infra/__tests__/helpers/db-harness.js'
import { down, up, version } from '../129_owner_company_details_checkout_fields.js'

async function run(step: typeof up): Promise<void> {
  const client = await db.connect()
  try {
    await step(client)
  } finally {
    client.release()
  }
}

const newColumns = () =>
  db.query<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'owner_company_details'
        AND column_name IN ('receipt_email', 'billing_address', 'shipping_address')
      ORDER BY column_name`,
  )

async function seedUser(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`ocd-129-${Date.now()}-${Math.random().toString(36).slice(2)}@test.example`],
  )
  return rows[0].id
}

describeDb('migration 129 — owner company details checkout fields (#4870)', () => {
  beforeAll(async () => {
    await initDbHarness()
    // Re-apply THIS source over the worker schema, so every case below tests
    // the migration as written now — not a schema an earlier run left behind.
    await resetDb()
    try {
      await run(down)
    } finally {
      await run(up)
    }
  })

  beforeEach(async () => {
    await resetDb()
  })

  it('is registered as version 129_owner_company_details_checkout_fields', () => {
    expect(version).toBe('129_owner_company_details_checkout_fields')
  })

  it('the schema is at head with the three columns nullable and defaultless', async () => {
    await assertWorkerSchemaAtHead()
    expect((await newColumns()).rows).toEqual([
      { column_name: 'billing_address', data_type: 'jsonb', is_nullable: 'YES', column_default: null },
      { column_name: 'receipt_email', data_type: 'text', is_nullable: 'YES', column_default: null },
      { column_name: 'shipping_address', data_type: 'jsonb', is_nullable: 'YES', column_default: null },
    ])
  })

  it('down() removes the three columns; up() restores them', async () => {
    await withMigrationReverted(
      () => run(down),
      async () => {
        expect((await newColumns()).rows).toEqual([])
      },
      () => run(up),
    )
    expect((await newColumns()).rows).toHaveLength(3)
  })

  it('a row saved BEFORE the migration is unchanged and valid after it', async () => {
    const userId = await seedUser()
    await withMigrationReverted(
      () => run(down),
      async () => {
        // The pre-#4870 shape: only the original columns exist, so this is
        // exactly what an owner's row looked like before this change.
        await db.query(
          `INSERT INTO owner_company_details (user_id, legal_name, country, org_number, vat_number, vies_status, vies_checked_at)
           VALUES ($1, 'Acme AB', 'SE', '556677-8899', 'SE556677889901', 'valid', '2026-01-01T00:00:00.000Z')`,
          [userId],
        )
      },
      () => run(up),
    )

    const { rows } = await db.query<{
      legal_name: string
      country: string
      org_number: string
      vat_number: string | null
      vies_status: string | null
      receipt_email: string | null
      billing_address: unknown
      shipping_address: unknown
    }>(
      `SELECT legal_name, country, org_number, vat_number, vies_status,
              receipt_email, billing_address, shipping_address
         FROM owner_company_details WHERE user_id = $1`,
      [userId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      legal_name: 'Acme AB',
      country: 'SE',
      org_number: '556677-8899',
      vat_number: 'SE556677889901',
      vies_status: 'valid',
      receipt_email: null,
      billing_address: null,
      shipping_address: null,
    })
  })
})
