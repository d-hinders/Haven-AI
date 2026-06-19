import { describe, expect, it, vi } from 'vitest'
import {
  buildAgentStarterPrompt,
  buildDeepLink,
  buildHostedConnectSnippet,
  buildHostedSetupPrompt,
  HOSTED_CLIENT_REGISTRY,
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
  policy: { allowances: [{ tokenSymbol: 'USDC', amount: '25', resetPeriodMin: 1440 }] },
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

  // Custody invariant: every registered runtime — including any new ones
  // added in the future — must point at the hosted URL but never inline the
  // delegate private key (authority). The loop is the regression net.
  for (const option of HOSTED_CLIENT_REGISTRY) {
    it(`points at the hosted URL but never the delegate key for ${option.id}`, () => {
      const snippet = buildHostedConnectSnippet(option.id, credential(), HOST)
      if (option.id === 'other') {
        // 'other' is the secret-free, file-referenced handoff for custom/SDK
        // runtimes: it references ~/.haven credential files by path so the raw
        // api_key (and delegate key) never appear, keeping secrets out of the
        // custom agent's context. The hosted URL must still be present.
        expect(snippet.code).not.toContain(API_KEY)
      } else {
        expect(snippet.code).toContain(API_KEY)
      }
      // Most runtimes inline the URL. Codex CLI uses an env-var pattern that
      // moves the actual bearer into the shell — that's fine, but the
      // hosted URL must still appear in the snippet so the user knows where
      // their agent is pointed.
      expect(snippet.code).toContain(HOST)
      expect(snippet.code).not.toContain(DELEGATE_KEY)
    })
  }

  it('hands "other" a secret-free, file-referenced snippet (no key in context)', () => {
    // The custom/SDK escape hatch must never inline a secret: custom agents
    // have many memory sinks (context, transcript, memory files, logs) and a
    // key in any of them is a leak. It references the on-disk credential files
    // the connector always writes, plus the hosted URL and the local signer.
    const s = buildHostedConnectSnippet('other', credential(), HOST)
    expect(s.code).not.toContain(API_KEY)
    expect(s.code).not.toContain(DELEGATE_KEY)
    expect(s.code).toContain(HOST)
    expect(s.code).toContain('~/.haven/agents/agt_test/identity.json')
    expect(s.code).toContain('~/.haven/agents/agt_test/signer.json')
    // Names the local signer so authority wiring isn't left as an exercise.
    expect(s.code).toMatch(/@haven_ai\/signer/)
  })

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

  it('emits VS Code\'s `servers.<name>.type = "http"` shape', () => {
    // VS Code's MCP config uses `servers` (not `mcpServers`) and requires
    // an explicit `type: "http"`. Getting this wrong silently puts the
    // server in stdio mode and produces "Failed to start" with no clue why.
    const s = buildHostedConnectSnippet('vscode', credential(), HOST)
    expect(s.language).toBe('json')
    const parsed = JSON.parse(s.code) as {
      servers: { haven: { type: string; url: string; headers: Record<string, string> } }
    }
    expect(parsed.servers.haven.type).toBe('http')
    expect(parsed.servers.haven.url).toBe(HOST)
    expect(parsed.servers.haven.headers.Authorization).toBe(`Bearer ${API_KEY}`)
  })

  it('emits Windsurf\'s `serverUrl` (not `url`) shape', () => {
    // Windsurf is the odd one out among the JSON runtimes — its MCP config
    // expects `serverUrl`, not `url`. Easy to miss in a copy-from-Cursor.
    const s = buildHostedConnectSnippet('windsurf', credential(), HOST)
    const parsed = JSON.parse(s.code) as {
      mcpServers: { haven: { serverUrl: string; headers: Record<string, string> } }
    }
    expect(parsed.mcpServers.haven.serverUrl).toBe(HOST)
    expect(parsed.mcpServers.haven.headers.Authorization).toBe(`Bearer ${API_KEY}`)
  })

  it('emits Continue.dev\'s YAML shape with type: streamable-http', () => {
    const s = buildHostedConnectSnippet('continue', credential(), HOST)
    expect(s.language).toBe('yaml')
    expect(s.code).toMatch(/type:\s*streamable-http/)
    expect(s.code).toMatch(/url:\s*https:\/\/mcp\.test\.example\/v1/)
    expect(s.code).toContain(`Authorization: Bearer ${API_KEY}`)
  })

  it('emits Cline\'s JSON shape with the saoudrizwan settings path', () => {
    const s = buildHostedConnectSnippet('cline', credential(), HOST)
    const parsed = JSON.parse(s.code) as {
      mcpServers: { haven: { url: string; headers: Record<string, string>; disabled: boolean } }
    }
    expect(parsed.mcpServers.haven.url).toBe(HOST)
    expect(parsed.mcpServers.haven.disabled).toBe(false)
    const macPath = s.destinationPaths?.find((p) => p.label.startsWith('macOS'))?.path
    expect(macPath).toContain('saoudrizwan.claude-dev')
  })

  it('emits Codex CLI\'s TOML shape with the bearer in an env var', () => {
    // Codex's config references an env var rather than inlining the
    // bearer — that's better hygiene (no token in the dotfile) and is the
    // documented pattern. The snippet must include the export line so
    // users don't paste the TOML and then wonder where to put the token.
    const s = buildHostedConnectSnippet('codex-cli', credential(), HOST)
    expect(s.language).toBe('toml')
    expect(s.code).toMatch(/\[mcp_servers\.haven\]/)
    expect(s.code).toMatch(/bearer_token_env_var\s*=\s*"HAVEN_TOKEN"/)
    expect(s.code).toContain(`export HAVEN_TOKEN=${API_KEY}`)
  })

  it('emits OpenCode\'s JSON shape under `mcp.<name>` with type: remote', () => {
    const s = buildHostedConnectSnippet('opencode', credential(), HOST)
    const parsed = JSON.parse(s.code) as {
      mcp: { haven: { type: string; url: string; headers: Record<string, string> } }
    }
    expect(parsed.mcp.haven.type).toBe('remote')
    expect(parsed.mcp.haven.url).toBe(HOST)
  })

  it('emits Goose\'s YAML shape under `extensions.<name>`', () => {
    const s = buildHostedConnectSnippet('goose', credential(), HOST)
    expect(s.language).toBe('yaml')
    expect(s.code).toMatch(/extensions:\s*\n\s*haven:/)
    expect(s.code).toContain(`Authorization: Bearer ${API_KEY}`)
  })

  it('emits an `amp mcp add` CLI command for Amp', () => {
    const s = buildHostedConnectSnippet('amp', credential(), HOST)
    expect(s.language).toBe('bash')
    expect(s.code).toMatch(/amp mcp add haven/)
    expect(s.code).toContain(`Bearer ${API_KEY}`)
  })

  it('attaches platform-specific config paths to the Claude Desktop snippet', () => {
    const s = buildHostedConnectSnippet('claude-desktop', credential(), HOST)
    expect(s.destinationPaths).toBeDefined()
    const labels = (s.destinationPaths ?? []).map((p) => p.label).sort()
    expect(labels).toEqual(['Linux', 'Windows', 'macOS'].sort())
    const macPath = s.destinationPaths?.find((p) => p.label === 'macOS')?.path
    expect(macPath).toContain('claude_desktop_config.json')
  })

  it('attaches workspace + user paths to the VS Code snippet', () => {
    // VS Code is the multi-scope runtime — workspace `.vscode/mcp.json`
    // lands at the project level while user-scope is in the VS Code
    // user-data dir. Both must be discoverable from the modal.
    const s = buildHostedConnectSnippet('vscode', credential(), HOST)
    const labels = (s.destinationPaths ?? []).map((p) => p.label)
    expect(labels).toContain('Workspace')
    expect(labels.some((l) => l.startsWith('User'))).toBe(true)
  })

  it('attaches a restart-required postNote to the Claude Code snippet', () => {
    const s = buildHostedConnectSnippet('claude-code', credential(), HOST)
    expect(s.postNote).toBeDefined()
    expect(s.postNote!).toMatch(/restart|session start|run `?claude`?/i)
  })

  it('does not attach a postNote or destinationPaths to runtimes that do not need one', () => {
    // Cursor's primary surface is the one-click button — there's no file
    // to surface a path for in the primary flow. Same for `other` (the
    // generic SDK escape hatch).
    for (const c of ['cursor', 'other'] as HostedClientId[]) {
      const s = buildHostedConnectSnippet(c, credential(), HOST)
      expect(s.postNote).toBeUndefined()
      if (c === 'other') expect(s.destinationPaths).toBeUndefined()
    }
  })
})

