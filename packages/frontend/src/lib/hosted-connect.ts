/**
 * Hosted-MCP connect-command generation.
 *
 * Produces the "1 · Connect" command/snippet for the new Done step in the
 * Create Agent flow (#187). Pairs with the hosted, keyless `@haven_ai/mcp-server`
 * — the URL + Bearer token go to Haven (identity), and signing stays on the
 * user's machine via the credential file (authority).
 *
 * #187 scope: working command per client.
 * #188 scope: deep links (Claude Desktop / Cursor) + SDK advanced disclosure.
 */

import type { AgentCredentialJson } from './agent-credential'

/**
 * Default hosted MCP endpoint.
 * Override via `NEXT_PUBLIC_HAVEN_MCP_URL` at deploy time.
 * See `docs/deploy/hosted-mcp.md`.
 */
const DEFAULT_HOSTED_MCP_URL = 'https://haven-ai-production-5953.up.railway.app/v1'

export type HostedClientId =
  | 'claude-code'
  | 'claude-desktop'
  | 'cursor'
  | 'other'

export interface HostedClientOption {
  id: HostedClientId
  label: string
  /** Where in the client this connects from. Shown beside the snippet. */
  destination?: string
}

export const HOSTED_CLIENT_OPTIONS: HostedClientOption[] = [
  { id: 'claude-code', label: 'Claude Code', destination: 'CLI' },
  { id: 'claude-desktop', label: 'Claude Desktop', destination: 'MCP settings' },
  { id: 'cursor', label: 'Cursor', destination: 'MCP settings' },
  { id: 'other', label: 'Other / SDK' },
]

export interface HostedConnectSnippet {
  client: HostedClientId
  language: 'bash' | 'json'
  /** Multi-line code body, no leading/trailing blank lines. */
  code: string
  /** Short instruction to render above the code block. */
  guidance: string
  /**
   * Optional one-liner rendered under the code block. Used to call out
   * follow-up actions that aren't part of the snippet itself — e.g.
   * "restart Claude Code so MCP servers re-load at session start".
   */
  postNote?: string
  /**
   * Optional platform-specific destination paths shown alongside the snippet
   * (e.g. the Claude Desktop config file location on each OS). Rendered as a
   * small key/value list so users know where to paste the JSON.
   */
  destinationPaths?: { label: string; path: string }[]
}

/**
 * Resolve the hosted MCP base URL.
 * Env override wins so a Railway URL can be used before DNS is mapped.
 */
export function resolveHostedMcpUrl(envOverride?: string | null): string {
  const fromEnv = envOverride ?? process.env.NEXT_PUBLIC_HAVEN_MCP_URL
  const candidate = typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : DEFAULT_HOSTED_MCP_URL
  return candidate.replace(/\/+$/, '')
}

/**
 * Build the connect snippet. Identity only — the delegate key is NEVER included.
 */
