import { afterEach, describe, expect, it, vi } from 'vitest'
import { HavenApiTransport } from './haven-api-transport.js'
import { HavenApiError } from './types.js'

interface FetchCall {
  url: string
  init: RequestInit
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function headersOf(call: FetchCall): Headers {
  return new Headers(call.init.headers)
}

function installFetch(
  handler: (call: FetchCall) => Response | Promise<Response>,
): FetchCall[] {
  const calls: FetchCall[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const call = { url, init }
    calls.push(call)
    return handler(call)
  }))
  return calls
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('HavenApiTransport request wire contract', () => {
  it('normalizes the base URL, clones defaults, and preserves exact header precedence', async () => {
    const calls = installFetch(() => json({ id: 'agent-1' }))
    const defaults = {
      'Content-Type': 'application/vnd.haven+json',
      'Authorization': 'Default authorization',
      'X-Default': 'configured',
      'X-Precedence': 'default',
    }
    const transport = new HavenApiTransport({
      apiKey: 'sk_agent_test',
      baseUrl: 'https://haven.test///',
      defaultHeaders: defaults,
    })
    defaults['X-Default'] = 'mutated-after-construction'

    await expect(transport.withRequestContext(
      { 'Authorization': 'Scoped authorization', 'X-Precedence': 'context', 'X-Context': 'tool' },
      () => transport.get<{ id: string }>('/machine-payments/agent'),
    )).resolves.toEqual({ id: 'agent-1' })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://haven.test/machine-payments/agent')
    expect(calls[0].init.method).toBe('GET')
    expect(calls[0].init.body).toBeUndefined()
    const headers = headersOf(calls[0])
    expect(headers.get('content-type')).toBe('application/vnd.haven+json')
    expect(headers.get('authorization')).toBe('Scoped authorization')
    expect(headers.get('x-default')).toBe('configured')
    expect(headers.get('x-precedence')).toBe('context')
    expect(headers.get('x-context')).toBe('tool')
  })

  it('uses the documented default base URL and JSON-encodes POST bodies, including an empty object', async () => {
    const calls = installFetch((call) => json({ call: calls.length, body: call.init.body ?? null }))
    const transport = new HavenApiTransport({ apiKey: 'sk_agent_test' })

    await expect(transport.post('/payments', { amount: '1', nested: { ok: true } }))
      .resolves.toEqual({ call: 1, body: '{"amount":"1","nested":{"ok":true}}' })
    await expect(transport.post('/machine-payments/sweep/prepare', {}))
      .resolves.toEqual({ call: 2, body: '{}' })

    expect(calls.map((call) => [call.url, call.init.method, call.init.body])).toEqual([
      [
        'http://localhost:3001/payments',
        'POST',
        '{"amount":"1","nested":{"ok":true}}',
      ],
      ['http://localhost:3001/machine-payments/sweep/prepare', 'POST', '{}'],
    ])
    for (const call of calls) {
      const headers = headersOf(call)
      expect(headers.get('content-type')).toBe('application/json')
      expect(headers.get('authorization')).toBe('Bearer sk_agent_test')
    }
  })

  it('isolates concurrent scopes per instance and replaces rather than merges a nested scope', async () => {
    const releases = new Map<string, () => void>()
    const calls = installFetch((call) => new Promise<Response>((resolve) => {
      const requestId = headersOf(call).get('x-request') ?? 'unscoped'
      releases.set(requestId, () => resolve(json({ requestId })))
    }))
    const first = new HavenApiTransport({ apiKey: 'first', baseUrl: 'https://haven.test' })
    const second = new HavenApiTransport({ apiKey: 'second', baseUrl: 'https://haven.test' })

    const firstPending = first.withRequestContext(
      { 'X-Request': 'first', 'X-Outer': 'outer' },
      async () => {
        const outer = first.get('/outer')
        const inner = first.withRequestContext(
          { 'X-Request': 'inner', 'X-Inner': 'inner' },
          () => first.get('/inner'),
        )
        return Promise.all([outer, inner])
      },
    )
    const secondPending = second.withRequestContext(
      { 'X-Request': 'second' },
      () => second.get('/second'),
    )

    expect(calls).toHaveLength(3)
    const byPath = new Map(calls.map((call) => [new URL(call.url).pathname, call]))
    expect(headersOf(byPath.get('/outer')!).get('x-outer')).toBe('outer')
    expect(headersOf(byPath.get('/inner')!).get('x-inner')).toBe('inner')
    expect(headersOf(byPath.get('/inner')!).get('x-outer')).toBeNull()
    expect(headersOf(byPath.get('/second')!).get('authorization')).toBe('Bearer second')
    expect(headersOf(byPath.get('/second')!).get('x-outer')).toBeNull()

    releases.get('inner')?.()
    releases.get('second')?.()
    releases.get('first')?.()
    await expect(firstPending).resolves.toEqual([
      { requestId: 'first' },
      { requestId: 'inner' },
    ])
    await expect(secondPending).resolves.toEqual({ requestId: 'second' })
  })

  it('clears the request timer after a successful response', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | null | undefined
    installFetch((call) => {
      signal = call.init.signal
      return json({ ok: true })
    })
    const transport = new HavenApiTransport({
      apiKey: 'sk_agent_test',
      requestTimeout: 30_000,
    })

    await expect(transport.get('/health')).resolves.toEqual({ ok: true })
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(signal?.aborted).toBe(false)
  })
})

