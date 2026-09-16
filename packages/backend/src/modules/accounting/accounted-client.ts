import { ProviderError } from './provider.js'

/**
 * The Accounted HTTP client (#3017, epic #3016) — the thin layer every call to
 * `app.accounted.se` goes through. Slice 1 needs only GET; slice 2 (#3018) reuses
 * this file for the document push, where the two write-side rules the API
 * mandates also live:
 *
 *  - `Idempotency-Key` on every write (a UUID; replays within 24h return the
 *    cached response with `Idempotent-Replayed: true`) — the feed's dedup
 *    ledger is the primary guarantee (#497), the header the provider-side belt.
 *  - `dry_run` previews a write without committing. Test keys (`gnubok_sk_test_`)
 *    force it on every write server-side; the OpenAPI pins which endpoints
 *    support it (`dryRunSupported`), and upload is not one of them.
 *
 * Errors come back as `{ error: { code, message, message_en, docs_url, request_id } }`
 * (docs/api/errors). Every message this file throws describes the REQUEST, never
 * the key: the Authorization header is never echoed into an error.
 */

export const ACCOUNTED_API_BASE = 'https://app.accounted.se'
/** The API version the wire shape is pinned to (the spec's own `info.version`). */
export const ACCOUNTED_API_VERSION = '2026-05-12'
/**
 * Upper bound on one Accounted round trip, matching the Fortnox adapter's
 * posture (#2866): a push is a handful of sequential requests and must not
 * outlive the retry sweep's stale-claim threshold. undici's default (300 s per
 * phase) would not guarantee that.
 */
export const ACCOUNTED_REQUEST_TIMEOUT_MS = 15_000

/** One entry of `GET /api/v1/companies` (`data[]`), per the 2026-05-12 spec. */
export interface AccountedCompany {
  id: string
  name: string
  org_number: string | null
  entity_type: string
  role: 'owner' | 'admin' | 'member' | 'viewer'
  created_at: string
}

/** The company-list envelope: `paginated()` on the provider side. */
export interface AccountedCompaniesResponse {
  data: AccountedCompany[]
  meta: { request_id: string; api_version: string; next_cursor?: string | null }
}

/**
 * A refusal for a reason the KEY cannot fix by retrying — HTTP 401 (no/bad
 * key) or 403 (the key lacks the scope). The generic api-key flow maps these
 * to `InvalidApiKeyError`; anything else (network, 429, 5xx) is thrown as a
 * plain failure: an outage is not a bad key.
 */
export function isAccountedAuthRefusal(err: unknown): err is ProviderError {
  return err instanceof ProviderError && err.provider === 'accounted' && (err.status === 401 || err.status === 403)
}

async function accountedRequest<T>(
  apiKey: string,
  path: string,
  fetchImpl: typeof fetch,
): Promise<T> {
  let res: Response
  try {
    res = await fetchImpl(`${ACCOUNTED_API_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(ACCOUNTED_REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    throw new ProviderError(`Could not reach Accounted: ${err instanceof Error ? err.message : String(err)}`, 0, 'accounted')
  }
  if (!res.ok) {
    // The provider's own error code when it sent one (UNAUTHORIZED,
    // INSUFFICIENT_SCOPE, TEST_KEY_WRITE_BLOCKED, …), so callers can tell a
    // refusal from an outage without string-matching the message.
    const detail = await res
      .json()
      .then((b) => (b as { error?: { code?: string; message?: string } }).error)
      .catch(() => undefined)
    throw new ProviderError(
      `Accounted GET ${path} failed (HTTP ${res.status}${detail?.code ? `: ${detail.code}` : ''}).`,
      res.status,
      'accounted',
      // ProviderError.code is numeric by the Fortnox precedent; Accounted's
      // codes are strings, so the message carries it and `code` stays unset.
      undefined,
    )
  }
  return (await res.json()) as T
}

/** `GET /api/v1/companies` — every non-archived company the key's user is a member of. */
export async function accountedListCompanies(
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<AccountedCompaniesResponse> {
  return accountedRequest<AccountedCompaniesResponse>(apiKey, '/api/v1/companies', fetchImpl)
}
