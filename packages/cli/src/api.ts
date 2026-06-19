export class CliApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'CliApiError'
    this.status = status
  }
}

export interface CliApi {
  get<T>(path: string): Promise<T>
  post<T>(path: string, body?: unknown): Promise<T>
  put<T>(path: string, body?: unknown): Promise<T>
  del<T>(path: string): Promise<T>
}

export interface CreateCliApiOptions {
  baseUrl: string
  token?: string
  fetchImpl?: typeof fetch
}

/**
 * Minimal JSON client for the Haven backend. Sends the user JWT as a Bearer
 * token when present, and surfaces backend `{ error }` messages as
 * `CliApiError` so commands can print something human.
 */
export function createCliApi({ baseUrl, token, fetchImpl = fetch }: CreateCliApiOptions): CliApi {
  const root = baseUrl.replace(/\/+$/, '')

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (token) headers.Authorization = `Bearer ${token}`
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    let res: Response
    try {
      res = await fetchImpl(`${root}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    } catch (err) {
      throw new CliApiError(
        `Could not reach Haven at ${root}: ${err instanceof Error ? err.message : String(err)}`,
        0,
      )
    }

    if (res.status === 401) {
      throw new CliApiError('Not authenticated. Run `haven login` first.', 401)
    }

    const text = await res.text()
    const payload = text ? safeParse(text) : undefined

    if (!res.ok) {
      const message =
        (payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
          ? payload.error
          : null) ?? `Request failed (HTTP ${res.status}).`
      throw new CliApiError(message, res.status)
    }

    return payload as T
  }

  return {
    get: <T>(path: string) => request<T>('GET', path),
    post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
    put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
    del: <T>(path: string) => request<T>('DELETE', path),
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
