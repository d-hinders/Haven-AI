import { afterEach, describe, expect, it, vi } from 'vitest'
import { HavenClient } from './client.js'
import { HavenApiError, X402UnexpectedStatusError } from './types.js'
// MerchantTimeoutError asserted structurally above (name/merchantErrorCode).

// #1300: every merchant-facing fetch is bounded. Haven API calls always were
// (request()'s AbortController); the merchant probes called bare fetch, so a
// slow-loris merchant could hold a tool call open forever — and since #1271
// the probe can run twice per invocation.

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('merchant fetch timeout (#1300)', () => {
  it('aborts a hanging merchant probe and names the URL in a clear 504', async () => {
    // A fetch that respects its AbortSignal but otherwise never resolves —
    // the slow-loris shape. If the implementation stops passing a timeout
    // signal, this promise never settles and the test times out (the
    // mutation proof for the bound itself).
    vi.stubGlobal('fetch', (_url: string, init: RequestInit = {}) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal!.reason))
      }),
    )
    const client = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test', merchantTimeout: 50 })

    await expect(client.quoteX402('http://merchant.test/mcp')).rejects.toMatchObject({
      name: 'MerchantTimeoutError',
      statusCode: 504,
      merchantErrorCode: 'merchant_timeout',
      message: expect.stringMatching(/timed out after 50ms.*http:\/\/merchant\.test\/mcp/),
    })
  }, 5_000)

  it('a caller-supplied abort still wins and is NOT rewritten as a timeout', async () => {
    vi.stubGlobal('fetch', (_url: string, init: RequestInit = {}) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal!.reason))
      }),
    )
    const client = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test', merchantTimeout: 60_000 })
    const controller = new AbortController()
    const pending = client.quoteX402('http://merchant.test/mcp', { signal: controller.signal })
    controller.abort(new Error('caller cancelled'))

    await expect(pending).rejects.toThrow('caller cancelled')
  }, 5_000)

  it('a non-402 answer throws the TYPED X402UnexpectedStatusError (#1271 discovery keys on it)', async () => {
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }),
    )
    const client = new HavenClient({ apiKey: 'sk_agent_test', baseUrl: 'http://haven.test' })

    const err = await client.quoteX402('http://merchant.test/').catch((e) => e)
    expect(err).toBeInstanceOf(X402UnexpectedStatusError)
    expect(err).toBeInstanceOf(HavenApiError)
    expect((err as X402UnexpectedStatusError).x402ErrorCode).toBe('unexpected_non_402_status')
    expect((err as HavenApiError).statusCode).toBe(404)
  })
})


describe('merchant timeout calibration (#1300 review)', () => {
  it('the default tolerates the protocol contract: >= merchant maxTimeoutSeconds (300s)', async () => {
    // The demo merchant advertises maxTimeoutSeconds: 300 and its synchronous
    // settlement wait inherits viem's 180s default — a client default below
    // either aborts settlements the contract itself calls normal.
    const clientSrc = (await import('node:fs')).readFileSync(
      new URL('./client.ts', import.meta.url),
      'utf8',
    )
    const m = clientSrc.match(/DEFAULT_MERCHANT_TIMEOUT = ([0-9_]+)/)
    expect(m).toBeTruthy()
    expect(Number(m![1].replaceAll('_', ''))).toBeGreaterThanOrEqual(300_000)
  })
})
