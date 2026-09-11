/**
 * Generic OAuth2 flow for accounting providers (#2862, epic #2858).
 *
 * Parameterised by an `OAuth2ProviderConfig` — authorize URL, token URL,
 * client credentials, scope — so a second OAuth2 provider is a config object
 * plus a connector, not a second copy of this file. Fortnox's config lives in
 * `fortnox.ts`; the pure helpers here (authorize URL, code exchange, refresh)
 * take an injectable `fetch` and are testable without a live provider app.
 *
 * ## Two halves
 *
 * The HTTP half (`buildAuthorizeUrl`, `exchangeCode`, `refreshAccessToken`)
 * knows nothing about storage. The lifecycle half (`completeOAuth2Connect`,
 * `getValidOAuth2AccessToken`, `readOAuth2Connection`) is the ONLY place an
 * OAuth2 secrets blob is decrypted: nothing above it sees a ciphertext,
 * nothing below it sees a token. Persistence is
 * `infra/repositories/accounting-connections.ts` (#2860); encryption is
 * `infra/secrets.ts`.
 *
 * ## The order in `getValidOAuth2AccessToken` is load-bearing
 *
 * Provider refresh tokens are single-use (Fortnox: rotate on every refresh,
 * 45-day life). The `secretsKeyConfigured()` check therefore runs BEFORE the
 * refresh call: a replica without `HAVEN_SECRETS_KEY` must refuse with the
 * stored token still valid, not burn it at the provider and then fail to
 * persist the replacement (haven-reviewer, #2887). The Fortnox-specific
 * predecessor had this invariant; it is kept here for every provider.
 */

import {
  getConnection,
  setCompanyInfo,
  updateSecrets,
  upsertConnection,
  type AccountingConnectionRow,
} from '../../infra/repositories/accounting-connections.js'
import { SecretsKeyMissingError, decryptSecrets, encryptSecrets, secretsKeyConfigured } from '../../infra/secrets.js'
import type { AccountingConnector } from './connector.js'
import {
  ProviderError,
  assertSupportedBaseCurrency,
  type AccountingProvider,
  type ProviderCompanyInfo,
} from './provider.js'

export interface OAuth2ProviderConfig {
  providerId: string
  authorizeUrl: string
  tokenUrl: string
  clientId: string
  clientSecret: string
  redirectUri: string
  /** Space-separated scope string as the provider expects it. */
  scope: string
  /** Provider-specific authorize parameters (Fortnox: access_type, account_type). */
  extraAuthorizeParams?: Record<string, string>
}

export interface OAuth2Tokens {
  accessToken: string
  refreshToken: string
  tokenType: string
  scope: string | null
  /** Absolute expiry. */
  expiresAt: Date
}

/** What the secrets blob carries for an OAuth2 provider. */
export interface OAuth2Secrets {
  accessToken: string
  refreshToken: string
  tokenType: string
  scope: string | null
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  token_type?: string
  scope?: string
  expires_in: number
}

/** Build the consent URL the customer is redirected to (pure). */
export function buildAuthorizeUrl(
  cfg: Pick<OAuth2ProviderConfig, 'authorizeUrl' | 'clientId' | 'redirectUri' | 'scope' | 'extraAuthorizeParams'>,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: cfg.scope,
    state,
    response_type: 'code',
    ...(cfg.extraAuthorizeParams ?? {}),
  })
  return `${cfg.authorizeUrl}?${params.toString()}`
}

function basicAuthHeader(cfg: Pick<OAuth2ProviderConfig, 'clientId' | 'clientSecret'>): string {
  return `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`
}

function toTokens(data: TokenResponse): OAuth2Tokens {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    tokenType: data.token_type ?? 'Bearer',
    scope: data.scope ?? null,
    // Refresh a minute early to avoid edge-of-expiry failures.
    expiresAt: new Date(Date.now() + (data.expires_in - 60) * 1000),
  }
}

async function postToken(
  cfg: OAuth2ProviderConfig,
  body: URLSearchParams,
  fetchImpl: typeof fetch,
): Promise<OAuth2Tokens> {
  let res: Response
  try {
    res = await fetchImpl(cfg.tokenUrl, {
      method: 'POST',
      headers: {
        Authorization: basicAuthHeader(cfg),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    })
  } catch (err) {
    throw new ProviderError(
      `Could not reach ${cfg.providerId}: ${err instanceof Error ? err.message : String(err)}`,
      0,
      cfg.providerId,
    )
  }
  if (!res.ok) {
    throw new ProviderError(`${cfg.providerId} token request failed (HTTP ${res.status}).`, res.status, cfg.providerId)
  }
  return toTokens((await res.json()) as TokenResponse)
}

/** Exchange an authorization code for tokens. */
export function exchangeCode(
  cfg: OAuth2ProviderConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuth2Tokens> {
  return postToken(
    cfg,
    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: cfg.redirectUri }),
    fetchImpl,
  )
}

