import { buildAuthorizeUrl, exchangeCode, refreshAccessToken, type OAuth2ProviderConfig, type OAuth2Tokens } from './oauth-flow.js'
import { ProviderError } from './provider.js'

/**
 * Fortnox OAuth2 (epic #462 P2 #465; feed-side since #491).
 *
 * Since #2862 this file is the Fortnox PARAMETERISATION of the generic
 * `oauth-flow.ts`: the constants, the `OAuth2ProviderConfig` builder, and thin
 * wrappers that keep the historical names (`buildFortnoxAuthorizeUrl`,
 * `exchangeCodeForTokens`, `refreshTokens`) and the `FortnoxError` type for
 * callers and tests. No behaviour change: the URL, the Basic-auth token post
 * and the minute-early expiry are the generic flow's — the same requests
 * Fortnox saw before (the authorize URL's query-parameter order changed;
 * the parameters did not).
 *
 * #2859: the VOUCHER mapping and push moved to `legacy/fortnox-voucher.ts`.
 * They are the asserting half — `toFortnoxVoucher` calls `buildBookingLines`,
 * which picks debit/credit BAS accounts — and this file is imported by the
 * non-asserting feed. Keeping them here made a feed file import the legacy
 * booking code, which is exactly what the import guard in
 * `__tests__/legacy-import-guard.test.ts` now forbids.
 */
export const FORTNOX_AUTHORIZE_URL = 'https://apps.fortnox.se/oauth-v1/auth'
export const FORTNOX_TOKEN_URL = 'https://apps.fortnox.se/oauth-v1/token'
// #2863: RFC 7009 revocation. Disconnect posts the REFRESH token here with
// `token_type_hint=refresh_token` before the stored secrets are cleared; the
// access token dies with it (Fortnox invalidates the pair).
export const FORTNOX_REVOKE_URL = 'https://apps.fortnox.se/oauth-v1/revoke'
export const FORTNOX_API_BASE = 'https://api.fortnox.se/3'
// #496: the feed adapter creates unattested SUPPLIER INVOICES (+ suppliers)
// rather than vouchers, and #498 attaches the receipt underlag via the INBOX
// (upload + supplierinvoicefileconnections). Scopes must match the
// integration's registered permissions in the developer portal (Bokföring,
// Leverantörsfaktura, Leverantör, Arkivplats, Inkorg, Koppla filer).
// `connectfile` is REQUIRED for supplierinvoicefileconnections — proven live
// 2026-07-16: with only `supplierinvoice`+`inbox` the upload succeeds but the
// connection POST fails 400 "Har inte behörighet för scope" [2000663].
// Widening the scope requires existing connections to re-consent;
// pre-widening connections degrade to note-only attachment
// (see fortnox-connector.ts).
// #2864: `companyinformation` lets the connect flow read `GET
// /3/companyinformation` — which company (DatabaseNumber, CompanyName) the
// grant points at — so a reconnect to a different company is detected as a
// company switch. Adding a scope does NOT invalidate existing grants: a
// pre-#2864 connection keeps refreshing and pushing without it, and only a
// fresh consent (a new authorization code) carries it. The integration's
// registered permissions in the developer portal must include it (Företagsinformation).
export const FORTNOX_SCOPE = 'bookkeeping supplierinvoice supplier archive inbox connectfile companyinformation'

export interface FortnoxCredentials {
  clientId: string
  clientSecret: string
  redirectUri: string
}

export type FortnoxTokens = OAuth2Tokens

export class FortnoxError extends ProviderError {
  /** The API path the failing request went to (`/supplierinvoices`, …), when known — what `fortnoxScopeForPath` reads (#2865). */
  path?: string
  constructor(message: string, status: number, code?: number, path?: string) {
    super(message, status, 'fortnox', code)
    this.name = 'FortnoxError'
    if (path !== undefined) this.path = path
  }
}

