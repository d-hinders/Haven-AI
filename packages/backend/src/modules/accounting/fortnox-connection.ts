import { disconnect, type AccountingConnectionRow } from '../../infra/repositories/accounting-connections.js'
import { config } from '../../config.js'
import { fortnoxOAuth2Config, type FortnoxCredentials, type FortnoxTokens } from './fortnox.js'
import {
  getValidOAuth2AccessToken,
  readOAuth2Connection,
  saveOAuth2Connection,
  type OAuth2Secrets,
} from './oauth-flow.js'

/**
 * Token lifecycle for a user's Fortnox connection (P2 #465). Since #2862 the
 * mechanism is the generic `oauth-flow.ts`, parameterised by
 * `fortnoxOAuth2Config`; this file keeps the Fortnox-named entry points the
 * connector, the sandbox script and the tests call. Persistence lives in
 * `infra/repositories/accounting-connections.ts` (#2860) — one
 * provider-generic table, secrets encrypted at rest through `infra/secrets.ts`.
 *
 * ## The shape callers see is unchanged on purpose
 *
 * `FortnoxConnectionRow` keeps the pre-#2860 field names (`access_token`,
 * `refresh_token`, `token_type`, `scope`, `expires_at`) so the connector and
 * every existing test read exactly what they read before. It is assembled
 * from the generic row plus the decrypted secrets — the plaintext columns no
 * longer exist in the database.
 *
 * ## Fail closed on write, open on read
 *
 * `saveFortnoxConnection` encrypts, and `encryptSecrets` throws
 * `SecretsKeyMissingError` without a key — a new grant must not land in
 * plaintext. `getFortnoxConnection` reads a version-0 row (copied as-is by
 * migration 080) without a key, because refusing would turn "no key yet" into
 * "the feed is down". A version-0 row is re-encrypted by the next write that
 * touches it (a refresh, a reconnect) and by the boot-time job in
 * `secrets-migration.ts`. The refresh's key-check-BEFORE-provider-call order
 * (haven-reviewer, #2887) is the generic flow's, not restated here.
 */

export const FORTNOX_PROVIDER = 'fortnox'

/** What the secrets blob carries for Fortnox — the generic OAuth2 shape. */
export type FortnoxSecrets = OAuth2Secrets

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

function toLegacyRow(row: AccountingConnectionRow, secrets: OAuth2Secrets): FortnoxConnectionRow {
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
  await saveOAuth2Connection(FORTNOX_PROVIDER, userId, tokens)
}

export async function getFortnoxConnection(userId: string): Promise<FortnoxConnectionRow | null> {
  const conn = await readOAuth2Connection(FORTNOX_PROVIDER, userId)
  return conn ? toLegacyRow(conn.row, conn.secrets) : null
}

/** Disconnect keeps the row (owner decision: history stays); secrets are cleared. */
export async function deleteFortnoxConnection(userId: string): Promise<void> {
  await disconnect(userId, FORTNOX_PROVIDER, 'user disconnected')
}

/**
 * Return a usable access token for the user, refreshing (and persisting) it if
 * it has expired. Returns null if the user has not connected Fortnox. The
 * generic flow refuses BEFORE the provider call when no secrets key is
 * configured, so the stored single-use refresh token is never consumed.
 */
export function getValidFortnoxAccessToken(
  userId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  return getValidOAuth2AccessToken(fortnoxOAuth2Config(fortnoxCredentials()), userId, fetchImpl)
}
