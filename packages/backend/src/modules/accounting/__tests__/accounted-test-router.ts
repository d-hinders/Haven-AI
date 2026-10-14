/**
 * The Accounted provider router shared by the conformance runner and the
 * unit/allowlist tests (#3018). One implementation, so the recorded-exchange
 * log the allowlist test reads is the SAME log the conformance cases wrote.
 *
 * The router echoes the RECEIVED upload's own sha256 back in the recorded
 * `document-created.json` shape, so the delivery proof (2xx + hash match) is
 * exercised against whatever the client actually assembled — a multipart
 * regression fails here, not silently at the provider.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AccountedConnector } from '../accounted-connector.js'
import { ACCOUNTED_API_BASE } from '../accounted-client.js'
import type { ProviderSecrets } from '../connector.js'
import type { ProviderCompanyInfo } from '../provider.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'accounted')
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fixture bodies are untyped recorded JSON
export const accountedFixture = (name: string): any => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))

export interface UploadRecord {
  idempotencyKey: string | null
  filename: string
  uploadSource: string | null
  sha256: string
  byteLength: number
}

/** The recorded exchange log + per-case refusal switches, inspectable by tests. */
export interface AccountedRouterState {
  uploadCalls: number
  uploads: UploadRecord[]
  lastUpload: UploadRecord | null
  lastPayload: Record<string, unknown> | null
  /** Every request the connector made: method + path — the allowlist test's data. */
  requests: { method: string; path: string }[]
  refuseScope: boolean
  forbidden: boolean
  tooLarge: boolean
  storageFailed: boolean
  rateLimited: boolean
  replayIdempotent: boolean
  /** Echo a WRONG sha256 back on a 2xx — the hash-mismatch case. */
  corruptHash: boolean
  /** #3918: refuse only the SECOND create (the merchant-invoice upload) with a retryable 500. */
  failSecondUpload: boolean
}

const DOCUMENT_ID = '3f1c7a52-9b04-4e6a-8f21-7c5d2e8b9a10'
export const ACCOUNTED_DOCUMENT_ID = DOCUMENT_ID
/**
 * #3918: the id the router hands the SECOND document of a payment (a
 * distinct idempotency key) — the merchant-invoice upload must carry a ref
 * of its own, never the underlag's.
 */
export const ACCOUNTED_MERCHANT_DOCUMENT_ID = '4d0cc49e-8f21-4e6a-9b04-7c5d2e8b9a11'
const DOCUMENT_IDS_BY_INDEX = [DOCUMENT_ID, ACCOUNTED_MERCHANT_DOCUMENT_ID]

