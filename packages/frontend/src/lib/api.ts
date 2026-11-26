import { isProductionEnvironment } from './env'

const BASE_URL = '/api'
const API_OVERRIDE_STORAGE_KEY = 'haven_api_base_url'

interface ApiError {
  error: string
  statusCode?: number
}

export interface ListPasskeysResponse {
  passkeys: Array<{
    id: string
    credential_id: string
    signer_address: string
    chain_id: number
    account_address: string | null
    created_at: string
  }>
}

/**
 * The `?apiBaseUrl` override (and its persisted localStorage value) is a dev/QA
 * convenience for domain-less testing (a preview frontend re-pointed at the
 * shared dev backend — see the dev-environment + QA epics). It MUST stay disabled
 * in production: otherwise a crafted link (`…/?apiBaseUrl=https://evil`) redirects
 * the user's authenticated requests — including the `Authorization: Bearer <jwt>`
 * that `request()` attaches — to an attacker-controlled host, leaking the session
 * token. See #582.
 *
 * `NEXT_PUBLIC_HAVEN_ENV` is build-time inlined, so the production bundle (where
 * it is unset) evaluates this to `false` and the override path is dead code.
 */
function isApiOverrideEnabled(): boolean {
  // One reading of the convention (#2709): unset, empty, `production` and
  // `prod` are all production, and production never honours an override.
  return !isProductionEnvironment()
}

export function getResolvedApiBaseUrl(): string {
  if (typeof window === 'undefined') {
    return BASE_URL
  }

  // Production: never honor a query-param or stored override — always use the
  // baked-in base URL. This is the gate that stops the token-exfiltration vector.
  if (!isApiOverrideEnabled()) {
    return BASE_URL
  }

  const searchParams = new URLSearchParams(window.location.search)
  const overrideParam = searchParams.get('apiBaseUrl')

  if (overrideParam === 'default') {
    window.localStorage.removeItem(API_OVERRIDE_STORAGE_KEY)
    return BASE_URL
  }

  if (overrideParam) {
    const normalized = overrideParam.replace(/\/+$/, '')
    window.localStorage.setItem(API_OVERRIDE_STORAGE_KEY, normalized)
    return normalized
  }

  const storedOverride = window.localStorage.getItem(API_OVERRIDE_STORAGE_KEY)
  if (storedOverride) {
    return storedOverride.replace(/\/+$/, '')
  }

  return BASE_URL
}

/**
 * #4827: the paths whose 401 does NOT mean the session ended.
 *
 * A 401 from a session-authenticated call ends the session (owner decision
 * 2026-11-12). These three answer 401 for a reason that has nothing to do with
 * the stored token, and the dashboard meets them WITH a session token stored:
 *
 * - `POST /auth/login` — a wrong password (`routes/auth.ts:212`). The caller is
 *   signing in; the session it already holds is not the thing being refused.
 * - `POST /agent-connection-setups/resolve` and `/register` — the agent's
 *   setup code is wrong or expired (`routes/agent-connection-setups.ts:387`,
 *   `:426`, `:462`), called from `hooks/useAgentConnectionSetup.ts:740`, `:748`.
 *
 * Matched on the path alone (query stripped), because the refusal is a property
 * of the route, not of the request.
 */
const SESSION_EXEMPT_PATHS = new Set([
  '/auth/login',
  '/agent-connection-setups/resolve',
  '/agent-connection-setups/register',
])

/**
 * #4827: the one reaction to a 401 that ends the session. `AuthContext`
 * registers it; the API client owns the detection so every authenticated call
 * is covered, not just the hooks that happen to check a status.
 */
export type SessionExpiredHandler = () => void

let sessionExpiredHandler: SessionExpiredHandler | null = null

/**
 * Register (or, with `null`, clear) the session-expired reaction. One handler:
 * the session is a single thing, and two reactions would be two sign-outs.
 */
export function setSessionExpiredHandler(handler: SessionExpiredHandler | null): void {
  sessionExpiredHandler = handler
}

class ApiClient {
  private resolveBaseUrl(): string {
    return getResolvedApiBaseUrl()
  }

  private getToken(): string | null {
    if (typeof window === 'undefined') return null
    return localStorage.getItem('haven_token')
  }

