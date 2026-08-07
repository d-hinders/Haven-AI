/**
 * Data access for the contacts aggregate (#999, epic #980).
 *
 * One aggregate: `contacts` — the user's address book. Extracted verbatim
 * from `routes/contacts.ts` so `scripts/db-schema-smoke.ts` can PREPARE every
 * statement. Convention: `README.md` in this directory.
 *
 * The insert throws pg unique-violation errors through to the route, which
 * owns mapping `UNIQUE(user_id, address)` conflicts to a 409.
 */

import pool from '../../db.js'
import type { Executor } from '../transaction.js'

export type { Executor }

export interface ContactRow {
  id: string
  name: string
  address: string
  created_at: string
  updated_at: string
}

export const LIST_CONTACTS_FOR_USER_SQL = `SELECT id, name, address, created_at, updated_at
       FROM contacts WHERE user_id = $1 ORDER BY name ASC`

export const INSERT_CONTACT_SQL = `INSERT INTO contacts (user_id, name, address)
         VALUES ($1, $2, $3)
         RETURNING id, name, address, created_at, updated_at`

export const RENAME_CONTACT_FOR_USER_SQL = `UPDATE contacts SET name = $3, updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING id, name, address, created_at, updated_at`

export const DELETE_CONTACT_FOR_USER_SQL =
  'DELETE FROM contacts WHERE id = $1 AND user_id = $2 RETURNING id'

/** `userId` is REQUIRED — the address book is per-tenant. */
export async function listContactsForUser(
  userId: string,
  db: Executor = pool,
): Promise<ContactRow[]> {
  const result = await db.query<ContactRow>(LIST_CONTACTS_FOR_USER_SQL, [userId])
  return result.rows
}

/** Throws pg 23505 through — the route maps the duplicate-address conflict. */
export async function insertContact(
  userId: string,
  name: string,
  address: string,
  db: Executor = pool,
): Promise<ContactRow> {
  const result = await db.query<ContactRow>(INSERT_CONTACT_SQL, [userId, name, address])
  return result.rows[0]
}

/** `userId` is REQUIRED — the UPDATE is tenant-scoped in its WHERE clause. */
export async function renameContactForUser(
  contactId: string,
  userId: string,
  name: string,
  db: Executor = pool,
): Promise<ContactRow | null> {
  const result = await db.query<ContactRow>(RENAME_CONTACT_FOR_USER_SQL, [contactId, userId, name])
  return result.rows[0] ?? null
}

/** `userId` is REQUIRED — the DELETE is tenant-scoped in its WHERE clause. */
export async function deleteContactForUser(
  contactId: string,
  userId: string,
  db: Executor = pool,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(DELETE_CONTACT_FOR_USER_SQL, [contactId, userId])
  return result.rows.length > 0
}