describe('hasDeepLink', () => {
  // Real deep-link schemes only — Cursor's `cursor://` and VS Code's
  // `vscode:mcp/install?`. Adding a third requires real verification
  // that the scheme is actually registered by the runtime; broken
  // deep links erode trust faster than missing ones.
  it('reports Cursor and VS Code as the runtimes with working deep links', () => {
    expect(hasDeepLink('cursor')).toBe(true)
    expect(hasDeepLink('vscode')).toBe(true)
    expect(hasDeepLink('claude-desktop')).toBe(false)
    expect(hasDeepLink('claude-code')).toBe(false)
    expect(hasDeepLink('windsurf')).toBe(false)
    expect(hasDeepLink('continue')).toBe(false)
    expect(hasDeepLink('cline')).toBe(false)
    expect(hasDeepLink('codex-cli')).toBe(false)
    expect(hasDeepLink('opencode')).toBe(false)
    expect(hasDeepLink('goose')).toBe(false)
    expect(hasDeepLink('amp')).toBe(false)
    expect(hasDeepLink('other')).toBe(false)
  })

  it('matches the registry\'s `oneClick` flag — chip and deep link stay in sync', () => {
    // A drift between the chip ("1-click" badge on the tile) and the actual
    // deep-link availability would mean a user clicks a one-click tile and
    // gets… a config snippet. Catch that here.
    for (const option of HOSTED_CLIENT_REGISTRY) {
      expect(hasDeepLink(option.id)).toBe(Boolean(option.oneClick))
    }
  })
})

