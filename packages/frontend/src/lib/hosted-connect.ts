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
            ? "Open Claude Desktop's MCP settings and paste this in. Restart Claude when you're done."
            : "Open Cursor's MCP settings and paste this in. Reload Cursor when you're done.",
        code: JSON.stringify(config, null, 2),
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
 * Build a one-click deep link for Claude Desktop or Cursor.
 *
 * Carries the hosted MCP URL and Bearer token (identity).
 * The delegate private key is NEVER in the link.
 *
 * Claude Desktop: `claude://settings/integrations/mcpServers?add=<b64-json>`
 * Cursor:         `cursor://anysphere.cursor-deeplink/mcp/install?...`
 */
export function buildDeepLink(
  client: 'claude-desktop' | 'cursor',
  credential: AgentCredentialJson,
  hostedUrl: string = resolveHostedMcpUrl(),
): string {
  const token = credential.api_key

  if (client === 'claude-desktop') {
    const payload = JSON.stringify({
      name: 'haven',
      url: hostedUrl,
      type: 'http',
      headers: { Authorization: `Bearer ${token}` },
    })
    // btoa is available in all modern browsers; Node environments use Buffer.from(…).toString('base64')
    const encoded =
      typeof btoa !== 'undefined'
        ? btoa(payload)
        : Buffer.from(payload).toString('base64')
    return `claude://settings/integrations/mcpServers?add=${encodeURIComponent(encoded)}`
  }

  // Cursor
  const headersJson = JSON.stringify({ Authorization: `Bearer ${token}` })
  const headersB64 =
    typeof btoa !== 'undefined'
      ? btoa(headersJson)
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
export const DEEP_LINK_LABEL: Record<'claude-desktop' | 'cursor', string> = {
  'claude-desktop': 'Add to Claude',
  cursor: 'Add to Cursor',
}

/**
 * Whether a client has a deep-link path (as opposed to only a manual config
 * block). Used by `HostedConnectCard` to decide whether to render a button.
 */
export function hasDeepLink(client: HostedClientId): client is 'claude-desktop' | 'cursor' {
  return client === 'claude-desktop' || client === 'cursor'
}
