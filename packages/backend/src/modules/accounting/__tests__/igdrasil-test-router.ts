/**
 * The Igdrasil provider router shared by the conformance runner and the
 * unit/allowlist tests (#4518). One implementation, so the exchange log the
 * allowlist test reads is the SAME log the conformance cases wrote.
 *
 * The fixtures are hand-authored from Igdrasil's published `openapi.json`
 * (`PublicCompany` list, `PublicUpload`, `PublicErrorBody`, the token
 * response) — not recorded; the live run on dev (#4519) records the real
 * exchanges and corrects these if they differ.
 *
 * The router models the one provider behaviour the connector leans on:
 * Igdrasil keys a document on its BYTES. The first upload of a byte string
 * answers 201 with a new `document_id`; the same bytes again answer 200
 * naming that same document — no second document, so the create counter does
 * not move. The answer echoes the received file's own SHA-256, so the
 * delivery proof runs against whatever the client actually assembled.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IGDRASIL_API_BASE, IGDRASIL_REVOKE_URL, IGDRASIL_TOKEN_URL } from '../igdrasil.js'
import { IgdrasilConnector } from '../igdrasil-connector.js'
import type { ProviderSecrets } from '../connector.js'
import type { ProviderCompanyInfo } from '../provider.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'igdrasil')
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fixture bodies are untyped JSON
export const igdrasilFixture = (name: string): any => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))

export const IGDRASIL_COMPANY_ID = '5b0e6c1a-2f7d-4c39-9a84-1d2e3f4a5b6c'
export const IGDRASIL_DOCUMENT_ID = '0f6e2c7a-41b9-4d3e-8a52-9c1d7e3b5a20'
export const IGDRASIL_MERCHANT_DOCUMENT_ID = '1a7f3d8b-52ca-4e4f-9b63-ad2e8f4c6b31'
const DOCUMENT_IDS_BY_INDEX = [IGDRASIL_DOCUMENT_ID, IGDRASIL_MERCHANT_DOCUMENT_ID]

export interface IgdrasilUploadRecord {
  companyId: string
  filename: string
  contentType: string
  sha256: string
  byteLength: number
  /** Every multipart part name the client sent — the upload takes exactly `file`. */
  parts: string[]
  headers: Record<string, string>
}

export interface IgdrasilRouterState {
  /** Uploads that CREATED a document (201). A same-bytes repeat (200) does not count. */
  uploadCalls: number
  uploads: IgdrasilUploadRecord[]
  lastPayload: Record<string, unknown> | null
  /** Every request the connector made: method + path — the allowlist test's data. */
  requests: { method: string; path: string }[]
  tokenBodies: string[]
  revokeCalls: number
  revokeBodies: string[]
  /** Answer `GET /companies` with two companies. */
  multiCompany: boolean
  /** Answer `GET /companies` with one company and `has_more: true`. */
  morePages: boolean
  refuseScope: boolean
  companyNotGranted: boolean
  roleRevoked: boolean
  invalidToken: boolean
  rateLimited: boolean
  writesDisabled: boolean
  badFile: boolean
  /** Echo a WRONG sha256 back on a 2xx — the hash-mismatch case. */
  corruptHash: boolean
  /** Refuse only the SECOND distinct upload (the merchant invoice) with a 503. */
  failSecondUpload: boolean
}

export function igdrasilRouter() {
  const state: IgdrasilRouterState = {
    uploadCalls: 0,
    uploads: [],
    lastPayload: null,
    requests: [],
    tokenBodies: [],
    revokeCalls: 0,
    revokeBodies: [],
    multiCompany: false,
    morePages: false,
    refuseScope: false,
    companyNotGranted: false,
    roleRevoked: false,
    invalidToken: false,
    rateLimited: false,
    writesDisabled: false,
    badFile: false,
    corruptHash: false,
    failSecondUpload: false,
  }
  /** company + sha256 → document id: the provider's own dedup. */
  const documents = new Map<string, string>()
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = u.startsWith(IGDRASIL_API_BASE) ? u.slice(IGDRASIL_API_BASE.length).split('?')[0] : u
    state.requests.push({ method, path })
    if (u === IGDRASIL_TOKEN_URL && method === 'POST') {
      state.tokenBodies.push(String(init?.body))
      return json(igdrasilFixture('token.json'))
    }
    if (u === IGDRASIL_REVOKE_URL && method === 'POST') {
      state.revokeCalls += 1
      state.revokeBodies.push(String(init?.body))
      return json({})
    }
    if (path === '/api/v1/external/companies' && method === 'GET') {
      if (state.invalidToken) return json(igdrasilFixture('error-401-invalid_token.json'), 401)
      if (state.multiCompany) return json(igdrasilFixture('companies-multi.json'))
      const body = igdrasilFixture('companies.json')
      if (state.morePages) Object.assign(body, { has_more: true, next_cursor: 'cur_2' })
      return json(body)
    }
    const upload = path.match(/^\/api\/v1\/external\/companies\/([^/]+)\/uploads$/)
    if (upload && method === 'POST') {
      if (state.invalidToken) return json(igdrasilFixture('error-401-invalid_token.json'), 401)
      if (state.refuseScope) return json(igdrasilFixture('error-403-insufficient_scope.json'), 403)
      if (state.companyNotGranted) return json(igdrasilFixture('error-403-company_not_granted.json'), 403)
      if (state.roleRevoked) return json(igdrasilFixture('error-403-grant_role_revoked.json'), 403)
      if (state.rateLimited) return json(igdrasilFixture('error-429-rate_limited.json'), 429, { 'retry-after': '7' })
      if (state.writesDisabled) return json(igdrasilFixture('error-503-writes_disabled.json'), 503)
      if (state.badFile) return json(igdrasilFixture('error-400-invalid_request.json'), 400)
      const form = init?.body as FormData
      const file = form.get('file')
      if (!(file instanceof File)) return json(igdrasilFixture('error-400-invalid_request.json'), 400)
      const bytes = Buffer.from(await file.arrayBuffer())
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const companyId = decodeURIComponent(upload[1])
      const key = `${companyId}:${sha256}`
      const existing = documents.get(key)
      if (!existing && state.failSecondUpload && documents.size === 1) {
        return json(igdrasilFixture('error-503-writes_disabled.json'), 503)
      }
      const record: IgdrasilUploadRecord = {
        companyId,
        filename: file.name,
        contentType: file.type,
        sha256,
        byteLength: bytes.byteLength,
        parts: [...new Set([...form.keys()])],
        headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      }
      state.uploads.push(record)
      const id = existing ?? DOCUMENT_IDS_BY_INDEX[documents.size] ?? `2b8f4e9c-0000-4000-8000-${String(documents.size).padStart(12, '0')}`
      if (!existing) {
        documents.set(key, id)
        state.uploadCalls += 1
        state.lastPayload = { parts: record.parts, filename: record.filename, content_type: record.contentType, sha256 }
      }
      const body = igdrasilFixture('upload.json')
      body.document_id = id
      body.content_type = record.contentType
      body.size = bytes.byteLength
      body.sha256 = state.corruptHash ? 'deadbeef'.repeat(8) : sha256
      return json(body, existing ? 200 : 201)
    }
    return json({ error: { type: 'not_found', code: 'resource_missing', message: 'No such route.', request_id: 'req_fixture_404' } }, 404)
  }) as typeof fetch
  return { impl, state }
}

/** Lets a conformance case override what Igdrasil reports — the real read answers baseCurrency null. */
export class ReportingIgdrasilConnector extends IgdrasilConnector {
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
