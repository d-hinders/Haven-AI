const BASE_URL = '/api'

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

class ApiClient {
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
      'Content-Type': 'application/json',
      ...((options.headers as Record<string, string>) ?? {}),
    }

    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    const response = await fetch(`${BASE_URL}${path}`, {
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

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    })
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'PUT',
      body: body ? JSON.stringify(body) : undefined,
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
