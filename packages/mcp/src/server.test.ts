import { afterEach, describe, expect, it, vi } from 'vitest'
import { HavenClient } from '@haven_ai/sdk'
import { buildMcpServer } from './server.js'

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
})