  /**
   * #4827: tell the auth layer that a 401 ended the session, at the moment the
   * error is thrown rather than in each caller.
   *
   * Three guards, each an acceptance criterion:
   * - no token was sent → there is no session to end;
   * - the path is exempt → its 401 is about the request, not the session;
   * - the stored token is no longer the one this request carried → the answer
   *   belongs to a session that has already been replaced (a fresh `login()`)
   *   or ended (an earlier 401), so it changes nothing. That last guard is also
   *   what makes two in-flight 401s produce exactly one sign-out: the first
   *   handler call removes the token, and the second finds it gone.
   */
  private reportSessionEndingStatus(
    path: string,
    status: number,
    sentToken: string | null,
  ): void {
    if (status !== 401 || !sentToken) return
    if (SESSION_EXEMPT_PATHS.has(path.split('?')[0])) return
    if (this.getToken() !== sentToken) return
    sessionExpiredHandler?.()
  }

  private async request<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const token = this.getToken()
    const headers: Record<string, string> = {
      ...((options.headers as Record<string, string>) ?? {}),
    }

    const hasContentType = Object.keys(headers).some(
      (header) => header.toLowerCase() === 'content-type',
    )
    if (options.body !== undefined && !hasContentType) {
      headers['Content-Type'] = 'application/json'
    }

    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    const response = await fetch(`${this.resolveBaseUrl()}${path}`, {
      ...options,
      headers,
    })

    if (!response.ok) {
      const body: ApiError = await response.json().catch(() => ({
        error: 'An unexpected error occurred',
      }))
      this.reportSessionEndingStatus(path, response.status, token)
      throw new ApiRequestError(body.error, response.status, body)
    }

    // A successful response may carry no body at all. `204 No Content` is the
    // correct answer for a bodyless delete (`DELETE /accounting/connections/:provider`,
    // `DELETE /accounting/categories`), and `205 Reset Content` is the same shape.
    // `Response.json()` on an empty body throws `SyntaxError: Unexpected end of
    // JSON input` — which reached the user as a raw engine string on Disconnect
    // and skipped the refetch (#4538). Resolve `undefined` instead; every 2xx
    // that does carry a body still parses below.
    if (response.status === 204 || response.status === 205) {
      return undefined as T
    }

    return response.json() as Promise<T>
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>(path)
  }

  /** GET a non-JSON body (e.g. an export file) as raw text, with auth. */
  async getText(path: string): Promise<string> {
    const token = this.getToken()
    const headers: Record<string, string> = {}
    if (token) headers['Authorization'] = `Bearer ${token}`

    const response = await fetch(`${this.resolveBaseUrl()}${path}`, { headers })
    if (!response.ok) {
      const body: ApiError = await response.json().catch(() => ({
        error: 'An unexpected error occurred',
      }))
      this.reportSessionEndingStatus(path, response.status, token)
      throw new ApiRequestError(body.error, response.status, body)
    }
    return response.text()
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'PUT',
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'PATCH',
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'DELETE' })
  }

  // POST /passkeys (the Safe signer enrolment) was deleted with the Safe rail
  // in #2847; the list read stays — AuthContext loads it every session.
  listPasskeys(): Promise<ListPasskeysResponse> {
    return this.get<ListPasskeysResponse>('/passkeys')
  }

  rotateAgentKey(agentId: string): Promise<{ api_key: string; api_key_prefix: string }> {
    return this.post<{ api_key: string; api_key_prefix: string }>(`/agents/${agentId}/rotate-key`)
  }
}

export class ApiRequestError extends Error {
  status: number
  /**
   * The parsed error body, when there was one (#1701).
   *
   * `message` is `body.error` — a human string — and for most routes that is
   * the whole of it. Some routes answer a refusal with STRUCTURED fields the
   * caller has to branch on rather than read: the agent re-key flow's 409s
   * carry `rekey_id` + `stage` (which re-key is already in flight, and where
   * it stopped) and `residual_atomic` (how much is stranded on the delegate
   * about to be retired). Flattening those to a sentence made the refusal
   * unactionable — the client could tell the user something went wrong, but
   * not offer the one thing that resolves it.
   *
   * Deliberately `unknown`: this is an escape hatch for callers that know
   * their route's contract, not a typed second API surface. Narrow it at the
   * call site. Additive — every existing caller reads `message`/`status` and
   * is unaffected.
   */
  body?: unknown
  constructor(message: string, status: number, body?: unknown) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
    this.body = body
  }
}

export const api = new ApiClient()