/** Refresh an expired access token. Consumes the refresh token at the provider. */
export function refreshAccessToken(
  cfg: OAuth2ProviderConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuth2Tokens> {
  return postToken(cfg, new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }), fetchImpl)
}

// ── Lifecycle half ────────────────────────────────────────────────────────────

export function tokensToSecrets(tokens: OAuth2Tokens): OAuth2Secrets {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenType: tokens.tokenType,
    scope: tokens.scope,
  }
}

/** The connection row plus its decrypted secrets, or null when not connected. */
export async function readOAuth2Connection(
  providerId: string,
  userId: string,
): Promise<{ row: AccountingConnectionRow; secrets: OAuth2Secrets } | null> {
  const row = await getConnection(userId, providerId)
  if (!row || !row.secrets_ciphertext || row.status === 'disconnected') return null
  const secrets = decryptSecrets<OAuth2Secrets>(row.secrets_ciphertext, row.secrets_key_version)
  return { row, secrets }
}

/** Encrypt and store a fresh grant (connect or reconnect). Fails closed without a key. */
export async function saveOAuth2Connection(
  providerId: string,
  userId: string,
  tokens: OAuth2Tokens,
): Promise<AccountingConnectionRow> {
  const { ciphertext, keyVersion } = encryptSecrets(tokensToSecrets(tokens) as unknown as Record<string, unknown>)
  return upsertConnection(userId, {
    provider: providerId,
    authKind: 'oauth2',
    secretsCiphertext: ciphertext,
    secretsKeyVersion: keyVersion,
    grantedScope: tokens.scope,
    tokenExpiresAt: tokens.expiresAt,
  })
}

/**
 * The callback's work, after the state has been verified and consumed:
 * exchange the code, ask the provider who the grant belongs to, refuse a
 * ledger that books in the wrong currency, and only then store. A refused
 * connect stores nothing — the user sees `error` and nothing landed.
 *
 * The company step runs only when the descriptor declares `companyInfo`;
 * the currency check runs regardless (a null currency passes), so the
 * enforcement point is reached on every connect and the conformance suite can
 * prove that with a provider that reports a non-SEK ledger.
 */
export async function completeOAuth2Connect(input: {
  provider: AccountingProvider
  cfg: OAuth2ProviderConfig
  connector: AccountingConnector
  userId: string
  code: string
  fetchImpl?: typeof fetch
}): Promise<AccountingConnectionRow> {
  const fetchImpl = input.fetchImpl ?? fetch
  // A connect that would land in plaintext is refused BEFORE the code is
  // consumed at the provider — same reasoning as the refresh order below.
  if (!secretsKeyConfigured()) throw new SecretsKeyMissingError()

  const tokens = await exchangeCode(input.cfg, input.code, fetchImpl)
  const info: ProviderCompanyInfo = input.provider.capabilities.companyInfo
    ? await input.connector.getCompanyInfo(tokensToSecrets(tokens) as unknown as Record<string, unknown>)
    : { externalCompanyId: null, name: null, baseCurrency: null }
  assertSupportedBaseCurrency(info)

  const row = await saveOAuth2Connection(input.provider.id, input.userId, tokens)
  await setCompanyInfo(input.userId, input.provider.id, info)
  return { ...row, external_company_id: info.externalCompanyId, external_company_name: info.name, base_currency: info.baseCurrency }
}

/**
 * Return a usable access token for the user, refreshing (and persisting) it if
 * it has expired. Returns null if the user has no live connection.
 *
 * The refreshed token set is written through `updateSecrets`, which also
 * re-encrypts a version-0 row as a side effect — the first refresh after the
 * key is set is what moves a migrated row off plaintext. (#2863 adds the
 * per-connection lock; this keeps the pre-existing unlocked shape.)
 */
export async function getValidOAuth2AccessToken(
  cfg: OAuth2ProviderConfig,
  userId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const conn = await readOAuth2Connection(cfg.providerId, userId)
  if (!conn) return null

  const expiresAt = conn.row.token_expires_at ? new Date(conn.row.token_expires_at).getTime() : 0
  if (expiresAt > Date.now()) return conn.secrets.accessToken

  // ORDER MATTERS — see the file header. The refusal happens here, before any
  // provider call, with the stored single-use refresh token still valid.
  if (!secretsKeyConfigured()) throw new SecretsKeyMissingError()

  const refreshed = await refreshAccessToken(cfg, conn.secrets.refreshToken, fetchImpl)
  const { ciphertext, keyVersion } = encryptSecrets(tokensToSecrets(refreshed) as unknown as Record<string, unknown>)
  await updateSecrets(userId, cfg.providerId, {
    secretsCiphertext: ciphertext,
    secretsKeyVersion: keyVersion,
    tokenExpiresAt: refreshed.expiresAt,
  })
  return refreshed.accessToken
}
