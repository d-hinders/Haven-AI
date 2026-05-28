/**
 * Hosted-MCP connect-command generation.
 *
 * Produces the "1 · Connect" command/snippet for the new Done step in the
 * Create Agent flow (#187). Pairs with the hosted, keyless `@haven_ai/mcp-server`
 * — the URL + Bearer token go to Haven (identity), and signing stays on the
 * user's machine via the credential file (authority).
 *
 * Scope for #187: produce a usable `claude mcp add` command per client so the
 * redesigned card is functional. Richer per-client artifacts (deep links,
 * "Add to Cursor" buttons, SDK code blocks) are #188.
 */

import type { AgentCredentialJson } from './agent-credential'

/** Resolved at runtime so an unmapped DNS / different env can override. */
const DEFAULT_HOSTED_MCP_URL = 'https://mcp.haven.ai/v1'

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
 * Resolve the hosted MCP base URL. Env override wins so a fresh Railway URL
 * can be used before the `mcp.haven.ai` DNS is mapped. See
 * `docs/deploy/hosted-mcp.md`.
 */
export function resolveHostedMcpUrl(envOverride?: string | null): string {
  const fromEnv = envOverride ?? process.env.NEXT_PUBLIC_HAVEN_MCP_URL
  const candidate = typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : DEFAULT_HOSTED_MCP_URL
  return candidate.replace(/\/+$/, '')
}

/**
 * Build the connect snippet a user pastes to wire their agent client at the
 * hosted MCP. Identity only — no delegate key is ever in the snippet.
 *
 * Claude Code / Claude Desktop / Cursor all support `claude mcp add` style or
 * the JSON MCP config block; the snippet variant picks the most useful for
 * each. "Other / SDK" shows the env-var form for arbitrary runtimes.
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
      // Both clients accept the same MCP-config block shape. Per-client deep
      // links / one-click installers land in #188.
      const config = {
        mcpServers: {
          haven: {
            url: hostedUrl,
            headers: {
              Authorization: `Bearer ${credential.api_key}`,
            },
          },
        },
      }
      return {
        client,
        language: 'json',
        guidance:
          client === 'claude-desktop'
            ? 'Open Claude Desktop’s MCP settings and paste this in. Restart Claude when you’re done.'
            : 'Open Cursor’s MCP settings and paste this in. Reload Cursor when you’re done.',
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
