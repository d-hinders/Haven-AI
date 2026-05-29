import { describe, expect, it, vi } from 'vitest'
import {
  buildHostedConnectSnippet,
  HOSTED_CLIENT_OPTIONS,
  hasDeepLink,
  probeHostedConnection,
  resolveHostedMcpUrl,
  type HostedClientId,
} from '@/lib/hosted-connect'
import { buildAgentCredential } from '@/lib/agent-credential'
import type { HandoffInput } from '@/lib/agent-handoff'

const API_KEY = 'sk_agent_TESTKEY_UNIT'
const DELEGATE_KEY = '0xPRIVATEKEY_NEVERREAL_FOR_UNIT'

const INPUT: HandoffInput = {
  agent: {
    id: 'agt_test',
    name: 'A',
    delegateAddress: '0xaDA083091fAd5dE77370716b1BA7AC76C11f0b8b',
    safeAddress: '0xbf35beb0f587db2527b64e58d61f78bbf840860f',
    chainId: 100,
  },
  policy: { allowances: [] },
  credentials: { apiKey: API_KEY, delegatePrivateKey: DELEGATE_KEY },
}

function credential() {
  return buildAgentCredential(INPUT).json
}

describe('resolveHostedMcpUrl', () => {
  it('honours an explicit override', () => {
    expect(resolveHostedMcpUrl('https://override.test/v2/')).toBe('https://override.test/v2')
  })

  it('falls back to the production default when no override is given', () => {
    // Don't poke process.env (mutating it leaks across tests); pass undefined.
    expect(resolveHostedMcpUrl(undefined as unknown as string)).toMatch(/^https:\/\/.+/)
  })
})

describe('buildHostedConnectSnippet', () => {
  const HOST = 'https://mcp.test.example/v1'

  for (const client of HOSTED_CLIENT_OPTIONS.map((o) => o.id) as HostedClientId[]) {
    it(`includes the api key and URL but never the delegate key for ${client}`, () => {
      const snippet = buildHostedConnectSnippet(client, credential(), HOST)
      expect(snippet.code).toContain(API_KEY)
      expect(snippet.code).toContain(HOST)
      // Custody invariant at the snippet boundary: the delegate key never
      // appears in the box-1 connect command.
      expect(snippet.code).not.toContain(DELEGATE_KEY)
    })
  }

  it('emits a `claude mcp add` shell command for Claude Code', () => {
    const s = buildHostedConnectSnippet('claude-code', credential(), HOST)
    expect(s.language).toBe('bash')
    expect(s.code).toMatch(/claude mcp add --transport http haven/)
    expect(s.code).toContain(`Bearer ${API_KEY}`)
  })

  it('emits the JSON MCP-config block for Claude Desktop and Cursor', () => {
    for (const c of ['claude-desktop', 'cursor'] as HostedClientId[]) {
      const s = buildHostedConnectSnippet(c, credential(), HOST)
      expect(s.language).toBe('json')
      const parsed = JSON.parse(s.code) as {
        mcpServers: { haven: { url: string; headers: Record<string, string> } }
      }
      expect(parsed.mcpServers.haven.url).toBe(HOST)
      expect(parsed.mcpServers.haven.headers.Authorization).toBe(`Bearer ${API_KEY}`)
    }
  })

  it('attaches platform-specific config paths to the Claude Desktop snippet', () => {
    // The claude:// deep link doesn't exist yet, so Claude Desktop falls back
    // to the manual config-file paste path. Users need the OS-specific path
    // surfaced inline — otherwise they have to leave the modal to find it.
    const s = buildHostedConnectSnippet('claude-desktop', credential(), HOST)
    expect(s.destinationPaths).toBeDefined()
    const labels = (s.destinationPaths ?? []).map((p) => p.label).sort()
    expect(labels).toEqual(['Linux', 'Windows', 'macOS'].sort())
    const macPath = s.destinationPaths?.find((p) => p.label === 'macOS')?.path
    expect(macPath).toContain('claude_desktop_config.json')
  })

  it('attaches a restart-required postNote to the Claude Code snippet', () => {
    // Claude Code caches the MCP server list at session start, so the
    // running session won't pick up the new tools until it's restarted.
    const s = buildHostedConnectSnippet('claude-code', credential(), HOST)
    expect(s.postNote).toBeDefined()
    expect(s.postNote!).toMatch(/restart|session start|run `?claude`?/i)
  })

  it('does not attach a postNote or destinationPaths to runtimes that do not need one', () => {
    for (const c of ['cursor', 'other'] as HostedClientId[]) {
      const s = buildHostedConnectSnippet(c, credential(), HOST)
      expect(s.postNote).toBeUndefined()
      expect(s.destinationPaths).toBeUndefined()
    }
  })
})