export function accountedRouter() {
  const state: AccountedRouterState = {
    uploadCalls: 0,
    uploads: [],
    lastUpload: null,
    lastPayload: null,
    requests: [],
    refuseScope: false,
    forbidden: false,
    tooLarge: false,
    storageFailed: false,
    rateLimited: false,
    replayIdempotent: false,
    corruptHash: false,
    failSecondUpload: false,
  }
  // Per-idempotency-key record + document id: a payment's SECOND document
  // (the merchant invoice, key `paymentId:merchant-invoice`) gets its own
  // cached answer and its own id — a replay of either key must return the
  // SAME id that key created (#3918).
  const byKey = new Map<string, { record: UploadRecord; id: string }>()
  const idForKey = (key: string): string => {
    const idx = byKey.size
    return DOCUMENT_IDS_BY_INDEX[idx] ?? `4d0cc49e-0000-4000-8000-${String(idx).padStart(12, '0')}`
  }
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = u.startsWith(ACCOUNTED_API_BASE) ? u.slice(ACCOUNTED_API_BASE.length).split('?')[0] : u
    state.requests.push({ method, path })
    if (path === '/api/v1/companies' && method === 'GET') return json(accountedFixture('companies.json'))
    if (/^\/api\/v1\/companies\/[^/]+\/documents$/.test(path) && method === 'POST') {
      if (state.refuseScope) return json(accountedFixture('error-403-scope.json'), 403)
      if (state.forbidden) return json(accountedFixture('error-403-forbidden.json'), 403)
      if (state.tooLarge) return json(accountedFixture('error-400-too-large.json'), 400)
      if (state.failSecondUpload && state.uploadCalls === 1) return json({ error: { code: 'DOC_UPLOAD_STORAGE_FAILED', message: 'second document refused' } }, 500)
      if (state.storageFailed) {
        return json(
          {
            error: {
              code: 'DOC_UPLOAD_STORAGE_FAILED',
              message: 'Dokumentet kunde inte sparas.',
              message_en: 'The document could not be stored.',
              docs_url: 'https://app.accounted.se/docs/api/errors/DOC_UPLOAD_STORAGE_FAILED',
            },
          },
          500,
        )
      }
      if (state.rateLimited) return json(accountedFixture('error-429.json'), 429, { 'retry-after': '7' })
      const form = init?.body as FormData
      const file = form.get('file')
      if (!(file instanceof File)) return json({ error: { code: 'INVALID_REQUEST', message: 'missing file part' } }, 400)
      const bytes = Buffer.from(await file.arrayBuffer())
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const headers = (init?.headers ?? {}) as Record<string, string>
      const record: UploadRecord = {
        idempotencyKey: headers['Idempotency-Key'] ?? null,
        filename: file.name,
        uploadSource: typeof form.get('upload_source') === 'string' ? String(form.get('upload_source')) : null,
        sha256,
        byteLength: bytes.byteLength,
      }
      const key = record.idempotencyKey ?? ''
      const cached = byKey.get(key)
      // A replay of the SAME key with the SAME bytes returns the provider's
      // cached answer (the Idempotent-Replayed behaviour) — no second
      // document, so `uploadCalls` (the create counter) does not move.
      if (cached && cached.record.sha256 === record.sha256 && !state.corruptHash) {
        state.replayIdempotent = true
        return json(
          {
            data: {
              id: cached.id,
              sha256_hash: sha256,
              filename: record.filename,
              size: bytes.byteLength,
              upload_source: record.uploadSource,
              created_at: '2026-09-15T09:31:12.4421+00:00',
            },
            meta: { request_id: 'req_replayed', api_version: '2026-05-12' },
          },
          200,
          { 'Idempotent-Replayed': 'true' },
        )
      }
      // SAME key, DIFFERENT bytes: the provider's 409 — the cached document
      // exists and this body is not it.
      if (cached && cached.record.sha256 !== record.sha256) {
        state.uploadCalls += 1
        return json(accountedFixture('error-409-idempotency.json'), 409)
      }
      state.uploadCalls += 1
      state.uploads.push(record)
      state.lastUpload = record
      state.lastPayload = {
        filename: record.filename,
        upload_source: record.uploadSource,
        idempotency_key: record.idempotencyKey,
        sha256: record.sha256,
      }
      const documentId = idForKey(key)
      byKey.set(key, { record, id: documentId })
      const body = accountedFixture('document-created.json')
      body.data.id = documentId
      body.data.sha256_hash = state.corruptHash ? 'deadbeef'.repeat(8) : sha256
      body.data.filename = record.filename
      body.data.size = bytes.byteLength
      return json(body)
    }
    return json({ error: { code: 'NOT_FOUND', message: 'no such route' } }, 404)
  }) as typeof fetch
  return { impl, state }
}

/** Lets a case override what Accounted reports — the real read answers baseCurrency null. */
export class ReportingAccountedConnector extends AccountedConnector {
  constructor(
    fetchImpl: typeof fetch,
    private readonly company: Partial<ProviderCompanyInfo> | undefined,
  ) {
    super(fetchImpl)
  }
  override async getCompanyInfo(secrets: ProviderSecrets): Promise<ProviderCompanyInfo> {
    const real = await super.getCompanyInfo(secrets)
    return { ...real, ...(this.company ?? {}) }
  }
}
