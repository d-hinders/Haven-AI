import { AsyncLocalStorage } from 'node:async_hooks'
import type { HavenClientConfig } from './types.js'
import { HavenApiError } from './types.js'
import {
  HAVEN_CLIENT_HEADER,
  SDK_CLIENT_IDENTITY,
  readClientUpdate,
  type HavenClientUpdate,
} from './client-identity.js'

const DEFAULT_BASE_URL = 'http://localhost:3001'
const DEFAULT_REQUEST_TIMEOUT = 30_000

type HavenApiTransportConfig = Pick<
  HavenClientConfig,
  'apiKey' | 'baseUrl' | 'requestTimeout' | 'defaultHeaders' | 'clientIdentity'
>

/**
 * Per-dispatch state carried through `AsyncLocalStorage`: the extra headers,
 * and the last `client_update` the backend sent during this dispatch (#3303),
 * so an MCP tool result can surface the hint its own requests received.
 */
interface RequestContextStore {
  headers: Record<string, string>
  clientUpdate?: HavenClientUpdate
}

/**
 * Internal Haven-API JSON transport.
 *
 * This module deliberately does not handle merchant requests. Merchant HTTP
 * has separate headers, timeout semantics, and error types in HavenClient.
 * The class is exported only for internal composition and direct tests; it is
 * not part of the package entrypoint.
 */
export class HavenApiTransport {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly requestTimeout: number
  private readonly defaultHeaders: Record<string, string>
  private readonly clientIdentity: string
  private readonly requestContext = new AsyncLocalStorage<RequestContextStore>()
  private lastClientUpdate: HavenClientUpdate | undefined

  constructor(config: HavenApiTransportConfig) {
    this.apiKey = config.apiKey
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.requestTimeout = config.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT
    this.defaultHeaders = { ...(config.defaultHeaders ?? {}) }
    this.clientIdentity = config.clientIdentity ?? SDK_CLIENT_IDENTITY
  }

  /**
   * The newest `client_update` the backend sent (#3303): inside a
   * `withRequestContext` dispatch, the one that dispatch's own requests
   * received; outside one, the latest this transport has seen.
   */
  clientUpdate(): HavenClientUpdate | undefined {
    const store = this.requestContext.getStore()
    return store ? store.clientUpdate : this.lastClientUpdate
  }

  private recordClientUpdate(data: unknown): void {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return
    const hint = readClientUpdate((data as Record<string, unknown>).client_update)
    if (!hint) return
    this.lastClientUpdate = hint
    const store = this.requestContext.getStore()
    if (store) store.clientUpdate = hint
  }

  /** Run `fn` with extra headers scoped to its asynchronous Haven API work. */
  withRequestContext<T>(headers: Record<string, string>, fn: () => Promise<T>): Promise<T> {
    return this.requestContext.run({ headers: { ...headers } }, fn)
  }

  async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.request<T>('POST', path, body)
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path)
  }

  async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.requestTimeout)

    try {
      const contextHeaders = this.requestContext.getStore()?.headers ?? {}
      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          ...this.defaultHeaders,
          ...contextHeaders,
          // Last, so neither `defaultHeaders` nor a dispatch context can
          // misname the client; `clientIdentity` is the one way to set it.
          [HAVEN_CLIENT_HEADER]: this.clientIdentity,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })

      const data = await res.json()
      this.recordClientUpdate(data)

      if (!res.ok) {
        const record = data as Record<string, unknown>
        const errorText = typeof record.error === 'string' ? record.error : undefined
        const rawDetails = record.details ?? record.detail
        const detailsText =
          typeof rawDetails === 'string'
            ? rawDetails
            : rawDetails != null
              ? JSON.stringify(rawDetails)
              : undefined
        const message =
          errorText && detailsText
            ? `${errorText}: ${detailsText}`
            : errorText ?? detailsText ?? 'API request failed'
        throw new HavenApiError(message, res.status, data)
      }

      return data as T
    } catch (err) {
      if (err instanceof HavenApiError) throw err
      if (err instanceof Error && err.name === 'AbortError') {
        throw new HavenApiError(`Request to ${path} timed out`, 408)
      }
      throw new HavenApiError(
        `Request to ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
        0,
      )
    } finally {
      clearTimeout(timeout)
    }
  }
}