describe('buildDeepLink', () => {
  const HOST = 'https://mcp.test.example/v1'

  it('builds a cursor:// URL that carries the bearer base64-encoded and never the delegate key', () => {
    const url = buildDeepLink('cursor', credential(), HOST)
    expect(url).toMatch(/^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?/)
    expect(url).not.toContain(DELEGATE_KEY)
    // Headers blob is base64-encoded in the `headers` query param.
    const headersParam = url.match(/headers=([^&]+)/)?.[1]
    expect(headersParam).toBeDefined()
    const decoded = atob(decodeURIComponent(headersParam!))
    expect(decoded).toContain(`Bearer ${API_KEY}`)
  })

  it('builds a vscode:mcp/install URL with URL-encoded JSON and never the delegate key', () => {
    const url = buildDeepLink('vscode', credential(), HOST)
    expect(url).toMatch(/^vscode:mcp\/install\?/)
    expect(url).not.toContain(DELEGATE_KEY)
    const payload = decodeURIComponent(url.replace(/^vscode:mcp\/install\?/, ''))
    const parsed = JSON.parse(payload) as {
      name: string
      type: string
      url: string
      headers: Record<string, string>
    }
    expect(parsed.name).toBe('haven')
    expect(parsed.type).toBe('http')
    expect(parsed.url).toBe(HOST)
    expect(parsed.headers.Authorization).toBe(`Bearer ${API_KEY}`)
  })
})

