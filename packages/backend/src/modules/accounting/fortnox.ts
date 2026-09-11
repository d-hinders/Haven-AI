/**
 * Fortnox OAuth2 (epic #462 P2 #465; feed-side since #491).
 *
 * Pure helpers (authorize URL) plus thin token calls that take an injectable
 * `fetch` so they're testable without a live Fortnox app.
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
export const FORTNOX_SCOPE = 'bookkeeping supplierinvoice supplier archive inbox connectfile'

export interface FortnoxCredentials {
  clientId: string
  clientSecret: string
  redirectUri: string
}

export interface FortnoxTokens {
  accessToken: string
  refreshToken: string
  tokenType: string
  scope: string | null
  /** Absolute expiry. */
  expiresAt: Date
}

interface FortnoxTokenResponse {
  access_token: string
  refresh_token: string
  token_type?: string
  scope?: string
  expires_in: number
}

export class FortnoxError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'FortnoxError'
    this.status = status
  }
}

/** Build the consent URL the customer is redirected to (pure). */
export function buildFortnoxAuthorizeUrl(
  creds: Pick<FortnoxCredentials, 'clientId' | 'redirectUri'>,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: creds.clientId,
    redirect_uri: creds.redirectUri,
    scope: FORTNOX_SCOPE,
    state,
    access_type: 'offline',
    response_type: 'code',
    account_type: 'service',
  })
  return `${FORTNOX_AUTHORIZE_URL}?${params.toString()}`
}

function basicAuthHeader(creds: FortnoxCredentials): string {
  return `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64')}`
}

function toTokens(data: FortnoxTokenResponse): FortnoxTokens {
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
  creds: FortnoxCredentials,
  body: URLSearchParams,
  fetchImpl: typeof fetch,
): Promise<FortnoxTokens> {
  let res: Response
  try {
    res = await fetchImpl(FORTNOX_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: basicAuthHeader(creds),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    })
  } catch (err) {
    throw new FortnoxError(`Could not reach Fortnox: ${err instanceof Error ? err.message : String(err)}`, 0)
  }
  if (!res.ok) {
    throw new FortnoxError(`Fortnox token request failed (HTTP ${res.status}).`, res.status)
  }
  return toTokens((await res.json()) as FortnoxTokenResponse)
}

/** Exchange an authorization code for tokens. */
export function exchangeCodeForTokens(
  creds: FortnoxCredentials,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FortnoxTokens> {
  return postToken(
    creds,
    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: creds.redirectUri }),
    fetchImpl,
  )
}

/** Refresh an expired access token. */
export function refreshTokens(
  creds: FortnoxCredentials,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FortnoxTokens> {
  return postToken(
    creds,
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    fetchImpl,
  )
}
