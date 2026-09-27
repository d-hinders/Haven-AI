/**
 * #3303: the hosted server names itself on Haven API requests. It is not one
 * of the five published packages, so the backend's compat table exempts it —
 * this pins that it does not read as a bare `@haven_ai/sdk` embedder.
 */
import { afterEach, expect, it, vi } from 'vitest'
import { createHostedHavenClient, HOSTED_SERVER_VERSION } from './server.js'

afterEach(() => {
  vi.restoreAllMocks()
})

it('sends X-Haven-Client: @haven_ai/mcp-server/<HOSTED_SERVER_VERSION>', async () => {
  const seen: Array<string | null> = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    seen.push(new Headers(init?.headers).get('x-haven-client'))
    return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  const client = createHostedHavenClient({ apiKey: 'sk_agent_hosted', baseUrl: 'https://haven.example' })
  await client.getAgent().catch(() => undefined)
  expect(seen.length).toBeGreaterThan(0)
  expect(new Set(seen)).toEqual(new Set([`@haven_ai/mcp-server/${HOSTED_SERVER_VERSION}`]))
})