describe('buildHostedSetupPrompt', () => {
  const HOST = 'https://mcp.test.example/v1'

  it('builds a runtime-specific setup prompt for Codex CLI', () => {
    const prompt = buildHostedSetupPrompt('codex-cli', credential(), HOST)

    expect(prompt).toContain('Codex CLI')
    expect(prompt).toContain('~/.codex/config.toml')
    expect(prompt).toContain('bearer_token_env_var = "HAVEN_TOKEN"')
    expect(prompt).toContain(API_KEY)
    expect(prompt).toContain(DELEGATE_KEY)
  })

  it('includes budget, network, Haven wallet, and revoke context', () => {
    const prompt = buildHostedSetupPrompt('claude-desktop', credential(), HOST)

    expect(prompt).toContain('Haven wallet:')
    expect(prompt).toContain(INPUT.agent.safeAddress)
    expect(prompt).toContain('Network:')
    expect(prompt).toContain('25 USDC per day')
    expect(prompt).toMatch(/pause or revoke the agent in Haven/i)
  })

  it('states that API auth identifies the agent but does not authorize payment by itself', () => {
    const prompt = buildHostedSetupPrompt('windsurf', credential(), HOST)

    expect(prompt).toMatch(/connect token identifies this agent/i)
    expect(prompt).toMatch(/not enough to authorize payments by itself/i)
    expect(prompt).toMatch(/signing key authorizes payments locally/i)
    expect(prompt).toMatch(/Haven does not hold this signing key/i)
    expect(prompt).toMatch(/cannot use the connect token alone to move money/i)
    expect(prompt).not.toMatch(/Haven holds your funds|Haven transfers money for you/i)
  })

  it('includes the delegate key exactly once', () => {
    const prompt = buildHostedSetupPrompt('continue', credential(), HOST)
    const occurrences = prompt.split(DELEGATE_KEY).length - 1

    expect(occurrences).toBe(1)
  })

  it('hands "other" a fully secret-free prompt that references the signer file', () => {
    // Custom/SDK runtimes get a prompt with NO secret material at all — the
    // signing key is referenced by its on-disk path instead of pasted into
    // chat, so nothing sensitive lands in the custom agent's context/memory.
    const prompt = buildHostedSetupPrompt('other', credential(), HOST)

    expect(prompt).not.toContain(DELEGATE_KEY)
    expect(prompt).not.toContain(API_KEY)
    expect(prompt).toContain('~/.haven/agents/agt_test/signer.json')
    expect(prompt).toMatch(/do not paste the signing key/i)
  })
})

describe('buildAgentStarterPrompt', () => {
  // Custody invariants for the paste-into-chat handoff message. Failing
  // these would leak credentials into chat history in unexpected ways.
  it('includes the delegate key exactly once', () => {
    const prompt = buildAgentStarterPrompt(credential())
    const occurrences = prompt.split(DELEGATE_KEY).length - 1
    expect(occurrences).toBe(1)
  })

  it('NEVER includes the api key (bearer token)', () => {
    // The Bearer token already lives in the MCP config. Including it in
    // the chat message would be a second copy in chat history with zero
    // benefit and real downside (e.g. transcript exports leak it).
    const prompt = buildAgentStarterPrompt(credential())
    expect(prompt).not.toContain(API_KEY)
  })

  it('frames the key as bounded-spend so safety-tuned agents accept it for in-session signing', () => {
    // The whole point of this prompt is to defuse the "key leaked = drain
    // the wallet" reflex. The bounded-spend property MUST be stated in
    // plain language — call out the AllowanceModule's safety property
    // without naming the mechanism.
    const prompt = buildAgentStarterPrompt(credential())
    expect(prompt).toMatch(/can.t move money beyond|spends within the on-chain allowance/i)
  })

  it('walks the haven_pay → sign → haven_submit flow so the agent knows the tool sequence', () => {
    // Without this, Claude correctly refuses to "store the key" but then
    // doesn't know what to do with it either. The prompt names the right
    // tool sequence so the agent has a path forward.
    const prompt = buildAgentStarterPrompt(credential())
    expect(prompt).toContain('haven_pay')
    expect(prompt).toContain('haven_submit')
    expect(prompt).toMatch(/haven_get_allowances/)
  })

  it('tells the agent NOT to persist the key to disk', () => {
    // Persisting a delegate key into a dotfile is the failure mode the
    // user wants to avoid. The prompt must instruct the agent to keep
    // it in memory only.
    const prompt = buildAgentStarterPrompt(credential())
    expect(prompt).toMatch(/don.t persist|keep in memory|in memory for/i)
  })

  it('honours a custom example action when supplied', () => {
    const prompt = buildAgentStarterPrompt(credential(), {
      exampleAction: 'First, look up x402-enabled API foo.example and pay for one call.',
    })
    expect(prompt).toContain('First, look up x402-enabled API foo.example')
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
