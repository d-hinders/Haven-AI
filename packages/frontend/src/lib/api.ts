const BASE_URL = '/api'
const API_OVERRIDE_STORAGE_KEY = 'haven_api_base_url'

interface ApiError {
  error: string
  statusCode?: number
}

export interface EnrollPasskeyBody {
  credential_id: string
  public_key_x: `0x${string}`
  public_key_y: `0x${string}`
  chain_id: number
  raw_attestation_object?: string
}

export interface EnrollPasskeyResponse {
  id: string
  credential_id: string
  signer_address: string
  chain_id: number
}

export interface ListPasskeysResponse {
  passkeys: Array<{
    id: string
    credential_id: string
    signer_address: string
    chain_id: number
    safe_address: string | null
    created_at: string
  }>
}

export interface OwnerAccount {
  id: string
  safe_address: string
  chain_id: number
  name: string
}

export interface OwnerAlias {
  owner_address: string
  name: string | null
  accounts: OwnerAccount[]
}

export interface OwnersResponse {
  owners: OwnerAlias[]
  partialFailure: boolean
  failedSafeIds: string[]
}

export interface UpdateOwnerAliasResponse {
  owner_address: string
  name: string
}

export interface ExecSafeBody {
  chain_id: number
  safe_address: string
  to: string
  value: string
  data: string
  operation: 0 | 1
  safe_tx_gas: string
  base_gas: string
  gas_price: string
  gas_token: string
  refund_receiver: string
  nonce: string
  signatures: string
  /** Which passkey signed — required once an account has a backup (#1229). */
  credential_id?: string
}

export interface ExecSafeResponse {
  tx_hash: string
  chain_id: number
  /**
   * How the relay's own confirmation wait ended (#1754).
   *
   * `'confirmed'` — mined and successful, the 201 this route has always
   * answered. `'pending'` — a 202: the transaction was broadcast, the relay
   * stopped waiting after 120 s, and it may still confirm. That case used to
   * be reported as `502 "Safe execution reverted on-chain"`, which invited a
   * retry of an operation that may already have succeeded.
   *
   * Optional because a frontend deployed against an older backend will not
   * receive it; absence means the same thing `'confirmed'` does, since the
   * only pre-#1754 non-error response was the mined one.
   */
  status?: 'confirmed' | 'pending'
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
  const env = process.env.NEXT_PUBLIC_HAVEN_ENV?.trim().toLowerCase()
  return env != null && env !== '' && env !== 'production' && env !== 'prod'
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

class ApiClient {
  private resolveBaseUrl(): string {
    return getResolvedApiBaseUrl()
  }

  private getToken(): string | null {
    if (typeof window === 'undefined') return null
    return localStorage.getItem('haven_token')
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
      throw new ApiRequestError(body.error, response.status, body)
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

  delete<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'DELETE' })
  }

  enrollPasskey(body: EnrollPasskeyBody): Promise<EnrollPasskeyResponse> {
    return this.post<EnrollPasskeyResponse>('/passkeys', body)
  }

  listPasskeys(): Promise<ListPasskeysResponse> {
    return this.get<ListPasskeysResponse>('/passkeys')
  }

  execSafe(body: ExecSafeBody): Promise<ExecSafeResponse> {
    return this.post<ExecSafeResponse>('/safe/exec', body)
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
