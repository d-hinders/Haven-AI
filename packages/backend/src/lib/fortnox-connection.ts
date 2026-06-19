import pool from '../db.js'
import { config } from '../config.js'
import {
  type FortnoxCredentials,
  type FortnoxTokens,
  refreshTokens,
} from './fortnox.js'

/**
 * Persistence + token lifecycle for a user's Fortnox connection (P2 #465).
 * Tokens are secrets held server-side only.
 */

export interface FortnoxConnectionRow {
  user_id: string
  access_token: string
  refresh_token: string
  token_type: string
  scope: string | null
  expires_at: string
}

/** Whether the Fortnox feature is configured at all. */
export function fortnoxConfigured(): boolean {
  return Boolean(config.fortnoxClientId && config.fortnoxClientSecret && config.fortnoxRedirectUri)
}

export function fortnoxCredentials(): FortnoxCredentials {
  return {
    clientId: config.fortnoxClientId,
    clientSecret: config.fortnoxClientSecret,
    redirectUri: config.fortnoxRedirectUri,
  }
}

export async function saveFortnoxConnection(userId: string, tokens: FortnoxTokens): Promise<void> {
  await pool.query(
    `INSERT INTO fortnox_connections
       (user_id, access_token, refresh_token, token_type, scope, expires_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       token_type = EXCLUDED.token_type,
       scope = EXCLUDED.scope,
       expires_at = EXCLUDED.expires_at,
       updated_at = NOW()`,
    [userId, tokens.accessToken, tokens.refreshToken, tokens.tokenType, tokens.scope, tokens.expiresAt],
  )
}

export async function getFortnoxConnection(userId: string): Promise<FortnoxConnectionRow | null> {
  const result = await pool.query<FortnoxConnectionRow>(
    `SELECT user_id, access_token, refresh_token, token_type, scope, expires_at
     FROM fortnox_connections WHERE user_id = $1`,
    [userId],
  )
  return result.rows[0] ?? null
}

export async function deleteFortnoxConnection(userId: string): Promise<void> {
  await pool.query('DELETE FROM fortnox_connections WHERE user_id = $1', [userId])
}

/**
 * Return a usable access token for the user, refreshing (and persisting) it if
 * it has expired. Returns null if the user has not connected Fortnox.
 */
export async function getValidFortnoxAccessToken(
  userId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const conn = await getFortnoxConnection(userId)
  if (!conn) return null

  if (new Date(conn.expires_at).getTime() > Date.now()) {
    return conn.access_token
  }

  const refreshed = await refreshTokens(fortnoxCredentials(), conn.refresh_token, fetchImpl)
  await saveFortnoxConnection(userId, refreshed)
  return refreshed.accessToken
}
