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
 *
 * ## The refresh runs under a per-connection lock (#2863)
 *
 * Two workers refreshing the same single-use token — the settlement hook and
 * a "Sync now" click — used to burn each other's rotation and lock the
 * connection out. The refresh path now runs inside `withLockedConnection`
 * (`SELECT … FOR UPDATE` on the `accounting_connections` row): the second
 * caller waits, re-reads the row the first one already rotated, and uses
 * that token without a provider call. The rotated pair is committed with the
 * lock, BEFORE the access token is handed to the caller.
 *
 * A refresh the provider REFUSES with `invalid_grant` (or a 400/403 with no
 * readable code — see `isGrantRefusal`) means the grant is dead: the row flips to
 * `needs_reauthorisation` with the provider's error code as the reason (never
 * token material), the caller gets `ConnectionNeedsReauthorisationError`, and
 * no later call retries the refresh until the user re-consents. A 429 (Fortnox
 * rate limit, 25 calls / 5 s, no Retry-After) and a 408 are transient and
 * surface as `ProviderError` without touching the row.
 */

import {
  getConnection,
  stampFeedFromIfUnset,
  updateSecrets,
  upsertConnection,
  withLockedConnection,
  type AccountingConnectionRow,
} from '../../infra/repositories/accounting-connections.js'
import { flagConnectionStatus } from './ops-signals.js'
import { SecretsKeyMissingError, decryptSecrets, encryptSecrets, secretsKeyConfigured } from '../../infra/secrets.js'
import { applyCompanyInfo } from './company-info.js'
import type { AccountingConnector } from './connector.js'
import {
  ProviderError,
  assertSupportedBaseCurrency,
  compareGrantedScopes,
  missingScopesReason,
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
  /** RFC 7009 revocation endpoint; required when the descriptor declares `capabilities.revoke`. */
  revokeUrl?: string
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

/**
 * Upper bound on one token-endpoint round trip. The refresh runs while the
 * connection row is locked (`withLockedConnection`), so an unanswered
 * provider must not pin a pool connection and the row forever: the abort
 * surfaces as a `ProviderError` with status 0 — transient, never a grant
 * verdict — and the transaction rolls back.
 */
export const OAUTH2_PROVIDER_TIMEOUT_MS = 15_000

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
      signal: AbortSignal.timeout(OAUTH2_PROVIDER_TIMEOUT_MS),
    })
  } catch (err) {
    throw new ProviderError(
      `Could not reach ${cfg.providerId}: ${err instanceof Error ? err.message : String(err)}`,
      0,
      cfg.providerId,
    )
  }
  if (!res.ok) {
    const code = await readOAuthErrorCode(res)
    throw new OAuthTokenRefusal(cfg.providerId, res.status, code)
  }
  return toTokens((await res.json()) as TokenResponse)
}

/** A non-2xx from the token endpoint, carrying the RFC 6749 `error` code (or null) for the grant verdict below. */
export class OAuthTokenRefusal extends ProviderError {
  oauthError: string | null
  constructor(provider: string, status: number, oauthError: string | null) {
    super(`${provider} token request failed (HTTP ${status})${oauthError ? `: ${oauthError}` : '.'}`, status, provider)
    this.name = 'OAuthTokenRefusal'
    this.oauthError = oauthError
  }
}

/**
 * The RFC 6749 `error` code from a token-endpoint refusal (`invalid_grant`,
 * `invalid_client`, …), or null. Only the short code is read — never the
 * description, never the body as a whole — so what reaches a log line or a
 * `status_reason` is one identifier, not provider free text.
 */
async function readOAuthErrorCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: unknown }
    const code = typeof body?.error === 'string' ? body.error : null
    return code && /^[a-z_]{1,64}$/.test(code) ? code : null
  } catch {
    return null
  }
}

/**
 * Revoke a token at the provider (RFC 7009): `token` + `token_type_hint`,
 * Basic client auth. Fortnox: `POST /oauth-v1/revoke` with the refresh token.
 * Throws `ProviderError` on a non-2xx; the caller (disconnect) treats that as
 * "log and clear locally anyway".
 */
