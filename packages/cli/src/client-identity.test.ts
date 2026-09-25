/**
 * #3303: every Haven API request the CLI makes through its DEFAULT client —
 * the one `run` builds when no `makeApi` is injected — names the CLI and its
 * version in `X-Haven-Client`.
 */
import { createRequire } from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'
import { run, CLI_CLIENT_IDENTITY, CLI_VERSION } from './commands.js'
import { createCliApi } from './api.js'
import type { Session, SessionStore } from './session.js'

const SESSION: Session = { token: 'jwt', apiBaseUrl: 'https://api.test', user: { id: 'u1', email: 'ada@example.com', name: 'Ada' } }

function memoryStore(): SessionStore {
  return { path: '/tmp/session.json', load: async () => SESSION, save: async () => {}, clear: async () => {} }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

it('CLI_VERSION is this package\'s version and CLI_CLIENT_IDENTITY names it', () => {
  const pkg = createRequire(import.meta.url)('../package.json') as { version: string }
  expect(CLI_VERSION).toBe(pkg.version)
  expect(CLI_CLIENT_IDENTITY).toBe(`@haven_ai/cli/${pkg.version}`)
})

it('run\'s default API client sends X-Haven-Client on its Haven API requests', async () => {
  const seen: Array<string | null> = []
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get('x-haven-client'))
    return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
  await run(['agents', 'list', '--json'], { sessionStore: memoryStore(), out: () => {}, err: () => {}, env: {} })
  expect(seen.length).toBeGreaterThan(0)
  expect(new Set(seen)).toEqual(new Set([CLI_CLIENT_IDENTITY]))
})

it('both request shapes (JSON and text) carry it when given, and neither invents one when not', async () => {
  const seen: Array<string | null> = []
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    seen.push(new Headers(init?.headers).get('x-haven-client'))
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  const named = createCliApi({ baseUrl: 'https://api.test', token: 't', fetchImpl, clientIdentity: '@haven_ai/cli/1.0.0' })
  await named.get('/a')
  await named.getText('/b')
  const bare = createCliApi({ baseUrl: 'https://api.test', token: 't', fetchImpl })
  await bare.get('/c')
  expect(seen).toEqual(['@haven_ai/cli/1.0.0', '@haven_ai/cli/1.0.0', null])
})
