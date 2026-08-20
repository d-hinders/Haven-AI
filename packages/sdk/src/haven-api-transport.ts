import { AsyncLocalStorage } from 'node:async_hooks'
import type { HavenClientConfig } from './types.js'
import { HavenApiError } from './types.js'

const DEFAULT_BASE_URL = 'http://localhost:3001'
const DEFAULT_REQUEST_TIMEOUT = 30_000

type HavenApiTransportConfig = Pick<
  HavenClientConfig,
  'apiKey' | 'baseUrl' | 'requestTimeout' | 'defaultHeaders'
>

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
  private readonly requestContext = new AsyncLocalStorage<{ headers: Record<string, string> }>()

  constructor(config: HavenApiTransportConfig) {
    this.apiKey = config.apiKey
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.requestTimeout = config.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT
    this.defaultHeaders = { ...(config.defaultHeaders ?? {}) }
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
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })

      const data = await res.json()

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
