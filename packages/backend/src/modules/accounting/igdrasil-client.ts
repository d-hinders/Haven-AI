import { createHash } from 'node:crypto'
import { IGDRASIL_API_BASE } from './igdrasil.js'
import { ProviderError } from './provider.js'

/**
 * The Igdrasil HTTP client (#4518, epic #2875) — the thin layer every call to
 * `accounting.igdrasil.se/api/v1/external/…` goes through, with an OAuth2
 * access token (the token endpoints are the generic `oauth-flow.ts`'s).
 *
 * Two calls, and only two (`igdrasil-outbound-allowlist.test.ts` pins them):
 *
 *  - `GET /api/v1/external/companies` — the companies the grant reaches, read
 *    at connect (`companies:read`).
 *  - `POST /api/v1/external/companies/{company_id}/uploads` — the document
 *    push (`vouchers:write`). Igdrasil stores the file "the way the inbox
 *    stores an emailed receipt … nothing proposes a voucher from it", and
 *    "the same bytes upload as the same document, so a retry needs no
 *    `Idempotency-Key`": a repeat answers 200 naming the existing document, a
 *    new file 201. Never `…/supplier-invoices` (registers AND books, with
 *    lines), voucher drafts (lines), `…/book`, or `DELETE …/uploads/{id}`.
 *
 * Errors come back as `{ error: { type, code, message, request_id } }`. The
 * code is an OPEN enum ("act on the error `type` and the HTTP status for a
 * code you do not know"), so the connector branches on a few known codes and
 * falls back to the status. Every message this file throws describes the
 * REQUEST, never the token.
 */

/**
 * Upper bound on one Igdrasil round trip, the Accounted/Fortnox posture
 * (#2866): a push must not outlive the retry sweep's stale-claim threshold.
 */
export const IGDRASIL_REQUEST_TIMEOUT_MS = 15_000

/** "A PDF, JPEG or PNG of at most 25 MiB" — the upload form's own limit. */
export const IGDRASIL_UPLOAD_MAX_BYTES = 25 * 1024 * 1024

/** One entry of `GET /api/v1/external/companies` (`PublicCompany`). No currency field: the book currency is SEK. */
export interface IgdrasilCompany {
  object: 'company'
  id: string
  name: string
  org_number?: string | null
}

export interface IgdrasilCompanyList {
  object: string
  data: IgdrasilCompany[]
  has_more: boolean
  next_cursor?: string | null
  url: string
}

/** `PublicUpload`: the stored document. */
export interface IgdrasilUpload {
  object: 'upload'
  document_id: string
  content_type: string
  size: number
  sha256: string
}

/** A thrown failure's provider code (`error.code`), when the body carried one. */
export type IgdrasilProviderError = ProviderError & { providerCode?: string; retryAfterMs?: number }

async function igdrasilError(res: Response, what: string): Promise<IgdrasilProviderError> {
  const body = await res.json().catch(() => undefined)
  const raw = (body as { error?: { code?: unknown } } | undefined)?.error?.code
  // A short identifier only — never the provider's free-text message.
  const code = typeof raw === 'string' && /^[a-z_]{1,64}$/.test(raw) ? raw : null
  const err: IgdrasilProviderError = new ProviderError(
    `Igdrasil ${what} failed (HTTP ${res.status}${code ? `: ${code}` : ''}).`,
    res.status,
    'igdrasil',
  )
  if (code) err.providerCode = code
  if (res.status === 429) {
    // SECONDS per RFC 9110; the sweep reads the FIELD, never the header.
    const retryAfter = res.headers.get('retry-after')
    const seconds = retryAfter !== null && /^\d+(\.\d+)?$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : NaN
    if (Number.isFinite(seconds) && seconds > 0) err.retryAfterMs = Math.round(seconds * 1000)
  }
  return err
}

function unreachable(err: unknown): ProviderError {
  return new ProviderError(`Could not reach Igdrasil: ${err instanceof Error ? err.message : String(err)}`, 0, 'igdrasil')
}

/** `GET /api/v1/external/companies` — every company the token's grant reaches. */
export async function igdrasilListCompanies(accessToken: string, fetchImpl: typeof fetch): Promise<IgdrasilCompanyList> {
  let res: Response
  try {
    res = await fetchImpl(`${IGDRASIL_API_BASE}/api/v1/external/companies`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(IGDRASIL_REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    throw unreachable(err)
  }
  if (!res.ok) throw await igdrasilError(res, 'GET /api/v1/external/companies')
  return (await res.json()) as IgdrasilCompanyList
}

/**
 * `POST /api/v1/external/companies/{company_id}/uploads` — multipart with one
 * `file` part. No `Idempotency-Key`: Igdrasil keys the document on its bytes.
 *
 * A 2xx is success ONLY when the returned `sha256` equals the local SHA-256
 * of the bytes sent — the delivery proof, checked at the only layer that
 * holds both sides (the Accounted precedent, #3018).
 */
export async function igdrasilUploadDocument(input: {
  accessToken: string
  companyId: string
  file: { filename: string; bytes: Buffer; contentType: string }
  fetchImpl: typeof fetch
}): Promise<{ upload: IgdrasilUpload; sha256: string; created: boolean }> {
  const sha256 = createHash('sha256').update(input.file.bytes).digest('hex')
  const form = new FormData()
  // A copy into a plain ArrayBuffer-backed view: Buffer's ArrayBufferLike
  // does not satisfy BlobPart.
  const view = new Uint8Array(input.file.bytes.byteLength)
  view.set(input.file.bytes)
  form.append('file', new Blob([view], { type: input.file.contentType }), input.file.filename)

  const path = `/api/v1/external/companies/${encodeURIComponent(input.companyId)}/uploads`
  let res: Response
  try {
    res = await input.fetchImpl(`${IGDRASIL_API_BASE}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.accessToken}`, Accept: 'application/json' },
      body: form,
      signal: AbortSignal.timeout(IGDRASIL_REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    throw unreachable(err)
  }
  if (!res.ok) throw await igdrasilError(res, `POST ${path}`)

  const upload = (await res.json()) as IgdrasilUpload
  if (!upload || typeof upload.document_id !== 'string' || upload.document_id.length === 0) {
    throw new ProviderError('Igdrasil upload returned no document id — delivery cannot be proven.', res.status, 'igdrasil')
  }
  if (upload.sha256 !== sha256) throw new IgdrasilUploadHashMismatchError(upload.sha256 ?? null, sha256)
  return { upload, sha256, created: res.status === 201 }
}

/**
 * The upload answered 2xx but its `sha256` does not match the bytes Haven
 * sent: Haven cannot vouch for what was stored, so no ref is kept.
 */
export class IgdrasilUploadHashMismatchError extends Error {
  readonly name = 'IgdrasilUploadHashMismatchError'
  constructor(
    public readonly providerHash: string | null,
    public readonly localHash: string,
  ) {
    super('Igdrasil stored different bytes than the ones Haven uploaded (sha256 mismatch).')
  }
}
