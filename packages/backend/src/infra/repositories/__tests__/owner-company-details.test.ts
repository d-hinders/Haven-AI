/**
 * Real-Postgres repository tests for owner company details (#3332). No mocks
 * — #1219's rule: what the database does (upsert semantics, the pending
 * transition, the join helper's null handling) is proven here, not mocked.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import db from '../../../db.js'
import { assertWorkerSchemaAtHead, describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import {
  buyerPartyFromJoin,
  type BuyerJoinColumns,
  claimStalePendingForUser,
  deleteOwnerCompanyDetails,
  getOwnerCompanyDetails,
  markViesPending,
  setViesResult,
  upsertOwnerCompanyDetails,
} from '../owner-company-details.js'

let seq = 0

async function seedUser(): Promise<string> {
  seq += 1
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`ocd-repo-${seq}-${Date.now()}@test.example`],
  )
  return rows[0].id
}

describeDb('owner-company-details repository (#3332)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
  })
  afterAll(async () => {
    await assertWorkerSchemaAtHead()
  })

  it('getOwnerCompanyDetails: null when nothing is saved', async () => {
    const userId = await seedUser()
    expect(await getOwnerCompanyDetails(userId)).toBeNull()
  })

  it('upsertOwnerCompanyDetails: inserts, then REPLACES on a second call (not a partial patch)', async () => {
    const userId = await seedUser()
    const first = await upsertOwnerCompanyDetails(userId, {
      legal_name: 'Acme AB',
      country: 'SE',
      org_number: '556677-8899',
      vat_number: null,
      vies_status: null,
      vies_checked_at: null,
    })
    expect(first).toMatchObject({ legal_name: 'Acme AB', vat_number: null, vies_status: null })

    const second = await upsertOwnerCompanyDetails(userId, {
      legal_name: 'Acme AB',
      country: 'SE',
      org_number: '556677-8899',
      vat_number: 'SE556677889901',
      vies_status: 'pending',
      vies_checked_at: null,
    })
    expect(second.vat_number).toBe('SE556677889901')
    expect(second.vies_status).toBe('pending')
    expect(second.updated_at).not.toBe(first.updated_at)

    const rows = await db.query(`SELECT count(*)::int AS n FROM owner_company_details WHERE user_id = $1`, [userId])
    expect(rows.rows[0].n).toBe(1)
  })

  it('deleteOwnerCompanyDetails: true when a row existed, false when it did not', async () => {
    const userId = await seedUser()
    expect(await deleteOwnerCompanyDetails(userId)).toBe(false)
    await upsertOwnerCompanyDetails(userId, {
      legal_name: 'Acme AB',
      country: 'SE',
      org_number: '556677-8899',
      vat_number: null,
      vies_status: null,
      vies_checked_at: null,
    })
    expect(await deleteOwnerCompanyDetails(userId)).toBe(true)
    expect(await getOwnerCompanyDetails(userId)).toBeNull()
  })

  it('setViesResult: records the outcome, null when the row is gone', async () => {
    const userId = await seedUser()
    await upsertOwnerCompanyDetails(userId, {
      legal_name: 'Acme AB',
      country: 'SE',
      org_number: '556677-8899',
      vat_number: 'SE556677889901',
      vies_status: 'pending',
      vies_checked_at: null,
    })
    const checkedAt = new Date().toISOString()
    const updated = await setViesResult(userId, 'valid', checkedAt, 'SE556677889901')
    expect(updated).toMatchObject({ vies_status: 'valid' })

    await deleteOwnerCompanyDetails(userId)
    expect(await setViesResult(userId, 'valid', checkedAt, 'SE556677889901')).toBeNull()
  })

  it('setViesResult: the guard (#3332 review M1) — a changed VAT number or a resolved (non-pending) row refuses the write', async () => {
    const userId = await seedUser()
    await upsertOwnerCompanyDetails(userId, {
      legal_name: 'Acme AB',
      country: 'SE',
      org_number: '556677-8899',
      vat_number: 'SE556677889901',
      vies_status: 'pending',
      vies_checked_at: null,
    })
    // A result computed for a DIFFERENT VAT number than the row now holds
    // (the owner changed it mid-flight) must not land.
    expect(await setViesResult(userId, 'valid', new Date().toISOString(), 'DE811569869')).toBeNull()
    const untouched = await getOwnerCompanyDetails(userId)
    expect(untouched).toMatchObject({ vat_number: 'SE556677889901', vies_status: 'pending' })

    // A result for the RIGHT number lands while pending…
    const first = await setViesResult(userId, 'valid', new Date().toISOString(), 'SE556677889901')
    expect(first).toMatchObject({ vies_status: 'valid' })

    // …and a SECOND, late result for the same number — the row is no longer
    // `pending` — must not overwrite the resolved status either.
    expect(await setViesResult(userId, 'invalid', new Date().toISOString(), 'SE556677889901')).toBeNull()
    expect(await getOwnerCompanyDetails(userId)).toMatchObject({ vies_status: 'valid' })
  })

  it('setViesResult: a VAT number CLEARED mid-flight refuses the write (reproduces the #3332 review finding)', async () => {
    const userId = await seedUser()
    await upsertOwnerCompanyDetails(userId, {
      legal_name: 'Acme AB',
      country: 'SE',
      org_number: '556677-8899',
      vat_number: 'SE556677889901',
      vies_status: 'pending',
      vies_checked_at: null,
    })
    // The owner clears the VAT number while the check for it is in flight —
    // exactly `writeCompanyDetails`'s clearing path (`vat_number: null`,
    // `vies_status: null`).
    await upsertOwnerCompanyDetails(userId, {
      legal_name: 'Acme AB',
      country: 'SE',
      org_number: '556677-8899',
      vat_number: null,
      vies_status: null,
      vies_checked_at: null,
    })
    // `vat_number = $4` is never true against a NULL column (SQL three-valued
    // logic) — the stale check's result must not resurrect it.
    expect(await setViesResult(userId, 'valid', new Date().toISOString(), 'SE556677889901')).toBeNull()
    expect(await getOwnerCompanyDetails(userId)).toMatchObject({ vat_number: null, vies_status: null })
  })

  it('markViesPending: null with no row, null with no VAT number, otherwise flips to pending', async () => {
    const userId = await seedUser()
    expect(await markViesPending(userId)).toBeNull()

    await upsertOwnerCompanyDetails(userId, {
      legal_name: 'Acme AB',
      country: 'SE',
      org_number: '556677-8899',
      vat_number: null,
      vies_status: null,
      vies_checked_at: null,
    })
    expect(await markViesPending(userId)).toBeNull()

    await upsertOwnerCompanyDetails(userId, {
      legal_name: 'Acme AB',
      country: 'SE',
      org_number: '556677-8899',
      vat_number: 'SE556677889901',
      vies_status: 'valid',
      vies_checked_at: new Date().toISOString(),
    })
    const pending = await markViesPending(userId)
    expect(pending?.vies_status).toBe('pending')
  })

  it('markViesPending: clears vies_checked_at (#3332 review N1) — a pending row never carries a stale completion time', async () => {
    const userId = await seedUser()
    await upsertOwnerCompanyDetails(userId, {
      legal_name: 'Acme AB',
      country: 'SE',
      org_number: '556677-8899',
      vat_number: 'SE556677889901',
      vies_status: 'valid',
      vies_checked_at: new Date().toISOString(),
    })
    const pending = await markViesPending(userId)
    expect(pending).toMatchObject({ vies_status: 'pending', vies_checked_at: null })
    // Not just the returned row — the write itself, read back independently.
    expect(await getOwnerCompanyDetails(userId)).toMatchObject({ vies_status: 'pending', vies_checked_at: null })
  })

  describe('claimStalePendingForUser (#3332 review M3)', () => {
    it('claims a stale pending row and bumps updated_at', async () => {
      const userId = await seedUser()
      await upsertOwnerCompanyDetails(userId, {
        legal_name: 'Acme AB',
        country: 'SE',
        org_number: '556677-8899',
        vat_number: 'SE556677889901',
        vies_status: 'pending',
        vies_checked_at: null,
      })
      expect(await claimStalePendingForUser(userId, 5)).toBeNull()
      await db.query(`UPDATE owner_company_details SET updated_at = NOW() - INTERVAL '10 minutes' WHERE user_id = $1`, [
        userId,
      ])
      const claimed = await claimStalePendingForUser(userId, 5)
      expect(claimed?.vies_status).toBe('pending')
      // Immediately re-claiming must find nothing — the claim itself made the
      // row fresh.
      expect(await claimStalePendingForUser(userId, 5)).toBeNull()
    })

    it('two concurrent claims on the same stale row: exactly one wins', async () => {
      const userId = await seedUser()
      await upsertOwnerCompanyDetails(userId, {
        legal_name: 'Acme AB',
        country: 'SE',
        org_number: '556677-8899',
        vat_number: 'SE556677889901',
        vies_status: 'pending',
        vies_checked_at: null,
      })
      await db.query(`UPDATE owner_company_details SET updated_at = NOW() - INTERVAL '10 minutes' WHERE user_id = $1`, [
        userId,
      ])
      const results = await Promise.all([
        claimStalePendingForUser(userId, 5),
        claimStalePendingForUser(userId, 5),
      ])
      const wins = results.filter((r) => r !== null)
      expect(wins).toHaveLength(1)
    })
  })

  describe('buyerPartyFromJoin (pure, but exercised against the join columns\' real shape)', () => {
    it('undefined when disabled, even with a full row', async () => {
      const userId = await seedUser()
      await upsertOwnerCompanyDetails(userId, {
        legal_name: 'Acme AB',
        country: 'SE',
        org_number: '556677-8899',
        vat_number: 'SE556677889901',
        vies_status: 'valid',
        vies_checked_at: new Date().toISOString(),
      })
      const row = await db.query<BuyerJoinColumns>(
        `SELECT ocd.legal_name AS buyer_legal_name, ocd.country AS buyer_country,
                ocd.org_number AS buyer_org_number, ocd.vat_number AS buyer_vat_number,
                ocd.vies_status AS buyer_vies_status, ocd.vies_checked_at AS buyer_vies_checked_at
         FROM owner_company_details ocd WHERE ocd.user_id = $1`,
        [userId],
      )
      expect(buyerPartyFromJoin(row.rows[0], false)).toBeUndefined()
    })

    it('undefined when enabled but the LEFT JOIN found no row (all columns null)', () => {
      expect(
        buyerPartyFromJoin(
          {
            buyer_legal_name: null,
            buyer_country: null,
            buyer_org_number: null,
            buyer_vat_number: null,
            buyer_vies_status: null,
            buyer_vies_checked_at: null,
          },
          true,
        ),
      ).toBeUndefined()
    })

    it('present, and shaped as PartiesBuyer, when enabled with a matched row', async () => {
      const userId = await seedUser()
      await upsertOwnerCompanyDetails(userId, {
        legal_name: 'Acme AB',
        country: 'SE',
        org_number: '556677-8899',
        vat_number: 'SE556677889901',
        vies_status: 'valid',
        vies_checked_at: new Date().toISOString(),
      })
      const row = await db.query<BuyerJoinColumns>(
        `SELECT ocd.legal_name AS buyer_legal_name, ocd.country AS buyer_country,
                ocd.org_number AS buyer_org_number, ocd.vat_number AS buyer_vat_number,
                ocd.vies_status AS buyer_vies_status, ocd.vies_checked_at AS buyer_vies_checked_at
         FROM owner_company_details ocd WHERE ocd.user_id = $1`,
        [userId],
      )
      const buyer = buyerPartyFromJoin(row.rows[0], true)
      expect(buyer).toMatchObject({ legal_name: 'Acme AB', country: 'SE', vat_number: 'SE556677889901', vies_status: 'valid' })
    })
  })
})