describe('hasDeepLink', () => {
  // The claude:// scheme is not registered by Claude Desktop today, so the
  // "Add to Claude" button silently no-ops. Until Anthropic ships a real
  // handler, only Cursor's deep link works.
  it('reports Cursor as the only runtime with a working deep link', () => {
    expect(hasDeepLink('cursor')).toBe(true)
    expect(hasDeepLink('claude-desktop')).toBe(false)
    expect(hasDeepLink('claude-code')).toBe(false)
    expect(hasDeepLink('other')).toBe(false)
  })
})

describe('probeHostedConnection', () => {
  const HOST = 'https://mcp.test.example/v1'
  const KEY = 'sk_agent_PROBE'

  function fakeFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
    return vi.fn(impl) as unknown as typeof fetch
  }

  it('returns ok with the tool count when the server lists tools', async () => {
    const fetchImpl = fakeFetch(async () =>
      new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'a' }, { name: 'b' }] } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    const result = await probeHostedConnection(KEY, HOST, fetchImpl)
    expect(result.status).toBe('ok')
    expect(result.toolCount).toBe(2)
    expect(result.detail).toMatch(/2 tools/)
  })

  it('parses SSE-framed tools/list responses', async () => {
    // The streamable-HTTP transport can negotiate text/event-stream; the
    // probe must still recover the JSON-RPC envelope from the last data: line.
    const body =
      'event: message\n' +
      'data: ' +
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'haven_pay' }] } }) +
      '\n\n'
    const fetchImpl = fakeFetch(async () =>
      new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    )

    const result = await probeHostedConnection(KEY, HOST, fetchImpl)
    expect(result.status).toBe('ok')
    expect(result.toolCount).toBe(1)
  })

  it('maps 401 to unauthorized', async () => {
    const fetchImpl = fakeFetch(async () => new Response('', { status: 401 }))
    const result = await probeHostedConnection(KEY, HOST, fetchImpl)
    expect(result.status).toBe('unauthorized')
    expect(result.detail).toMatch(/token|re-issue|reject/i)
  })

  it('maps 403 to unauthorized', async () => {
    const fetchImpl = fakeFetch(async () => new Response('', { status: 403 }))
    const result = await probeHostedConnection(KEY, HOST, fetchImpl)
    expect(result.status).toBe('unauthorized')
  })

  it('maps fetch rejection (CORS, DNS, offline) to network-error', async () => {
    const fetchImpl = fakeFetch(async () => {
      throw new TypeError('Failed to fetch')
    })
    const result = await probeHostedConnection(KEY, HOST, fetchImpl)
    expect(result.status).toBe('network-error')
    expect(result.detail).toMatch(/fetch|reach/i)
  })

  it('maps a non-error 5xx to bad-response', async () => {
    const fetchImpl = fakeFetch(async () => new Response('boom', { status: 502 }))
    const result = await probeHostedConnection(KEY, HOST, fetchImpl)
    expect(result.status).toBe('bad-response')
    expect(result.detail).toMatch(/502/)
  })

  it('flags a JSON-RPC error envelope as bad-response', async () => {
    const fetchImpl = fakeFetch(async () =>
      new Response(
        JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'boom' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    const result = await probeHostedConnection(KEY, HOST, fetchImpl)
    expect(result.status).toBe('bad-response')
    expect(result.detail).toMatch(/boom/)
  })

  it('sends the bearer header on the probe', async () => {
    const seen: RequestInit[] = []
    const fetchImpl = fakeFetch(async (_url, init) => {
      seen.push(init ?? {})
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    await probeHostedConnection(KEY, HOST, fetchImpl)
    const headers = (seen[0]?.headers ?? {}) as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${KEY}`)
  })
})
