/**
 * #3303: the connector names itself and its version in `X-Haven-Client` on
 * every Haven API request, so the backend can tell an outdated connector what
 * to run.
 */
import { createRequire } from 'node:module'
import { expect, it } from 'vitest'
import { createConnectApiClient } from './api.js'
import { CONNECTOR_CLIENT_IDENTITY, CONNECTOR_VERSION } from './runtime.js'

function recorder() {
  const seen: Array<{ path: string; client: string | null; auth: string | null }> = []
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const h = new Headers(init?.headers)
    seen.push({ path: new URL(String(url)).pathname, client: h.get('x-haven-client'), auth: h.get('authorization') })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  return { seen, fetchImpl }
}

it('CONNECTOR_VERSION is this package\'s version and CONNECTOR_CLIENT_IDENTITY names it', () => {
  const pkg = createRequire(import.meta.url)('../package.json') as { version: string }
  expect(CONNECTOR_VERSION).toBe(pkg.version)
  expect(CONNECTOR_CLIENT_IDENTITY).toBe(`@haven_ai/connect/${pkg.version}`)
})

it('every request the client makes carries the identity, beside (not instead of) its own headers', async () => {
  const { seen, fetchImpl } = recorder()
  const api = createConnectApiClient('https://haven.test/', fetchImpl, CONNECTOR_CLIENT_IDENTITY)
  await api.resolveSetup({ setupToken: 'st', connectorVersion: CONNECTOR_VERSION } as never).catch(() => undefined)
  await api.getAgentIdentity('sk_agent_x').catch(() => undefined)
  expect(seen.length).toBe(2)
  for (const call of seen) expect(call.client).toBe(CONNECTOR_CLIENT_IDENTITY)
  // The agent read keeps its own Authorization header.
  expect(seen[1].auth).toBe('Bearer sk_agent_x')
})

it('sends no identity when none is given — the parameter is the only source', async () => {
  const { seen, fetchImpl } = recorder()
  await createConnectApiClient('https://haven.test', fetchImpl).getAgentIdentity('sk_agent_x').catch(() => undefined)
  expect(seen[0].client).toBeNull()
})