export async function revokeToken(
  cfg: OAuth2ProviderConfig,
  token: string,
  tokenTypeHint: 'refresh_token' | 'access_token',
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!cfg.revokeUrl) {
    throw new ProviderError(`${cfg.providerId} declares no revocation endpoint.`, 0, cfg.providerId)
  }
  let res: Response
  try {
    res = await fetchImpl(cfg.revokeUrl, {
      method: 'POST',
      headers: {
        Authorization: basicAuthHeader(cfg),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({ token, token_type_hint: tokenTypeHint }).toString(),
      signal: AbortSignal.timeout(OAUTH2_PROVIDER_TIMEOUT_MS),
    })
  } catch (err) {
    throw new ProviderError(
      `Could not reach ${cfg.providerId}: ${err instanceof Error ? err.message : String(err)}`,
      0,
      cfg.providerId,
    )
  }
  if (!res.ok) {
    throw new ProviderError(`${cfg.providerId} revoke request failed (HTTP ${res.status}).`, res.status, cfg.providerId)
  }
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
 * ledger that books in the wrong currency (#2864: "Haven currently feeds SEK
 * ledgers only"), and only then store. A refused connect stores nothing — an
 * existing row is left exactly as it was, and the user sees `error`.
 *
 * The company step runs only when the descriptor declares `companyInfo`;
 * the currency check runs regardless (a null currency passes), so the
 * enforcement point is reached on every connect and the conformance suite can
 * prove that with a provider that reports a non-SEK ledger.
 *
 * ## The same call IS the re-consent path (#2865)
 *
 * `POST /accounting/connections/:provider/connect-url` on an existing
 * connection issues a fresh state; the callback lands here with `existed`
 * set, and `upsertConnection`'s conflict path UPDATES the row: secrets,
 * `granted_scope`, expiry, `status → connected`, `status_reason` cleared —
 * while `settings` (the user's configuration and the `companySwitches` log),
 * `feed_from`, `is_active_destination` (kept if held) and every
 * `accounting_feed_syncs` row are untouched. A `skipped` row behind the
 * connection becomes claimable again the moment the row is `connected`
 * (the retry sweep's predicate); a `pushed` row stays pushed.
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
  const freshSecrets = tokensToSecrets(tokens) as unknown as Record<string, unknown>
  let info: ProviderCompanyInfo
  try {
    info = input.provider.capabilities.companyInfo
      ? await input.connector.getCompanyInfo(freshSecrets)
      : { externalCompanyId: null, name: null, baseCurrency: null }
    assertSupportedBaseCurrency(info)
  } catch (err) {
    // #2864: the code is already exchanged, so a grant exists at the
    // provider but will never be stored here — whether the company read
    // failed (401/429/5xx/network) or the currency was refused. #2863's rule
    // — a grant Haven drops is also revoked at the provider — applies;
    // best-effort, the error is the answer either way (review on #2898).
    if (input.provider.capabilities.revoke) await input.connector.revoke(freshSecrets).catch(() => {})
    throw err
  }

  const existed = await getConnection(input.userId, input.provider.id)
  const saved = await saveOAuth2Connection(input.provider.id, input.userId, tokens)
  // A FIRST connect that became the destination is an activation: the
  // feed-from rule applies (review on #2894 — disconnect A → connect B
  // re-fed A's history). A reconnect keeps the floor it had.
  const row = (!existed && saved.is_active_destination
    ? await stampFeedFromIfUnset(input.userId, input.provider.id, new Date())
    : null) ?? saved
  // #2864: a reconnect to a DIFFERENT company is a company switch (feed_from
  // = now, switch recorded); a scope refusal on the company read marks the
  // row scope_missing. Both decisions are `company-info.ts`'s.
  const applied = await applyCompanyInfo({ provider: input.provider, userId: input.userId, existed, saved: row, info })
  // #2865: the granted scope string against the descriptor. A shortfall is
  // NOT a refusal — the grant is stored (it may still push invoices, as the
  // pre-`connectfile` grants did) — but the row is `scope_missing` with the
  // missing scopes named, so the dashboard asks for a re-consent BEFORE the
  // first push finds out. Runs last so its reason (which names the scopes)
  // wins over the company read's when both apply.
  // MUTATION TARGET (scope-missing.db.test.ts "narrower scope"): skipping
  // this comparison stores a connected row that fails at push time.
  return recordScopeShortfall(input.provider, input.userId, applied, tokens.scope)
}

/** See `completeOAuth2Connect`. Returns the row as it now is. */
async function recordScopeShortfall(
  provider: AccountingProvider,
  userId: string,
  row: AccountingConnectionRow,
  grantedScope: string | null,
): Promise<AccountingConnectionRow> {
  const missing = compareGrantedScopes(grantedScope, provider.requiredScopes)
  if (missing.length === 0) return row
  const reason = missingScopesReason(
    missing,
    `the ${provider.displayName} grant was consented without ${missing.length === 1 ? 'a scope' : 'scopes'} the feed needs — reconnect to obtain ${missing.length === 1 ? 'it' : 'them'}`,
  )
  await flagConnectionStatus(userId, provider.id, 'scope_missing', reason)
  return { ...row, status: 'scope_missing', status_reason: reason }
}

/**
 * Thrown when the stored grant is dead and only a re-consent can revive it.
 * Carries no token material — `status` names the row's state, `reason` the
 * provider's error code as recorded in `status_reason`.
 */
export class ConnectionNeedsReauthorisationError extends Error {
  readonly provider: string
  readonly status: 'needs_reauthorisation' | 'revoked_at_provider'
  readonly reason: string | null
  constructor(provider: string, status: ConnectionNeedsReauthorisationError['status'], reason: string | null) {
    super(`${provider} connection is ${status.replace(/_/g, ' ')}${reason ? ` (${reason})` : ''} — reconnect it.`)
    this.name = 'ConnectionNeedsReauthorisationError'
    this.provider = provider
    this.status = status
    this.reason = reason
  }
}

/** The states in which the stored grant cannot be used and must not be refreshed. */
export function isTokenDeadStatus(status: AccountingConnectionRow['status']): status is 'needs_reauthorisation' | 'revoked_at_provider' {
  return status === 'needs_reauthorisation' || status === 'revoked_at_provider'
}

/**
 * RFC 6749 §5.2 error codes that are about HAVEN's request or client
 * credentials, not about the user's grant. A rotated or wrong client secret
 * answers `invalid_client` (401) for every user at once — flipping them all
 * to needs_reauthorisation would send every user through a re-consent that
 * fails for the same reason (review on #2895). These stay transient: the row
 * is untouched, the refresh token is unconsumed, and the fix is the
 * operator's (`FORTNOX_CLIENT_ID`/`FORTNOX_CLIENT_SECRET`).
 */
const CLIENT_SIDE_OAUTH_ERRORS = new Set(['invalid_client', 'invalid_request', 'unauthorized_client', 'unsupported_grant_type', 'invalid_scope'])

/**
 * A token-endpoint refusal that means the GRANT is dead, as opposed to a
 * transient. `invalid_grant` is the one code RFC 6749 defines as a verdict on
 * the grant; a 400/403 with no readable code is treated the same (Fortnox
 * answers a burned or expired refresh token with 400 invalid_grant, and a
 * bodyless 400 on a refresh has no other plausible meaning). Everything else
 * is retried by the next sync, never a reason to demand a re-consent: 401 and
 * the client-side codes above (Haven's credentials), 429 (Fortnox's rate
 * limit, no Retry-After), 408 (timeout), 5xx and a network failure
 * (status 0 — the provider's problem).
 */
function isGrantRefusal(err: unknown): err is OAuthTokenRefusal {
  if (!(err instanceof OAuthTokenRefusal)) return false
  if (err.oauthError === 'invalid_grant') return true
  if (err.oauthError !== null) return !CLIENT_SIDE_OAUTH_ERRORS.has(err.oauthError) && (err.status === 400 || err.status === 403)
  return err.status === 400 || err.status === 403
}

const stillValid = (row: AccountingConnectionRow): boolean =>
  (row.token_expires_at ? new Date(row.token_expires_at).getTime() : 0) > Date.now()

type LockedRefreshOutcome =
  | { kind: 'token'; accessToken: string }
  | { kind: 'dead'; status: 'needs_reauthorisation' | 'revoked_at_provider'; reason: string | null }
  | { kind: 'none' }

/**
 * Return a usable access token for the user, refreshing (and persisting) it if
 * it has expired. Returns null if the user has no live connection. Throws
 * `ConnectionNeedsReauthorisationError` when the grant is dead (see the file
 * header) and `SecretsKeyMissingError` when a refresh would land in plaintext.
 *
 * The unlocked fast path answers the common case (a valid token) with one
 * read. Only an expired token takes the lock; inside it the row is re-read,
 * so a caller that queued behind another worker's refresh finds a valid
 * token and returns it without touching the provider. The refreshed set is
 * written through `updateSecrets` ON THE LOCK's transaction — which also
 * re-encrypts a version-0 row as a side effect (the first refresh after the
 * key is set is what moves a migrated row off plaintext) — and committed
 * before the caller sees the new access token.
 *
 * The `dead` outcome is a RETURN, not a throw, on purpose: `withTransaction`
 * rolls back on a throw, and the `needs_reauthorisation` write must commit.
 */
export async function getValidOAuth2AccessToken(
  cfg: OAuth2ProviderConfig,
  userId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const conn = await readOAuth2Connection(cfg.providerId, userId)
  if (!conn) return null
  if (isTokenDeadStatus(conn.row.status)) {
    throw new ConnectionNeedsReauthorisationError(cfg.providerId, conn.row.status, conn.row.status_reason)
  }
  if (stillValid(conn.row)) return conn.secrets.accessToken

  // ORDER MATTERS — see the file header. The refusal happens here, before any
  // provider call, with the stored single-use refresh token still valid.
  if (!secretsKeyConfigured()) throw new SecretsKeyMissingError()

  // MUTATION TARGET (fortnox-connection.db.test.ts, "two concurrent callers"):
  // without the lock both callers refresh and the second rotation kills the
  // first caller's freshly stored refresh token.
  const outcome = await withLockedConnection<LockedRefreshOutcome>(userId, cfg.providerId, async (row, tx) => {
    if (!row || !row.secrets_ciphertext || row.status === 'disconnected') return { kind: 'none' }
    if (isTokenDeadStatus(row.status)) return { kind: 'dead', status: row.status, reason: row.status_reason }
    const secrets = decryptSecrets<OAuth2Secrets>(row.secrets_ciphertext, row.secrets_key_version)
    // Another worker refreshed while we waited for the lock: its token is
    // the live one, and its refresh token is the only one Fortnox honours.
    if (stillValid(row)) return { kind: 'token', accessToken: secrets.accessToken }

    let refreshed: OAuth2Tokens
    try {
      refreshed = await refreshAccessToken(cfg, secrets.refreshToken, fetchImpl)
    } catch (err) {
      // MUTATION TARGET (fortnox-connection.db.test.ts, "invalid_grant"):
      // without this flip the dead grant is retried on every sync.
      if (!isGrantRefusal(err)) throw err
      const reason = `refresh refused: ${err.message}`
      await flagConnectionStatus(userId, cfg.providerId, 'needs_reauthorisation', reason, tx)
      return { kind: 'dead', status: 'needs_reauthorisation', reason }
    }
    const { ciphertext, keyVersion } = encryptSecrets(tokensToSecrets(refreshed) as unknown as Record<string, unknown>)
    await updateSecrets(
      userId,
      cfg.providerId,
      { secretsCiphertext: ciphertext, secretsKeyVersion: keyVersion, tokenExpiresAt: refreshed.expiresAt },
      tx,
    )
    return { kind: 'token', accessToken: refreshed.accessToken }
  })

  if (outcome.kind === 'none') return null
  if (outcome.kind === 'dead') throw new ConnectionNeedsReauthorisationError(cfg.providerId, outcome.status, outcome.reason)
  return outcome.accessToken
}