export function buildHostedConnectSnippet(
  client: HostedClientId,
  credential: AgentCredentialJson,
  hostedUrl: string = resolveHostedMcpUrl(),
): HostedConnectSnippet {
  switch (client) {
    case 'claude-code':
      return {
        client,
        language: 'bash',
        guidance:
          'Run this in any terminal. Claude Code stores the connection per-project so future sessions reuse it.',
        code: [
          `claude mcp add --transport http haven \\`,
          `  ${hostedUrl} \\`,
          `  --header "Authorization: Bearer ${credential.api_key}"`,
        ].join('\n'),
        postNote:
          'Then exit this Claude Code session and run `claude` again — MCP servers load at session start, so a running session won’t pick up the new tools until you restart it.',
      }
    case 'claude-desktop':
    case 'cursor': {
      const config = {
        mcpServers: {
          haven: {
            url: hostedUrl,
            headers: { Authorization: `Bearer ${credential.api_key}` },
          },
        },
      }
      return {
        client,
        language: 'json',
        guidance:
          client === 'claude-desktop'
            ? "Open Claude Desktop’s config file (path below), paste this JSON in, then fully quit and reopen Claude Desktop."
            : "Open Cursor’s MCP settings and paste this in. Reload Cursor when you’re done.",
        code: JSON.stringify(config, null, 2),
        destinationPaths:
          client === 'claude-desktop'
            ? [
                { label: 'macOS', path: '~/Library/Application Support/Claude/claude_desktop_config.json' },
                { label: 'Windows', path: '%APPDATA%\\Claude\\claude_desktop_config.json' },
                { label: 'Linux', path: '~/.config/Claude/claude_desktop_config.json' },
              ]
            : undefined,
      }
    }
    case 'other':
      return {
        client,
        language: 'bash',
        guidance:
          'For SDK or custom agents — point your MCP client at the URL and send the Bearer header on every call.',
        code: [
          `HAVEN_MCP_URL=${hostedUrl}`,
          `HAVEN_API_KEY=${credential.api_key}`,
          ``,
          `# Example: curl an MCP tools/list against the hosted endpoint`,
          `curl -X POST "$HAVEN_MCP_URL" \\`,
          `  -H "Authorization: Bearer $HAVEN_API_KEY" \\`,
          `  -H "Content-Type: application/json" \\`,
          `  -H "Accept: application/json, text/event-stream" \\`,
          `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
        ].join('\n'),
      }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// #188: Deep links + local-MCP advanced disclosure
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a one-click deep link for Cursor.
 *
 * Carries the hosted MCP URL and Bearer token (identity).
 * The delegate private key is NEVER in the link.
 *
 * Cursor: `cursor://anysphere.cursor-deeplink/mcp/install?...`
 *
 * Note: Claude Desktop previously had a `claude://settings/integrations/...`
 * deep link, but Anthropic has not shipped a `claude://` URL handler — the
 * click was a silent no-op on every platform. Until that scheme is real,
 * Claude Desktop uses the manual JSON-config path instead.
 */
export function buildDeepLink(
  client: 'cursor',
  credential: AgentCredentialJson,
  hostedUrl: string = resolveHostedMcpUrl(),
): string {
  // `client` is currently always 'cursor', kept as a parameter so future
  // runtimes with real deep-link schemes can re-join here without an API break.
  void client

  const token = credential.api_key
  const headersJson = JSON.stringify({ Authorization: `Bearer ${token}` })
  // btoa is Latin-1 only — use the encodeURIComponent + unescape idiom to
  // safely handle any Unicode characters that may appear in hostedUrl or token
  // (e.g. IDN hostnames set via NEXT_PUBLIC_HAVEN_MCP_URL). Without this,
  // btoa throws a DOMException for characters outside the Latin-1 range.
  const headersB64 =
    typeof btoa !== 'undefined'
      ? btoa(unescape(encodeURIComponent(headersJson)))
      : Buffer.from(headersJson).toString('base64')
  return (
    `cursor://anysphere.cursor-deeplink/mcp/install` +
    `?name=haven` +
    `&url=${encodeURIComponent(hostedUrl)}` +
    `&transport=http` +
    `&headers=${encodeURIComponent(headersB64)}`
  )
}

/**
 * CTA label for each deep-link button.
 */
export const DEEP_LINK_LABEL: Record<'cursor', string> = {
  cursor: 'Add to Cursor',
}

/**
 * Whether a client has a deep-link path (as opposed to only a manual config
 * block). Used by `HostedConnectCard` to decide whether to render a button.
 */
export function hasDeepLink(client: HostedClientId): client is 'cursor' {
  return client === 'cursor'
}

// ─────────────────────────────────────────────────────────────────────────────
// Test connection — browser-side probe against the hosted MCP endpoint.
// Catches >80% of the silent-failure modes (broken bearer, wrong URL, DNS
// errors, CORS misconfiguration) so the user sees something actionable in the
// modal rather than waiting for the connected-banner that never lights up.
// ─────────────────────────────────────────────────────────────────────────────

export type ProbeStatus = 'ok' | 'unauthorized' | 'network-error' | 'bad-response'

export interface ProbeResult {
  status: ProbeStatus
  /** Number of tools the server advertised — only set when status === 'ok'. */
  toolCount?: number
  /** Detail string suitable for rendering under the result chip. */
  detail?: string
}

/**
 * Probe the hosted MCP endpoint with an unsigned `tools/list` JSON-RPC call.
 *
 * Returns a structured result rather than throwing — the UI renders one of
 * four states (ok / unauthorized / network-error / bad-response) and never
 * surfaces a raw thrown error to the user.
 */
export async function probeHostedConnection(
  apiKey: string,
  hostedUrl: string = resolveHostedMcpUrl(),
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  let res: Response
  try {
    res = await fetchImpl(hostedUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
  } catch (err) {
    return {
      status: 'network-error',
      detail: err instanceof Error ? err.message : 'Could not reach the hosted MCP endpoint.',
    }
  }

  if (res.status === 401 || res.status === 403) {
    return {
      status: 'unauthorized',
      detail: 'Haven rejected the connect token. Re-issue the agent credential and try again.',
    }
  }

  if (!res.ok) {
    return {
      status: 'bad-response',
      detail: `Server returned HTTP ${res.status}.`,
    }
  }

  // The streamable-HTTP transport may respond with SSE or JSON depending on
  // negotiation. Either way the response body carries a JSON-RPC envelope.
  let raw: string
  try {
    raw = await res.text()
  } catch {
    return { status: 'bad-response', detail: 'Could not read the server response body.' }
  }

  const payload = parseJsonRpcPayload(raw)
  if (!payload) {
    return { status: 'bad-response', detail: 'Server response was not a JSON-RPC envelope.' }
  }
  if ('error' in payload && payload.error) {
    return {
      status: 'bad-response',
      detail: typeof payload.error.message === 'string' ? payload.error.message : 'JSON-RPC error',
    }
  }
  const tools = (payload.result as { tools?: unknown[] } | undefined)?.tools
  const toolCount = Array.isArray(tools) ? tools.length : undefined
  return {
    status: 'ok',
    toolCount,
    detail:
      toolCount !== undefined
        ? `Hosted MCP reachable — ${toolCount} tool${toolCount === 1 ? '' : 's'} advertised.`
        : 'Hosted MCP reachable.',
  }
}

interface JsonRpcEnvelope {
  jsonrpc?: string
  id?: unknown
  result?: unknown
  error?: { code?: number; message?: unknown }
}

/**
 * Best-effort JSON-RPC envelope extractor that copes with both JSON and SSE
 * (`data: { ... }\n\n`) framings used by the streamable-HTTP transport.
 */
function parseJsonRpcPayload(raw: string): JsonRpcEnvelope | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed) as JsonRpcEnvelope
    } catch {
      return null
    }
  }
  // SSE framing: pick the last `data:` line, which is the final response.
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
  for (let i = dataLines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(dataLines[i]) as JsonRpcEnvelope
    } catch {
      /* try the next data line */
    }
  }
  return null
}
