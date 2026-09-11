import {
  disconnect,
  getConnection,
  upsertConnection,
  updateSecrets,
  type AccountingConnectionRow,
} from '../../infra/repositories/accounting-connections.js'
import { decryptSecrets, encryptSecrets } from '../../infra/secrets.js'
import { config } from '../../config.js'
import {
  type FortnoxCredentials,
  type FortnoxTokens,
  refreshTokens,
} from './fortnox.js'

/**
 * Token lifecycle for a user's Fortnox connection (P2 #465). Persistence lives
 * in `infra/repositories/accounting-connections.ts` since #2860 — one
 * provider-generic table, secrets encrypted at rest through `infra/secrets.ts`.
 * This module is the ONLY place the Fortnox secrets blob is decrypted; nothing
 * above it sees a ciphertext, nothing below it sees a token.
 *
 * ## The shape callers see is unchanged on purpose
 *
 * `FortnoxConnectionRow` keeps the pre-#2860 field names (`access_token`,
 * `refresh_token`, `token_type`, `scope`, `expires_at`) so the status route,
 * the connector and every existing test read exactly what they read before.
 * It is assembled from the generic row plus the decrypted secrets — the
 * plaintext columns no longer exist in the database.
 *
 * ## Fail closed on write, open on read
 *
 * `saveFortnoxConnection` encrypts, and `encryptSecrets` throws
 * `SecretsKeyMissingError` without a key — a new grant must not land in
 * plaintext. `getFortnoxConnection` reads a version-0 row (copied as-is by
 * migration 080) without a key, because refusing would turn "no key yet" into
 * "the feed is down". A version-0 row is re-encrypted by the next write that
 * touches it (a refresh, a reconnect) and by the boot-time job in
 * `secrets-migration.ts`.
 */

export const FORTNOX_PROVIDER = 'fortnox'

/** What the secrets blob carries for Fortnox. */
export interface FortnoxSecrets {
  accessToken: string
  refreshToken: string
  tokenType: string
  scope: string | null
}

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

function toLegacyRow(row: AccountingConnectionRow): FortnoxConnectionRow | null {
  if (!row.secrets_ciphertext || row.status === 'disconnected') return null
  const secrets = decryptSecrets<FortnoxSecrets>(row.secrets_ciphertext, row.secrets_key_version)
  return {
    user_id: row.user_id,
    access_token: secrets.accessToken,
    refresh_token: secrets.refreshToken,
    token_type: secrets.tokenType,
    scope: secrets.scope,
    // pg returns TIMESTAMPTZ as a Date; callers `new Date(...)` it either way.
    expires_at: row.token_expires_at as unknown as string,
  }
}

export async function saveFortnoxConnection(userId: string, tokens: FortnoxTokens): Promise<void> {
  const secrets: FortnoxSecrets = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenType: tokens.tokenType,
    scope: tokens.scope,
  }
  const { ciphertext, keyVersion } = encryptSecrets(secrets as unknown as Record<string, unknown>)
  await upsertConnection(userId, {
    provider: FORTNOX_PROVIDER,
    authKind: 'oauth2',
    secretsCiphertext: ciphertext,
    secretsKeyVersion: keyVersion,
    grantedScope: tokens.scope,
    tokenExpiresAt: tokens.expiresAt,
  })
}

export async function getFortnoxConnection(userId: string): Promise<FortnoxConnectionRow | null> {
  const row = await getConnection(userId, FORTNOX_PROVIDER)
  return row ? toLegacyRow(row) : null
}

/** Disconnect keeps the row (owner decision: history stays); secrets are cleared. */
export async function deleteFortnoxConnection(userId: string): Promise<void> {
  await disconnect(userId, FORTNOX_PROVIDER, 'user disconnected')
}

/**
 * Return a usable access token for the user, refreshing (and persisting) it if
 * it has expired. Returns null if the user has not connected Fortnox.
 *
 * The refreshed token set is written through `updateSecrets`, which also
 * re-encrypts a version-0 row as a side effect — the first refresh after the
 * key is set is what moves a migrated row off plaintext. (#2863 adds the
 * per-connection lock; this slice keeps the pre-existing unlocked shape.)
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
  const secrets: FortnoxSecrets = {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    tokenType: refreshed.tokenType,
    scope: refreshed.scope,
  }
  const { ciphertext, keyVersion } = encryptSecrets(secrets as unknown as Record<string, unknown>)
  await updateSecrets(userId, FORTNOX_PROVIDER, {
    secretsCiphertext: ciphertext,
    secretsKeyVersion: keyVersion,
    tokenExpiresAt: refreshed.expiresAt,
  })
  return refreshed.accessToken
}