describe('HavenApiTransport HavenApiError compatibility', () => {
  it.each([
    {
      name: 'error plus plural details',
      status: 502,
      body: { error: 'On-chain execution failed', details: 'transfer exceeds allowance' },
      message: 'On-chain execution failed: transfer exceeds allowance',
    },
    {
      name: 'singular detail',
      status: 403,
      body: { error: 'agent_paused', detail: 'Resume the agent in Haven.' },
      message: 'agent_paused: Resume the agent in Haven.',
    },
    {
      name: 'object-shaped details',
      status: 422,
      body: { error: 'Validation failed', details: { field: 'amount' } },
      message: 'Validation failed: {"field":"amount"}',
    },
    {
      name: 'details without an error',
      status: 409,
      body: { details: 'Already claimed' },
      message: 'Already claimed',
    },
    {
      name: 'fallback message',
      status: 500,
      body: { unexpected: true },
      message: 'API request failed',
    },
  ])('preserves $name parsing and the original response body', async ({ status, body, message }) => {
    installFetch(() => json(body, status))
    const transport = new HavenApiTransport({ apiKey: 'sk_agent_test' })

    const error = await transport.get('/failure').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(HavenApiError)
    expect(error).toMatchObject({
      name: 'HavenApiError',
      code: 'API_ERROR',
      statusCode: status,
      paymentId: undefined,
      message,
      body,
    })
  })

  it('passes through an existing HavenApiError unchanged', async () => {
    const original = new HavenApiError('upstream refusal', 418, { reason: 'teapot' }, 'pay-1')
    installFetch(async () => { throw original })
    const transport = new HavenApiTransport({ apiKey: 'sk_agent_test' })

    await expect(transport.get('/failure')).rejects.toBe(original)
  })

  it.each([
    { thrown: new Error('socket closed'), rendered: 'socket closed' },
    { thrown: 'string failure', rendered: 'string failure' },
  ])('normalizes a transport failure to status 0 ($rendered)', async ({ thrown, rendered }) => {
    installFetch(async () => { throw thrown })
    const transport = new HavenApiTransport({ apiKey: 'sk_agent_test' })

    await expect(transport.get('/agent')).rejects.toMatchObject({
      name: 'HavenApiError',
      code: 'API_ERROR',
      statusCode: 0,
      body: undefined,
      message: `Request to /agent failed: ${rendered}`,
    })
  })

  it('normalizes response JSON parsing failure through the same status-0 path', async () => {
    installFetch(() => new Response('not json', { status: 200 }))
    const transport = new HavenApiTransport({ apiKey: 'sk_agent_test' })

    await expect(transport.get('/malformed')).rejects.toMatchObject({
      name: 'HavenApiError',
      statusCode: 0,
      message: expect.stringMatching(/^Request to \/malformed failed:/),
    })
  })

  it('aborts at requestTimeout and preserves the existing 408 timeout shape', async () => {
    installFetch((call) => new Promise<Response>((_resolve, reject) => {
      call.init.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted', 'AbortError'))
      })
    }))
    const transport = new HavenApiTransport({ apiKey: 'sk_agent_test', requestTimeout: 10 })

    await expect(transport.get('/slow')).rejects.toMatchObject({
      name: 'HavenApiError',
      code: 'API_ERROR',
      statusCode: 408,
      paymentId: undefined,
      body: undefined,
      message: 'Request to /slow timed out',
    })
  })

  it('continues to classify any AbortError as a request timeout', async () => {
    installFetch(async () => {
      throw new DOMException('aborted elsewhere', 'AbortError')
    })
    const transport = new HavenApiTransport({
      apiKey: 'sk_agent_test',
      requestTimeout: 60_000,
    })

    await expect(transport.get('/aborted')).rejects.toMatchObject({
      statusCode: 408,
      message: 'Request to /aborted timed out',
    })
  })
})
