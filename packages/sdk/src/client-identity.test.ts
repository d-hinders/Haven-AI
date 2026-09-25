import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HavenApiTransport } from './haven-api-transport.js'
import { HavenClient } from './client.js'
import { HavenApiError } from './types.js'
import {
  HAVEN_CLIENT_HEADER,
  SDK_CLIENT_IDENTITY,
  SDK_VERSION,
  havenClientIdentity,
  readClientUpdate,
  type HavenClientUpdate,
} from './client-identity.js'

const HINT: HavenClientUpdate = {
  package: '@haven_ai/mcp',
  current: '0.4.0-alpha.0',
  recommended: '0.6.0',
  min_version: null,
  required: false,
  upgrade_command: 'npx -y @haven_ai/connect@alpha',
  notes_url: null,
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function installFetch(handler: (url: string) => Response): Headers[] {
  const seen: Headers[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    seen.push(new Headers(init.headers))
    return handler(String(input))
  }))
  return seen
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('X-Haven-Client (#3303)', () => {
  it('SDK_VERSION is this package\'s version — release-bump owns both', () => {
    const pkg = createRequire(import.meta.url)('../package.json') as { version: string }
    expect(SDK_VERSION).toBe(pkg.version)
    expect(SDK_CLIENT_IDENTITY).toBe(`@haven_ai/sdk/${pkg.version}`)
  })

  it('a bare embedder names the SDK on every Haven API request', async () => {
    const seen = installFetch(() => json({ ok: true }))
    const transport = new HavenApiTransport({ apiKey: 'sk_agent_test' })
    await transport.get('/machine-payments/agent')
    await transport.post('/payments', {})
    expect(seen.map((h) => h.get(HAVEN_CLIENT_HEADER))).toEqual([SDK_CLIENT_IDENTITY, SDK_CLIENT_IDENTITY])
  })

  it('an embedding package names itself through clientIdentity, and neither defaultHeaders nor a dispatch context can override it', async () => {
    const seen = installFetch(() => json({ ok: true }))
    const identity = havenClientIdentity('@haven_ai/mcp', '0.4.0-alpha.0')
    const transport = new HavenApiTransport({
      apiKey: 'sk_agent_test',
      clientIdentity: identity,
      defaultHeaders: { [HAVEN_CLIENT_HEADER]: '@haven_ai/sdk/99.0.0' },
    })
    await transport.withRequestContext({ [HAVEN_CLIENT_HEADER]: 'spoofed/1.0.0' }, () => transport.get('/x'))
    expect(seen[0].get(HAVEN_CLIENT_HEADER)).toBe('@haven_ai/mcp/0.4.0-alpha.0')
  })

  it('HavenClient forwards clientIdentity to its transport', async () => {
    const seen = installFetch(() => json({ id: 'agent-1' }))
    const client = new HavenClient({ apiKey: 'sk_agent_test', clientIdentity: '@haven_ai/cli/1.2.3' })
    await client.withRequestContext({}, async () => {
      try {
        await client.getAgent()
      } catch {
        // The response shape is not what this test is about.
      }
    })
    expect(seen[0].get(HAVEN_CLIENT_HEADER)).toBe('@haven_ai/cli/1.2.3')
  })
})

describe('client_update capture (#3303)', () => {
  it('scopes the hint to the dispatch whose request received it', async () => {
    installFetch((url) => json(url.endsWith('/behind') ? { ok: true, client_update: HINT } : { ok: true }))
    const transport = new HavenApiTransport({ apiKey: 'sk_agent_test' })

    const inBehind = await transport.withRequestContext({}, async () => {
      await transport.get('/behind')
      return transport.clientUpdate()
    })
    const inCurrent = await transport.withRequestContext({}, async () => {
      await transport.get('/current')
      return transport.clientUpdate()
    })
    expect(inBehind).toEqual(HINT)
    expect(inCurrent).toBeUndefined()
    // Outside any dispatch: the latest one seen.
    expect(transport.clientUpdate()).toEqual(HINT)
  })

  it('records the hint from a refusal too, and the refusal body still reaches the HavenApiError', async () => {
    const refusal = {
      error: 'outdated',
      error_code: 'client_outdated',
      client_update: { ...HINT, required: true, min_version: '0.5.0' },
    }
    installFetch(() => json(refusal, 426))
    const transport = new HavenApiTransport({ apiKey: 'sk_agent_test' })
    const result = await transport.withRequestContext({}, async () => {
      const err = await transport.post('/payments', {}).catch((e: unknown) => e)
      return { err, hint: transport.clientUpdate() }
    })
    expect(result.err).toBeInstanceOf(HavenApiError)
    expect((result.err as HavenApiError).statusCode).toBe(426)
    expect((result.err as HavenApiError).body).toEqual(refusal)
    expect(result.hint?.required).toBe(true)
  })

  it('readClientUpdate refuses anything missing a required field', () => {
    expect(readClientUpdate(HINT)).toEqual(HINT)
    expect(readClientUpdate({ ...HINT, required: 'yes' })).toBeUndefined()
    expect(readClientUpdate({ package: '@haven_ai/mcp' })).toBeUndefined()
    expect(readClientUpdate([HINT])).toBeUndefined()
    expect(readClientUpdate(null)).toBeUndefined()
  })
})