/**
 * Fortnox's "Har inte behörighet för scope" — the grant lacks a scope the
 * call needs. Found live 2026-07-16 on `supplierinvoicefileconnections`
 * without `connectfile`. A post-push attachment failing with this code means
 * the CONNECTION needs a re-consent, not that the push failed.
 */
export const FORTNOX_SCOPE_ERROR_CODE = 2000663

export function isFortnoxScopeError(err: unknown): boolean {
  return err instanceof ProviderError && err.code === FORTNOX_SCOPE_ERROR_CODE
}

/**
 * A refusal FOR SCOPE, as opposed to the scope error code alone: Fortnox
 * answers a grant without the scope with `[2000663]` (as a 400 on the file
 * connection POST, found live) or a bare 403. Both mean "re-consent", never
 * "retry" — an outage, a 401, a 429 or a 5xx is none of these.
 */
export function isFortnoxScopeRefusal(err: unknown): err is FortnoxError {
  return err instanceof FortnoxError && (err.status === 403 || isFortnoxScopeError(err))
}

/**
 * #2865: which scope a Fortnox API path needs, so a refusal can NAME the
 * scope a re-consent must add — Fortnox's `[2000663]` does not say. The
 * mapping follows the integration's registered permissions (see
 * `FORTNOX_SCOPE`): supplier invoices → `supplierinvoice`, suppliers →
 * `supplier`, the inbox upload → `inbox`, the file connection →
 * `connectfile`, company information → `companyinformation`. Unknown paths
 * name nothing.
 */
const FORTNOX_PATH_SCOPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\/supplierinvoicefileconnections(\/|\?|$)/, 'connectfile'],
  [/^\/supplierinvoices(\/|\?|$)/, 'supplierinvoice'],
  [/^\/suppliers(\/|\?|$)/, 'supplier'],
  [/^\/inbox(\/|\?|$)/, 'inbox'],
  [/^\/companyinformation(\/|\?|$)/, 'companyinformation'],
]

export function fortnoxScopeForPath(path: string | undefined): string | null {
  if (!path) return null
  for (const [re, scope] of FORTNOX_PATH_SCOPES) if (re.test(path)) return scope
  return null
}

/** Re-throw a generic provider failure under the Fortnox name callers pin. */
function asFortnoxError(err: unknown): never {
  if (err instanceof FortnoxError) throw err
  if (err instanceof ProviderError) throw new FortnoxError(err.message, err.status)
  throw err
}

/** The generic flow's view of Fortnox. */
export function fortnoxOAuth2Config(creds: FortnoxCredentials): OAuth2ProviderConfig {
  return {
    providerId: 'fortnox',
    authorizeUrl: FORTNOX_AUTHORIZE_URL,
    tokenUrl: FORTNOX_TOKEN_URL,
    revokeUrl: FORTNOX_REVOKE_URL,
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    redirectUri: creds.redirectUri,
    scope: FORTNOX_SCOPE,
    extraAuthorizeParams: { access_type: 'offline', account_type: 'service' },
  }
}

/** Build the consent URL the customer is redirected to (pure). */
export function buildFortnoxAuthorizeUrl(
  creds: Pick<FortnoxCredentials, 'clientId' | 'redirectUri'>,
  state: string,
): string {
  return buildAuthorizeUrl(fortnoxOAuth2Config({ ...creds, clientSecret: '' }), state)
}

/** Exchange an authorization code for tokens. */
export async function exchangeCodeForTokens(
  creds: FortnoxCredentials,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FortnoxTokens> {
  try {
    return await exchangeCode(fortnoxOAuth2Config(creds), code, fetchImpl)
  } catch (err) {
    return asFortnoxError(err)
  }
}

/** Refresh an expired access token. */
export async function refreshTokens(
  creds: FortnoxCredentials,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FortnoxTokens> {
  try {
    return await refreshAccessToken(fortnoxOAuth2Config(creds), refreshToken, fetchImpl)
  } catch (err) {
    return asFortnoxError(err)
  }
}
