import {
  deleteFortnoxConnectionRow,
  getFortnoxConnectionRow,
  upsertFortnoxConnection,
  type FortnoxConnectionRow,
} from '../../infra/repositories/fortnox-connections.js'
import { config } from '../../config.js'
import {
  type FortnoxCredentials,
  type FortnoxTokens,
  refreshTokens,
} from './fortnox.js'

/**
 * Token lifecycle for a user's Fortnox connection (P2 #465). Persistence
 * moved verbatim into `infra/repositories/fortnox-connections.ts` (#999).
 * Tokens are secrets held server-side only.
 */

export type { FortnoxConnectionRow }

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
  await upsertFortnoxConnection(userId, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenType: tokens.tokenType,
    scope: tokens.scope,
    expiresAt: tokens.expiresAt,
  })
}

export async function getFortnoxConnection(userId: string): Promise<FortnoxConnectionRow | null> {
  return getFortnoxConnectionRow(userId)
}

export async function deleteFortnoxConnection(userId: string): Promise<void> {
  await deleteFortnoxConnectionRow(userId)
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
