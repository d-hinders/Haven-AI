/**
 * Real-DB proofs for the "Since your last visit" marker (#4709, epic #4701
 * decision 4). Zero mocks — the ACs are claims about what POSTGRES does under
 * a row lock, so they belong on the #1220 harness.
 *
 * The window a line describes is `(previous, current]`. The cases below pin
 * the four properties the issue names:
 *
 *   - a retry with the same `entry_id` returns the same window and does NOT
 *     move the marker;
 *   - two near-simultaneous entries (phone and laptop) get consecutive windows
 *     that do not overlap;
 *   - `current` never goes backwards;
 *   - the marker is tenant-scoped (another user's row is untouched).
 *
 * The boundary rule itself (a payment exactly on a boundary counted once
 * across two consecutive windows) is proven against the figures statement in
 * `dashboard-since.db.test.ts`.
 */
import { randomUUID } from 'node:crypto'
import { beforeAll, beforeEach, expect, it } from 'vitest'
import db from '../../../db.js'
import { describeDb, initDbHarness, resetDb } from '../../__tests__/helpers/db-harness.js'
import { openUserVisit } from '../users.js'

let seq = 0

async function seedUser(): Promise<string> {
  const n = ++seq
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
    [`visit-4709-${n}-${Date.now()}@test.example`],
  )
  return rows[0].id
}

async function marker(userId: string): Promise<{
  visit_current_at: Date | null
  visit_previous_at: Date | null
  visit_entry_id: string | null
}> {
  const { rows } = await db.query<{
    visit_current_at: Date | null
    visit_previous_at: Date | null
    visit_entry_id: string | null
  }>(
    `SELECT visit_current_at, visit_previous_at, visit_entry_id FROM users WHERE id = $1`,
    [userId],
  )
  return rows[0]
}

describeDb('openUserVisit — the visit marker (#4709)', () => {
  beforeAll(async () => {
    await initDbHarness()
  })
  beforeEach(async () => {
    await resetDb()
    seq = 0
  })

  it('a first ever visit writes the marker and returns a null previous', async () => {
    const userId = await seedUser()
    const entryId = randomUUID()

    const visit = await openUserVisit(entryId, userId)

    expect(visit).not.toBeNull()
    expect(visit!.previous).toBeNull()
    expect(visit!.current).toBeInstanceOf(Date)
    const stored = await marker(userId)
    expect(stored.visit_entry_id).toBe(entryId)
    expect(stored.visit_current_at).toEqual(visit!.current)
    expect(stored.visit_previous_at).toBeNull()
  })

  it('a retry with the same entry_id returns the same window and does not move the marker', async () => {
    const userId = await seedUser()
    const entryId = randomUUID()

    const first = await openUserVisit(entryId, userId)
    const before = await marker(userId)
    const retry = await openUserVisit(entryId, userId)
    const after = await marker(userId)

    expect(retry!.previous).toEqual(first!.previous)
    expect(retry!.current).toEqual(first!.current)
    expect(after).toEqual(before)
  })

  it('a different entry_id opens a new entry whose previous is the last current', async () => {
    const userId = await seedUser()
    const first = await openUserVisit(randomUUID(), userId)
    const second = await openUserVisit(randomUUID(), userId)

    expect(second!.previous).toEqual(first!.current)
    expect(second!.current.getTime()).toBeGreaterThanOrEqual(first!.current.getTime())
    const stored = await marker(userId)
    expect(stored.visit_previous_at).toEqual(first!.current)
    expect(stored.visit_current_at).toEqual(second!.current)
  })

  it('two near-simultaneous entries get consecutive windows that do not overlap', async () => {
    const userId = await seedUser()
    const phoneEntry = randomUUID()
    const laptopEntry = randomUUID()

    // Two separate connections, so the statements really are concurrent: the
    // second blocks on the row lock the first holds and re-reads the committed
    // row (READ COMMITTED), which is what makes the windows consecutive.
    const phone = await db.connect()
    const laptop = await db.connect()
    try {
      const [phoneVisit, laptopVisit] = await Promise.all([
        openUserVisit(phoneEntry, userId, phone),
        openUserVisit(laptopEntry, userId, laptop),
      ])

      const [earlier, later] =
        phoneVisit!.current.getTime() <= laptopVisit!.current.getTime()
          ? [phoneVisit!, laptopVisit!]
          : [laptopVisit!, phoneVisit!]

      // The later entry's previous is the earlier entry's current: the windows
      // `(previous, current]` are consecutive and share only the boundary.
      expect(later.previous).toEqual(earlier.current)
      expect(later.current.getTime()).toBeGreaterThanOrEqual(earlier.current.getTime())
      // Neither window overlaps the other: the earlier one ends where the
      // later one begins.
      expect(earlier.previous === null || earlier.previous.getTime() < earlier.current.getTime()).toBe(true)
    } finally {
      phone.release()
      laptop.release()
    }

    const stored = await marker(userId)
    expect(stored.visit_entry_id).not.toBeNull()
    expect(stored.visit_current_at).not.toBeNull()
  })

  it('current never goes backwards — a future marker is kept, not rewound', async () => {
    const userId = await seedUser()
    const future = new Date(Date.now() + 60 * 60 * 1000)
    await db.query(
      `UPDATE users SET visit_current_at = $2, visit_previous_at = NULL, visit_entry_id = $3 WHERE id = $1`,
      [userId, future, randomUUID()],
    )

    const visit = await openUserVisit(randomUUID(), userId)

    expect(visit!.current).toEqual(future)
    expect(visit!.previous).toEqual(future)
    const stored = await marker(userId)
    expect(stored.visit_current_at).toEqual(future)
  })

  it('is tenant-scoped — another user’s marker is untouched', async () => {
    const mine = await seedUser()
    const theirs = await seedUser()
    const theirEntry = randomUUID()
    await openUserVisit(theirEntry, theirs)
    const theirBefore = await marker(theirs)

    await openUserVisit(randomUUID(), mine)

    expect(await marker(theirs)).toEqual(theirBefore)
    expect((await marker(mine)).visit_entry_id).not.toBeNull()
  })

  it('returns null for a user row that does not exist', async () => {
    expect(await openUserVisit(randomUUID(), randomUUID())).toBeNull()
  })
})
