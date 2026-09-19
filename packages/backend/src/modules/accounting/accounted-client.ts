import { createHash } from 'node:crypto'
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

/**
 * One document of `POST /api/v1/companies/{companyId}/documents` (`data[]`),
 * per the 2026-05-12 spec's create-document answer.
 */
export interface AccountedDocument {
  id: string
  sha256_hash: string
  filename: string
  size: number
  upload_source: string
  created_at: string
}

export interface AccountedDocumentResponse {
  data: AccountedDocument
  meta: { request_id: string; api_version: string }
}

/**
 * RFC 4122 namespace UUID for Haven→Accounted idempotency keys — a fixed,
 * randomly chosen namespace so the same `paymentId` always derives the same
 * key. uuidv5 without pulling the `uuid` package (sha1(name, ns_bytes)).
 */
const ACCOUNTED_IDEMPOTENCY_NAMESPACE = '9f1c2a6e-0b4d-4c7a-9e2f-5d3b8a1c7e40'

/**
 * The `Idempotency-Key` for one payment's document upload: `uuid5(paymentId)`
 * under the namespace above. Bytes are deterministic and the merchant receipt
 * is excluded, so a retry of the same payment replays the provider's cached
 * response; a DIFFERENT payment derives a different key.
 */
export function accountedIdempotencyKey(paymentId: string): string {
  const ns = ACCOUNTED_IDEMPOTENCY_NAMESPACE.replace(/-/g, '')
  const nsBytes = Buffer.from(ns, 'hex')
  const hash = createHash('sha1').update(nsBytes).update(paymentId).digest()
  hash[6] = ((hash[6] & 0x0f) | 0x50) as number // version 5
  hash[8] = ((hash[8] & 0x3f) | 0x80) as number // RFC 4122 variant
  const hex = hash.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

export const ACCOUNTED_DOCUMENTS_MAX_BYTES = 10 * 1024 * 1024

/** The provider's published error envelope (`docs.gnubok.se/errors`). */
export interface AccountedErrorBody {
  error?: {
    code?: string
    message?: string
    message_en?: string
    details?: Record<string, unknown>
    recovery_hint?: string
    docs_url?: string
  }
}

/**
 * The provider's error ENVELOPE from a failed response's body, read once:
 * the `code` is the discriminator between `INSUFFICIENT_SCOPE` (a grant
 * problem, `scope_missing`) and a plain `FORBIDDEN` (not),
 * `IDEMPOTENCY_KEY_REUSE` (terminal), `DOC_UPLOAD_TOO_LARGE` /
 * `DOC_UPLOAD_UNSUPPORTED_TYPE` (permanent), `DOC_UPLOAD_STORAGE_FAILED`
 * (retryable); `details` is what the connector reads `missingScopes` from
 * when the 403 names the scope.
 */
export async function accountedErrorEnvelope(res: Response): Promise<AccountedErrorBody['error']> {
  const body = await res.json().catch(() => undefined)
  return (body as AccountedErrorBody | undefined)?.error
}

/**
 * `POST /api/v1/companies/{companyId}/documents` — the WORM upload (#3018).
 * Multipart with EXACTLY two parts: the `file` part (the underlag PDF) and
 * `upload_source=api` (`additionalProperties: false` on the spec's request
 * body — no other part may be sent). `Idempotency-Key` rides every write:
 * with deterministic bytes a replay returns the provider's cached response.
 *
 * A 2xx is success ONLY when the returned `data.sha256_hash` equals the
 * local SHA-256 of the sent bytes — the delivery proof is verified here, at
 * the only layer that holds both sides of it.
 *
 * Errors:
 *  - 429 throws `ProviderError` with `retryAfterMs` set when a numeric
 *    `Retry-After` header is present (SECONDS per RFC 9110; the sweep reads
 *    the FIELD, never the header) — that is what defers the connection.
 *  - Every other failure throws `ProviderError`; the CONNECTOR branches on
 *    the code this reports through `err.providerCode`.
 */
export async function accountedUploadDocument(input: {
  apiKey: string
  companyId: string
  file: { filename: string; bytes: Buffer; contentType: string }
  idempotencyKey: string
  fetchImpl: typeof fetch
}): Promise<{ document: AccountedDocument; sha256: string }> {
  const sha256 = createHash('sha256').update(input.file.bytes).digest('hex')
  const form = new FormData()
  // A copy into a plain ArrayBuffer-backed view: Buffer's ArrayBufferLike
  // does not satisfy BlobPart, and the underlag is a few KB — copying is free.
  const view = new Uint8Array(input.file.bytes.byteLength)
  view.set(input.file.bytes)
  form.append('file', new Blob([view], { type: input.file.contentType }), input.file.filename)
  form.append('upload_source', 'api')

  let res: Response
  try {
    res = await input.fetchImpl(
      `${ACCOUNTED_API_BASE}/api/v1/companies/${encodeURIComponent(input.companyId)}/documents`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          Accept: 'application/json',
          'Idempotency-Key': input.idempotencyKey,
        },
        body: form,
        signal: AbortSignal.timeout(ACCOUNTED_REQUEST_TIMEOUT_MS),
      },
    )
  } catch (err) {
    throw new ProviderError(`Could not reach Accounted: ${err instanceof Error ? err.message : String(err)}`, 0, 'accounted')
  }

  if (!res.ok) {
    const envelope = await accountedErrorEnvelope(res)
    const code = typeof envelope?.code === 'string' && envelope.code.length > 0 ? envelope.code : null
    const base = `Accounted POST /api/v1/companies/${input.companyId}/documents failed (HTTP ${res.status}${code ? `: ${code}` : ''}).`
    if (res.status === 429) {
      const retryAfter = res.headers.get('retry-after')
      const seconds = retryAfter !== null && /^\d+(\.\d+)?$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : NaN
      const err = new ProviderError(base, 429, 'accounted')
      if (Number.isFinite(seconds) && seconds > 0) {
        ;(err as ProviderError & { retryAfterMs?: number }).retryAfterMs = Math.round(seconds * 1000)
      }
      throw err
    }
    const err = new ProviderError(base, res.status, 'accounted')
    if (code) (err as ProviderError & { providerCode?: string }).providerCode = code
    // The envelope's `details` rides the error — the connector's
    // `missingScopes` for an INSUFFICIENT_SCOPE 403 is read off it.
    if (envelope?.details) (err as ProviderError & { details?: Record<string, unknown> }).details = envelope.details
    throw err
  }

  const body = (await res.json()) as AccountedDocumentResponse
  const document = body?.data
  if (!document || typeof document.id !== 'string' || document.id.length === 0) {
    throw new ProviderError(
      'Accounted document upload returned no document id — delivery cannot be proven.',
      res.status,
      'accounted',
    )
  }
  if (document.sha256_hash !== sha256) {
    throw new AccountedDocumentHashMismatchError(document.sha256_hash ?? null, sha256)
  }
  return { document, sha256 }
}

/**
 * The upload answered 2xx but the returned `sha256_hash` does not match the
 * bytes Haven sent: Haven cannot vouch for what the provider stored, so the
 * caller must NOT keep the ref (#3018 — "do not store a ref Haven cannot
 * vouch for"). Surfaces as `skipped` with this name in the reason.
 */
export class AccountedDocumentHashMismatchError extends Error {
  readonly name = 'AccountedDocumentHashMismatchError'
  constructor(
    public readonly providerHash: string | null,
    public readonly localHash: string,
  ) {
    super('Accounted stored different bytes than the ones Haven uploaded (sha256 mismatch).')
  }
}
