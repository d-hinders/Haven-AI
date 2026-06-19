import type { AccountingEntry } from './accounting-entry.js'
import { DEFAULT_SETTLEMENT_ACCOUNT, basAccountForCategory } from './bas-accounts.js'

/**
 * Fortnox OAuth2 + voucher push (epic #462, P2 #465).
 *
 * Pure helpers (authorize URL, voucher mapping) plus thin token/push calls that
 * take an injectable `fetch` so they're testable without a live Fortnox app.
 * Vouchers mirror the SIE booking exactly (debit BAS expense / credit
 * settlement); reverse-charge VAT lines are P3. See
 * `docs/research/bookkeeping-ready-export.md` §9.
 */
export const FORTNOX_AUTHORIZE_URL = 'https://apps.fortnox.se/oauth-v1/auth'
export const FORTNOX_TOKEN_URL = 'https://apps.fortnox.se/oauth-v1/token'
export const FORTNOX_API_BASE = 'https://api.fortnox.se/3'
export const FORTNOX_SCOPE = 'bookkeeping'
export const FORTNOX_VOUCHER_SERIES = 'A'

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

export interface FortnoxVoucherRow {
  Account: number
  Debit: number
  Credit: number
}

export interface FortnoxVoucher {
  VoucherSeries: string
  TransactionDate: string
  Description: string
  VoucherRows: FortnoxVoucherRow[]
}

/**
 * Map a settled entry to a balanced Fortnox voucher. Returns null when the entry
 * has no book-time SEK value (unbookable) — same rule as the SIE exporter.
 */
export function toFortnoxVoucher(entry: AccountingEntry): FortnoxVoucher | null {
  if (entry.amountSek == null) return null
  const amount = Number(entry.amountSek)
  if (!Number.isFinite(amount)) return null

  const expenseAccount = Number(basAccountForCategory(entry.category))
  const settlementAccount = Number(DEFAULT_SETTLEMENT_ACCOUNT)
  const description =
    entry.counterparty.name ?? entry.counterparty.address ?? entry.resourceUrl ?? 'Agent payment'

  return {
    VoucherSeries: FORTNOX_VOUCHER_SERIES,
    TransactionDate: entry.settledAt.slice(0, 10),
    Description: description.slice(0, 200),
    VoucherRows: [
      { Account: expenseAccount, Debit: amount, Credit: 0 },
      { Account: settlementAccount, Debit: 0, Credit: amount },
    ],
  }
}

/** POST a single voucher to Fortnox. Throws FortnoxError on non-2xx. */
export async function pushVoucher(
  accessToken: string,
  voucher: FortnoxVoucher,
  fetchImpl: typeof fetch = fetch,
): Promise<{ voucherNumber: number | null }> {
  let res: Response
  try {
    res = await fetchImpl(`${FORTNOX_API_BASE}/vouchers`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ Voucher: voucher }),
    })
  } catch (err) {
    throw new FortnoxError(`Could not reach Fortnox: ${err instanceof Error ? err.message : String(err)}`, 0)
  }
  if (!res.ok) {
    throw new FortnoxError(`Fortnox voucher push failed (HTTP ${res.status}).`, res.status)
  }
  const data = (await res.json()) as { Voucher?: { VoucherNumber?: number } }
  return { voucherNumber: data.Voucher?.VoucherNumber ?? null }
}
