/**
 * Data access for a user's Fortnox connection (#999, epic #980).
 *
 * One aggregate: `fortnox_connections` — one row per user, holding the OAuth
 * token set (P2 #465). Extracted verbatim from
 * `modules/reporting/fortnox-connection.ts`; the token LIFECYCLE (refresh,
 * expiry) stays in that module — this file only persists. Convention:
 * `README.md` in this directory.
 *
 * Tokens are secrets held server-side only; nothing here may ever be exposed
 * through an API response.
 */

import pool from '../../db.js'
import type { Executor } from '../transaction.js'

export type { Executor }

export interface FortnoxConnectionRow {
  user_id: string
  access_token: string
  refresh_token: string
  token_type: string
  scope: string | null
  expires_at: string
}

export const UPSERT_FORTNOX_CONNECTION_SQL = `INSERT INTO fortnox_connections
       (user_id, access_token, refresh_token, token_type, scope, expires_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       token_type = EXCLUDED.token_type,
       scope = EXCLUDED.scope,
       expires_at = EXCLUDED.expires_at,
       updated_at = NOW()`

export const GET_FORTNOX_CONNECTION_SQL = `SELECT user_id, access_token, refresh_token, token_type, scope, expires_at
     FROM fortnox_connections WHERE user_id = $1`

export const DELETE_FORTNOX_CONNECTION_SQL = 'DELETE FROM fortnox_connections WHERE user_id = $1'

/** `userId` is REQUIRED — the connection is the user's own OAuth grant. */
export async function upsertFortnoxConnection(
  userId: string,
  tokens: {
    accessToken: string
    refreshToken: string
    tokenType: string
    scope: string | null
    /** Absolute expiry — pg serializes the Date. */
    expiresAt: Date
  },
  db: Executor = pool,
): Promise<void> {
  await db.query(UPSERT_FORTNOX_CONNECTION_SQL, [
    userId,
    tokens.accessToken,
    tokens.refreshToken,
    tokens.tokenType,
    tokens.scope,
    tokens.expiresAt,
  ])
}

export async function getFortnoxConnectionRow(
  userId: string,
  db: Executor = pool,
): Promise<FortnoxConnectionRow | null> {
  const result = await db.query<FortnoxConnectionRow>(GET_FORTNOX_CONNECTION_SQL, [userId])
  return result.rows[0] ?? null
}

export async function deleteFortnoxConnectionRow(
  userId: string,
  db: Executor = pool,
): Promise<void> {
  await db.query(DELETE_FORTNOX_CONNECTION_SQL, [userId])
}
