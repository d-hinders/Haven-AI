import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HavenClient } from '@haven_ai/sdk'
import { buildMcpServer, createHavenMcpServer } from './server.js'

const baseUrl = 'https://haven.example'

interface CapturedRequest {
  url: string
  headers: Record<string, string>
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function readToolByName(server: any, name: string): { handler: (args: unknown) => Promise<unknown> } {
  // The MCP server keeps its registered tools in an internal map. We pull
  // the registered callback out so we can dispatch through the same wrapper
  // the StdioServerTransport would.
  const tools = server._registeredTools ?? server.tools ?? server._tools
  // McpServer in @modelcontextprotocol/sdk exposes a `request` helper, but
  // for unit-testing the header wrapper it's enough to invoke the callback
  // we registered via the public `tool(...)` API. We grab it from the
  // server's own bookkeeping.
  if (tools instanceof Map) {
    const entry = tools.get(name)
    if (entry) {
      return { handler: entry.callback ?? entry.handler ?? entry }
    }
  }
  if (tools && typeof tools === 'object') {
    const entry = (tools as Record<string, any>)[name]
    if (entry) {
      return { handler: entry.callback ?? entry.handler ?? entry }
    }
  }
  throw new Error(`Tool ${name} not registered on this server instance`)
}

describe('Haven MCP server dispatch', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('tags Haven API calls with X-Haven-MCP-Tool for the dispatched tool', async () => {
    const captured: CapturedRequest[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const headers: Record<string, string> = {}
      const raw = init?.headers
      if (raw instanceof Headers) {
        raw.forEach((value, key) => { headers[key.toLowerCase()] = value })
      } else if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw as Record<string, string>)) {
          headers[k.toLowerCase()] = v
        }
      }
      captured.push({ url: String(url), headers })

      if (String(url).endsWith('/agents/me')) {
        return jsonResponse({
          id: 'agt_1',
          name: 'Test',
          delegate_address: '0xdeadbeef',
          safe_address: '0xsafe',
          chain_id: 100,
          status: 'active',
        })
      }
      return jsonResponse({})
    })

    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl })
    const server = buildMcpServer(haven)

    const tool = readToolByName(server as any, 'haven_get_agent')
    await tool.handler({})

    expect(captured.length).toBeGreaterThan(0)
    const havenCall = captured.find((c) => c.url.startsWith(baseUrl))
    expect(havenCall).toBeDefined()
    expect(havenCall?.headers['x-haven-mcp-tool']).toBe('haven_get_agent')
  })

  it('builds from split identity and signer credentials without env vars', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-mcp-split-server-'))
    const identityPath = join(dir, 'identity.json')
    const signerPath = join(dir, 'signer.json')
    await writeFile(identityPath, JSON.stringify({
      api_key: 'sk_agent_split',
      api_url: baseUrl,
      agent_id: 'agent-1',
      safe_address: '0xSafe',
      chain_id: 100,
    }))
    await writeFile(signerPath, JSON.stringify({
      delegate_key: `0x${'11'.repeat(32)}`,
      delegate_address: '0x1111111111111111111111111111111111111111',
    }))
    await chmod(identityPath, 0o600)
    await chmod(signerPath, 0o600)

    const server = await createHavenMcpServer({ identityPath, signerPath, skipConsent: true })

    expect(readToolByName(server as any, 'haven_get_agent')).toBeDefined()
  })

  it('keeps HAVEN_CREDENTIALS support through the server entrypoint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'haven-mcp-env-server-'))
    const credentialsPath = join(dir, 'agent.json')
    const originalCredentials = process.env.HAVEN_CREDENTIALS
    await writeFile(credentialsPath, JSON.stringify({
      api_key: 'sk_agent_env',
      api_url: baseUrl,
      delegate_key: `0x${'22'.repeat(32)}`,
    }))
    await chmod(credentialsPath, 0o600)

    try {
      process.env.HAVEN_CREDENTIALS = credentialsPath
      const server = await createHavenMcpServer({ skipConsent: true })

      expect(readToolByName(server as any, 'haven_get_agent')).toBeDefined()
    } finally {
      if (originalCredentials === undefined) {
        delete process.env.HAVEN_CREDENTIALS
      } else {
        process.env.HAVEN_CREDENTIALS = originalCredentials
      }
    }
  })

  it('clears the X-Haven-MCP-Tool header after dispatch so later calls are not mis-attributed', async () => {
    const captured: CapturedRequest[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const headers: Record<string, string> = {}
      const raw = init?.headers
      if (raw && typeof raw === 'object' && !(raw instanceof Headers)) {
        for (const [k, v] of Object.entries(raw as Record<string, string>)) {
          headers[k.toLowerCase()] = v
        }
      }
      captured.push({ url: String(url), headers })
      return jsonResponse({})
    })

    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl })
    const server = buildMcpServer(haven)
    const tool = readToolByName(server as any, 'haven_get_agent')
    await tool.handler({})

    // Direct call outside the dispatch wrapper must not carry the header.
    await haven.getAgent()

    const havenCalls = captured.filter((c) => c.url.startsWith(baseUrl))
    expect(havenCalls.length).toBeGreaterThanOrEqual(2)
    expect(havenCalls[0].headers['x-haven-mcp-tool']).toBe('haven_get_agent')
    expect(havenCalls[havenCalls.length - 1].headers['x-haven-mcp-tool']).toBeUndefined()
  })

  it('attributes concurrent tool dispatches to the correct tool name without cross-talk', async () => {
    // Regression for PR #176 review P1: a previous implementation mutated
    // shared client state to set the header, so two overlapping dispatches
    // could overwrite each other and produce mis-attributed audit rows.
    // The current implementation uses AsyncLocalStorage; this test exercises
    // two dispatches whose fetch calls *interleave* to prove the contexts
    // stay isolated.
    let release1: () => void = () => {}
    const gate1 = new Promise<void>((r) => { release1 = r })

    const captured: Array<{ tool: string | undefined; gate: 'first' | 'second' }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const headers: Record<string, string> = {}
      const raw = init?.headers
      if (raw && typeof raw === 'object' && !(raw instanceof Headers)) {
        for (const [k, v] of Object.entries(raw as Record<string, string>)) {
          headers[k.toLowerCase()] = v
        }
      }
      const tool = headers['x-haven-mcp-tool']
      if (tool === 'haven_get_agent') {
        // Park this request until the second dispatch has started.
        await gate1
        captured.push({ tool, gate: 'first' })
      } else if (tool === 'haven_get_allowances') {
        captured.push({ tool, gate: 'second' })
        // Let the first request proceed only after we've recorded the second.
        release1()
      }
      return jsonResponse({})
    })

    const haven = new HavenClient({ apiKey: 'sk_agent_test', baseUrl })
    const server = buildMcpServer(haven)
    const first = readToolByName(server as any, 'haven_get_agent')
    const second = readToolByName(server as any, 'haven_get_allowances')

    const firstP = first.handler({})
    // Let the first dispatch reach the gated fetch before we kick off the second.
    await Promise.resolve()
    const secondP = second.handler({})
    await Promise.all([firstP, secondP])

    expect(captured).toContainEqual({ tool: 'haven_get_agent', gate: 'first' })
    expect(captured).toContainEqual({ tool: 'haven_get_allowances', gate: 'second' })
    // Each captured row's tool name matches the dispatch — no cross-talk.
    for (const row of captured) {
      expect(row.tool).toBe(row.gate === 'first' ? 'haven_get_agent' : 'haven_get_allowances')
    }
  })
})
