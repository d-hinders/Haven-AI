import { createHash, randomInt } from 'node:crypto'
import pool from '../../db.js'
import type { Executor } from '../transaction.js'

/**
 * Device-authorization grants (#2526).
 *
 * The data layer for the CLI's browser-approved login. Every rule that matters
 * lives here rather than in the route, because the route is one caller and the
 * database is the thing that has to stay true.
 */

export type DeviceAuthorizationStatus = 'pending' | 'approved' | 'denied' | 'redeemed'

export interface DeviceAuthorizationRow {
  id: string
  user_id: string | null
  status: DeviceAuthorizationStatus
  client_label: string | null
  created_at: string
  expires_at: string
  approved_at: string | null
}

/**
 * How long a pending grant lives. Ten minutes is the RFC 8628 default and is
 * long enough for a human to switch to a browser, log in if needed, and
 * approve — and short enough that an abandoned code is not a standing offer.
 */
export const DEVICE_CODE_TTL_MS = 10 * 60 * 1000

/**
 * The user-code alphabet, chosen for a human reading a terminal and typing
 * into a browser: no `0`/`O`, no `1`/`I`/`L`, no `U` (misread as `V` in some
 * terminal fonts). 8 characters over 28 symbols is ~38 bits — far more than a
 * 10-minute window and a rate-limited approve endpoint can be walked through.
 */
const USER_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'
const USER_CODE_LENGTH = 8

/** SHA-256, the same at-rest treatment setup tokens and API keys already get. */
export function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

/**
 * A user code, formatted `XXXX-XXXX`.
 *
 * `randomInt` rather than `Math.random`: this is a credential a human types,
 * and a predictable one is a credential an attacker can guess into somebody
 * else's pending approval.
 */
