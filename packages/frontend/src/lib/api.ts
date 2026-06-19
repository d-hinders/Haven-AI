const BASE_URL = '/api'
const API_OVERRIDE_STORAGE_KEY = 'haven_api_base_url'

interface ApiError {
  error: string
  statusCode?: number
}

export interface DeployPasskeySafeBody {
  chain_id: number
  salt_nonce?: string
}

export interface DeployPasskeySafeResponse {
  safe_address: string
  tx_hash: string
  chain_id: number
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
}

export interface ExecSafeResponse {
  tx_hash: string
  chain_id: number
}

export function getResolvedApiBaseUrl(): string {
  if (typeof window === 'undefined') {
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
      throw new ApiRequestError(body.error, response.status)
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
      throw new ApiRequestError(body.error, response.status)
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

  deployPasskeySafe(body: DeployPasskeySafeBody): Promise<DeployPasskeySafeResponse> {
    return this.post<DeployPasskeySafeResponse>('/safe/deploy', body)
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
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
  }
}

export const api = new ApiClient()