export function generateUserCode(): string {
  let out = ''
  for (let i = 0; i < USER_CODE_LENGTH; i++) {
    out += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`
}

/** Normalise what a human typed: case and the cosmetic dash do not matter. */
export function normalizeUserCode(input: string): string {
  return input.trim().toUpperCase().replace(/[^0-9A-Z]/g, '')
}

export const INSERT_DEVICE_AUTHORIZATION_SQL = `
  INSERT INTO device_authorizations (user_code_hash, device_code_hash, client_label, expires_at)
  VALUES ($1, $2, $3, $4)
  RETURNING id, user_id, status, client_label, created_at, expires_at, approved_at`

export async function createDeviceAuthorization(
  input: { userCode: string; deviceCode: string; clientLabel: string | null; expiresAt: Date },
  db: Executor = pool,
): Promise<DeviceAuthorizationRow> {
  const result = await db.query<DeviceAuthorizationRow>(INSERT_DEVICE_AUTHORIZATION_SQL, [
    hashCode(normalizeUserCode(input.userCode)),
    hashCode(input.deviceCode),
    input.clientLabel,
    input.expiresAt.toISOString(),
  ])
  return result.rows[0]
}

/**
 * Approve a PENDING, UNEXPIRED grant by user code, binding it to the caller.
 *
 * The guards are in the WHERE clause on purpose. A read-then-write would race
 * two approvals of the same code, and "check the status first" is exactly the
 * shape that loses to a second request arriving between the read and the
 * write. Returns null when nothing matched — which is also what a wrong code,
 * an expired code and an already-approved code all look like from outside.
 */
export const APPROVE_DEVICE_AUTHORIZATION_SQL = `
  UPDATE device_authorizations
     SET status = 'approved', user_id = $2, approved_at = NOW()
   WHERE user_code_hash = $1
     AND status = 'pending'
     AND expires_at > NOW()
  RETURNING id, user_id, status, client_label, created_at, expires_at, approved_at`

export async function approveDeviceAuthorization(
  userCode: string,
  userId: string,
  db: Executor = pool,
): Promise<DeviceAuthorizationRow | null> {
  const result = await db.query<DeviceAuthorizationRow>(APPROVE_DEVICE_AUTHORIZATION_SQL, [
    hashCode(normalizeUserCode(userCode)),
    userId,
  ])
  return result.rows[0] ?? null
}

/** Deny a pending grant. Same WHERE-clause discipline as approve. */
export const DENY_DEVICE_AUTHORIZATION_SQL = `
  UPDATE device_authorizations
     SET status = 'denied'
   WHERE user_code_hash = $1
     AND status = 'pending'
     AND expires_at > NOW()
  RETURNING id, user_id, status, client_label, created_at, expires_at, approved_at`

export async function denyDeviceAuthorization(
  userCode: string,
  db: Executor = pool,
): Promise<DeviceAuthorizationRow | null> {
  const result = await db.query<DeviceAuthorizationRow>(DENY_DEVICE_AUTHORIZATION_SQL, [
    hashCode(normalizeUserCode(userCode)),
  ])
  return result.rows[0] ?? null
}

/** The polling read. Never mutates — redemption is its own statement. */
export async function findByDeviceCode(
  deviceCode: string,
  db: Executor = pool,
): Promise<DeviceAuthorizationRow | null> {
  const result = await db.query<DeviceAuthorizationRow>(
    `SELECT id, user_id, status, client_label, created_at, expires_at, approved_at
       FROM device_authorizations WHERE device_code_hash = $1`,
    [hashCode(deviceCode)],
  )
  return result.rows[0] ?? null
}

/**
 * The approval screen's read: what is this code asking for?
 *
 * A human cannot notice a phishing-shaped approval on a screen that shows them
 * nothing about the requester, so the label the CLI sent has to reach the page
 * BEFORE the decision, not in the response to it. This is that read, and it
 * mutates nothing — deciding is still `approve`/`deny`.
 *
 * It matches the same three conditions those two do (`pending`, unexpired,
 * correct hash) so it cannot show a preview for a grant they would refuse.
 * Its route is authenticated and rate-limited, and answers 404 for wrong,
 * expired and already-decided codes alike, exactly as `approve` does: a
 * preview that told them apart would be the enumeration oracle the uniform
 * 404 exists to deny.
 */
export async function findPendingByUserCode(
  userCode: string,
  db: Executor = pool,
): Promise<DeviceAuthorizationRow | null> {
  const result = await db.query<DeviceAuthorizationRow>(
    `SELECT id, user_id, status, client_label, created_at, expires_at, approved_at
       FROM device_authorizations
      WHERE user_code_hash = $1
        AND status = 'pending'
        AND expires_at > NOW()`,
    [hashCode(normalizeUserCode(userCode))],
  )
  return result.rows[0] ?? null
}

/**
 * Claim an approved grant, exactly once.
 *
 * SINGLE USE is enforced by the `status = 'approved'` predicate inside the
 * UPDATE: the first caller flips it to `redeemed` and every later caller
 * matches nothing. A poll loop that fires twice concurrently — which is the
 * normal case, not the exotic one — therefore mints one session, not two.
 */
export const REDEEM_DEVICE_AUTHORIZATION_SQL = `
  UPDATE device_authorizations
     SET status = 'redeemed'
   WHERE device_code_hash = $1
     AND status = 'approved'
     AND expires_at > NOW()
  RETURNING id, user_id, status, client_label, created_at, expires_at, approved_at`

export async function redeemDeviceAuthorization(
  deviceCode: string,
  db: Executor = pool,
): Promise<DeviceAuthorizationRow | null> {
  const result = await db.query<DeviceAuthorizationRow>(REDEEM_DEVICE_AUTHORIZATION_SQL, [
    hashCode(deviceCode),
  ])
  return result.rows[0] ?? null
}

/**
 * Drop expired rows. Called opportunistically from `start`, so the table stays
 * small without a cron: these are spent credentials, not history, and keeping
 * them is keeping something nobody needs and an attacker might want.
 */
export async function purgeExpired(db: Executor = pool): Promise<number> {
  const result = await db.query(`DELETE FROM device_authorizations WHERE expires_at <= NOW()`)
  return result.rowCount ?? 0
}
