/**
 * Hosted-MCP connect-command generation.
 *
 * Produces the "1 · Connect" snippet for the Done step of the Create Agent
 * flow. Pairs with the hosted, keyless `@haven_ai/mcp-server` — the URL +
 * Bearer token go to Haven (identity), and signing stays on the user's
 * machine via the credential file (authority).
 *
 * The registry below is the single source of truth for which agent runtimes
 * the connect card surfaces. Adding a runtime is a matter of declaring it in
 * `HOSTED_CLIENT_REGISTRY` and adding a case to `buildHostedConnectSnippet`.
 * The custody invariant — the delegate private key never appears in the
 * snippet or in any deep link — is enforced by tests.
 */

import type { AgentCredentialJson } from './agent-credential'

/**
 * Default hosted MCP endpoint.
 * Override via `NEXT_PUBLIC_HAVEN_MCP_URL` at deploy time.
 * See `docs/operations/hosted-mcp.md`.
 */
const DEFAULT_HOSTED_MCP_URL = 'https://haven-ai-production-5953.up.railway.app/v1'

export type HostedClientId =
  | 'claude-code'
  | 'claude-desktop'
  | 'cursor'
  | 'vscode'
  | 'vscode-insiders'
  | 'windsurf'
  | 'continue'
  | 'cline'
  | 'codex-cli'
  | 'opencode'
  | 'goose'
  | 'amp'
  | 'other'

/**
 * High-level runtime category for the tile grid. Tiles inside the same group
 * stay adjacent in the picker, which makes "find the editor you use" easy
 * even when the registry grows past a dozen entries.
 */
export type HostedClientGroup = 'agent-cli' | 'editor' | 'desktop' | 'custom'

export interface HostedClientOption {
  id: HostedClientId
  label: string
  /**
   * One-line hint shown under the label in the tile — answers "what is this".
   * Keep under ~32 chars; longer strings will wrap and break the grid rhythm.
   */
  tagline?: string
  group: HostedClientGroup
  /**
   * True when the runtime has a working `*://` deep link. Tiles with this set
   * render a small ⚡ chip so users can spot one-click installs at a glance.
   * NEVER set this true on speculation — broken deep links erode trust.
   */
  oneClick?: boolean
}

/**
 * Registry of supported runtimes, ordered for the tile grid:
 * agent CLIs first (Claude Code is the largest cohort), then editors, then
 * desktop apps, then the generic SDK escape hatch.
 */
export const HOSTED_CLIENT_REGISTRY: HostedClientOption[] = [
  // ── Agent CLIs ──────────────────────────────────────────────────────────
  { id: 'claude-code', label: 'Claude Code', tagline: 'CLI command', group: 'agent-cli' },
  { id: 'codex-cli', label: 'Codex CLI', tagline: '~/.codex/config.toml', group: 'agent-cli' },
  { id: 'opencode', label: 'OpenCode', tagline: 'opencode.ai · TUI', group: 'agent-cli' },
  { id: 'goose', label: 'Goose', tagline: 'block.github.io', group: 'agent-cli' },
  { id: 'amp', label: 'Amp', tagline: 'Sourcegraph', group: 'agent-cli' },

  // ── Editors ─────────────────────────────────────────────────────────────
  { id: 'cursor', label: 'Cursor', tagline: 'MCP settings', group: 'editor', oneClick: true },
  { id: 'vscode', label: 'VS Code', tagline: 'Copilot · MCP', group: 'editor', oneClick: true },
  { id: 'vscode-insiders', label: 'VS Code Insiders', tagline: 'Copilot · MCP', group: 'editor', oneClick: true },
  { id: 'windsurf', label: 'Windsurf', tagline: 'Cascade · MCP', group: 'editor' },
  { id: 'continue', label: 'Continue.dev', tagline: 'config.yaml', group: 'editor' },
  { id: 'cline', label: 'Cline', tagline: 'VS Code extension', group: 'editor' },

  // ── Desktop ─────────────────────────────────────────────────────────────
  { id: 'claude-desktop', label: 'Claude Desktop', tagline: 'desktop app', group: 'desktop' },

  // ── Custom / SDK ────────────────────────────────────────────────────────
  { id: 'other', label: 'Other / SDK', tagline: 'custom agent', group: 'custom' },
]

/** Back-compat alias kept so existing imports don't break. */
export const HOSTED_CLIENT_OPTIONS = HOSTED_CLIENT_REGISTRY

export type HostedConnectLanguage = 'bash' | 'json' | 'yaml' | 'toml'

export interface HostedConnectSnippet {
  client: HostedClientId
  language: HostedConnectLanguage
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
   * Destination(s) the snippet should be saved to. One entry for runtimes
   * with a single canonical path; multiple entries for runtimes whose path
   * varies by OS (Claude Desktop) or scope (workspace vs user, e.g. VS Code).
   * Absent for runtimes whose snippet IS the action — e.g. Claude Code's
   * `claude mcp add ...` command, which doesn't paste anywhere.
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
 * Build the connect snippet for a given runtime. Identity only — the delegate
 * private key is NEVER included in the snippet, in any header, or in any
 * deep link. The custody invariant is asserted by tests for every runtime.
 */
export function buildHostedConnectSnippet(
  client: HostedClientId,
  credential: AgentCredentialJson,
  hostedUrl: string = resolveHostedMcpUrl(),
): HostedConnectSnippet {
  const bearer = `Bearer ${credential.api_key}`
  const authHeader = { Authorization: bearer }

  switch (client) {
    // ── Claude Code (CLI command) ─────────────────────────────────────────
    case 'claude-code':
      return {
        client,
        language: 'bash',
        guidance:
          'Run this in any terminal. Claude Code stores the connection per-project so future sessions reuse it.',
        code: [
          `claude mcp add --transport http haven \\`,
          `  ${hostedUrl} \\`,
          `  --header "Authorization: ${bearer}"`,
        ].join('\n'),
        postNote:
          'Then exit this Claude Code session and run `claude` again — MCP servers load at session start, so a running session won’t pick up the new tools until you restart it.',
      }

    // ── Claude Desktop (multi-OS JSON config) ─────────────────────────────
    case 'claude-desktop': {
      return {
        client,
        language: 'json',
        guidance:
          'Save this into Claude Desktop’s config file at the path below, then fully quit and reopen Claude Desktop.',
        code: JSON.stringify(
          { mcpServers: { haven: { url: hostedUrl, headers: authHeader } } },
          null,
          2,
        ),
        destinationPaths: [
          { label: 'macOS', path: '~/Library/Application Support/Claude/claude_desktop_config.json' },
          { label: 'Windows', path: '%APPDATA%\\Claude\\claude_desktop_config.json' },
          { label: 'Linux', path: '~/.config/Claude/claude_desktop_config.json' },
        ],
      }
    }

    // ── Cursor (JSON config + cursor:// deep link) ────────────────────────
    case 'cursor':
      return {
        client,
        language: 'json',
        guidance:
          'Save this into Cursor’s MCP config at the path below. Reload Cursor when you’re done.',
        code: JSON.stringify(
          { mcpServers: { haven: { url: hostedUrl, headers: authHeader } } },
          null,
          2,
        ),
        destinationPaths: [{ label: 'Global', path: '~/.cursor/mcp.json' }],
      }

    // ── VS Code (JSON config + vscode:mcp/install? deep link) ─────────────
    case 'vscode':
      return {
        client,
        language: 'json',
        guidance:
          'Save this where VS Code reads MCP servers. Workspace is recommended; user-scope is in the Command Palette → "MCP: Open User Configuration".',
        code: JSON.stringify(
          {
            servers: {
              haven: { type: 'http', url: hostedUrl, headers: authHeader },
            },
          },
          null,
          2,
        ),
        destinationPaths: [
          { label: 'Workspace', path: '.vscode/mcp.json' },
          { label: 'User · macOS', path: '~/Library/Application Support/Code/User/mcp.json' },
          { label: 'User · Windows', path: '%APPDATA%\\Code\\User\\mcp.json' },
          { label: 'User · Linux', path: '~/.config/Code/User/mcp.json' },
        ],
        postNote:
          'VS Code restarts the MCP server on config save — no window reload needed.',
      }

    // ── VS Code Insiders (same JSON format, Insiders-specific paths) ───────
    case 'vscode-insiders':
      return {
        client,
        language: 'json',
        guidance:
          'Save this where VS Code Insiders reads MCP servers. Workspace is recommended; user-scope is in the Command Palette → "MCP: Open User Configuration".',
        code: JSON.stringify(
          {
            servers: {
              haven: { type: 'http', url: hostedUrl, headers: authHeader },
            },
          },
          null,
          2,
        ),
        destinationPaths: [
          { label: 'Workspace', path: '.vscode/mcp.json' },
          { label: 'User · macOS', path: '~/Library/Application Support/Code - Insiders/User/mcp.json' },
          { label: 'User · Windows', path: '%APPDATA%\\Code - Insiders\\User\\mcp.json' },
          { label: 'User · Linux', path: '~/.config/Code - Insiders/User/mcp.json' },
        ],
        postNote:
          'VS Code Insiders restarts the MCP server on config save — no window reload needed.',
      }

    // ── Windsurf ──────────────────────────────────────────────────────────
    case 'windsurf':
      return {
        client,
        language: 'json',
        guidance:
          'Save this into Windsurf’s MCP config. Reload Windsurf (or click the refresh icon in the Cascade MCP panel) when you’re done.',
        code: JSON.stringify(
          {
            mcpServers: {
              haven: { serverUrl: hostedUrl, headers: authHeader },
            },
          },
          null,
          2,
        ),
        destinationPaths: [{ label: 'Global', path: '~/.codeium/windsurf/mcp_config.json' }],
      }

    // ── Continue.dev (YAML) ───────────────────────────────────────────────
    case 'continue':
      return {
        client,
        language: 'yaml',
        guidance:
          'Add this under `mcpServers` in your Continue config. Continue hot-reloads on save.',
        code: [
          'mcpServers:',
          '  - name: haven',
          '    type: streamable-http',
          `    url: ${hostedUrl}`,
          '    requestOptions:',
          '      headers:',
          `        Authorization: ${bearer}`,
        ].join('\n'),
        destinationPaths: [
          { label: 'Global', path: '~/.continue/config.yaml' },
          { label: 'Workspace', path: '.continue/config.yaml' },
        ],
      }

    // ── Cline (VS Code extension, separate config) ────────────────────────
    case 'cline':
      return {
        client,
        language: 'json',
        guidance:
          'Open Cline → MCP Servers → Configure. Paste this into `cline_mcp_settings.json`. Cline hot-reloads on save.',
        code: JSON.stringify(
          {
            mcpServers: {
              haven: {
                url: hostedUrl,
                headers: authHeader,
                disabled: false,
                autoApprove: [],
              },
            },
          },
          null,
          2,
        ),
        destinationPaths: [
          {
            label: 'macOS · VS Code',
            path: '~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json',
          },
          {
            label: 'Windows · VS Code',
            path: '%APPDATA%\\Code\\User\\globalStorage\\saoudrizwan.claude-dev\\settings\\cline_mcp_settings.json',
          },
        ],
      }

    // ── Codex CLI (TOML) ──────────────────────────────────────────────────
    case 'codex-cli':
      // Codex sends the bearer via an env var rather than inlining the
      // header, so the snippet is two parts: the TOML block plus the
      // `export` you need to run before launching `codex`.
      return {
        client,
        language: 'toml',
        guidance:
          'Append this to your Codex config, then export the bearer in the shell where you launch `codex`.',
        code: [
          '[mcp_servers.haven]',
          `url = "${hostedUrl}"`,
          'bearer_token_env_var = "HAVEN_TOKEN"',
          '',
          `# Then in your shell:`,
          `# export HAVEN_TOKEN=${credential.api_key}`,
        ].join('\n'),
        destinationPaths: [
          { label: 'Global', path: '~/.codex/config.toml' },
          { label: 'Project', path: '.codex/config.toml' },
        ],
        postNote: 'Restart your `codex` session — Codex loads its config at startup.',
      }

    // ── OpenCode (JSON) ───────────────────────────────────────────────────
    case 'opencode':
      return {
        client,
        language: 'json',
        guidance:
          'Add this under the `mcp` key of your OpenCode config. Restart the `opencode` TUI to reload.',
        code: JSON.stringify(
          {
            $schema: 'https://opencode.ai/config.json',
            mcp: {
              haven: {
                type: 'remote',
                url: hostedUrl,
                enabled: true,
                headers: authHeader,
              },
            },
          },
          null,
          2,
        ),
        destinationPaths: [
          { label: 'Global', path: '~/.config/opencode/opencode.json' },
          { label: 'Project', path: 'opencode.json' },
        ],
      }

    // ── Goose (YAML) ──────────────────────────────────────────────────────
    case 'goose':
      return {
        client,
        language: 'yaml',
        guidance:
          'Add this under `extensions` in Goose’s config. Goose Desktop picks it up on toggle; the CLI rereads on the next `goose session`.',
        code: [
          'extensions:',
          '  haven:',
          '    type: streamable_http',
          `    url: ${hostedUrl}`,
          '    headers:',
          `      Authorization: ${bearer}`,
          '    timeout: 300',
          '    enabled: true',
        ].join('\n'),
        destinationPaths: [{ label: 'Global', path: '~/.config/goose/config.yaml' }],
      }

    // ── Amp (JSON OR amp CLI command) ─────────────────────────────────────
    case 'amp':
      // Amp accepts MCP servers via the CLI subcommand or its settings.json
      // — the CLI form is shorter and avoids any chance of the user editing
      // the wrong settings file, so we lead with it and show settings.json
      // as a fallback under a small detail.
      return {
        client,
        language: 'bash',
        guidance:
          'Run this in any terminal — Amp persists the server into its settings for you.',
        code: [
          `amp mcp add haven \\`,
          `  ${hostedUrl} \\`,
          `  --header "Authorization: ${bearer}"`,
          '',
          `# Or edit settings.json directly:`,
          `# {`,
          `#   "amp.mcpServers": {`,
          `#     "haven": {`,
          `#       "url": "${hostedUrl}",`,
          `#       "headers": { "Authorization": "${bearer}" }`,
          `#     }`,
          `#   }`,
          `# }`,
        ].join('\n'),
        destinationPaths: [
          { label: 'Settings · macOS / Linux', path: '~/.config/amp/settings.json' },
          { label: 'Settings · Windows', path: '%USERPROFILE%\\.config\\amp\\settings.json' },
        ],
        postNote: 'Reload the Amp panel (editor) or restart the `amp` CLI session.',
      }

    // ── Generic SDK / custom MCP client (secret-free, file-referenced) ─────
    //
    // The escape hatch for SDK and custom runtimes (e.g. a bespoke agent
    // framework). Unlike the first-class runtimes, the connector cannot write
    // this runtime's config, so historically this snippet inlined the raw
    // api_key — which then ended up pasted into the agent's prompt/context.
    // Custom agents have many memory sinks (context window, transcript, memory
    // files, vector store, debug logs) and a key in any of them is a leak.
    //
    // Instead, reference the credential files the connector always writes to
    // ~/.haven/agents/<id>/ (chmod 600) and have the runtime read them at
    // execution time. No secret value appears in this snippet, so nothing
    // sensitive lands in the model's context.
    case 'other': {
      const agentDir = `~/.haven/agents/${credential.agent_id}`
      return {
        client,
        language: 'bash',
        guidance:
          'For SDK or custom agents. Your credentials are already on disk (chmod 600) — read them at runtime; never paste a key into the agent\'s prompt, memory, or logs. Point your MCP client at the hosted URL using the api_key from identity.json (identity), and sign locally with the delegate key from signer.json (authority).',
        code: [
          `# Credentials the Haven connector wrote (do not commit, do not paste into chat):`,
          `#   ${agentDir}/identity.json  → api_key + hosted_mcp_url (identity)`,
          `#   ${agentDir}/signer.json    → delegate_key (local signing authority)`,
          `#   ${agentDir}/agent.json     → non-secret identity + budget (safe to read into context)`,
          ``,
          `# Option A (recommended) — Hosted MCP (identity) + local signer (authority).`,
          `HAVEN_MCP_URL=${hostedUrl}`,
          `# The Bearer is the "api_key" field of identity.json. Read it at runtime;`,
          `# don't hard-code it. (jq shown — any JSON reader on your platform works.)`,
          `HAVEN_API_KEY="$(jq -r .api_key ${agentDir}/identity.json)"`,
          `curl -X POST "$HAVEN_MCP_URL" \\`,
          `  -H "Authorization: Bearer $HAVEN_API_KEY" \\`,
          `  -H "Content-Type: application/json" \\`,
          `  -H "Accept: application/json, text/event-stream" \\`,
          `  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
          `# Run the local signer; it reads the delegate key from signer.json itself,`,
          `# keeping it off the hosted server and out of the agent's context:`,
          `npx -y @haven_ai/signer --credentials ${agentDir}/signer.json`,
          ``,
          `# Option B — Fully local MCP, if you'd rather not depend on Haven's hosted`,
          `# server. One stdio process, reads both files, no hosted URL:`,
          `npx -y @haven_ai/mcp --identity ${agentDir}/identity.json --signer ${agentDir}/signer.json`,
        ].join('\n'),
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Deep links
// ─────────────────────────────────────────────────────────────────────────────

/** Runtimes that have a verified, working deep-link install scheme. */
type DeepLinkClient = 'cursor' | 'vscode' | 'vscode-insiders'

/**
 * Build a one-click install deep link.
 *
 * Carries the hosted MCP URL and Bearer token (identity).
 * The delegate private key is NEVER in the link.
 *
 * Cursor: `cursor://anysphere.cursor-deeplink/mcp/install?...`
 * VS Code: `vscode:mcp/install?<url-encoded JSON>` (vscode-insiders: variant
 *          supported by VS Code Insiders).
 *
 * Note: Claude Desktop previously had a `claude://settings/integrations/...`
 * scheme — Anthropic has not shipped a `claude://` URL handler, so the
 * click was a silent no-op. Until that scheme is real, Claude Desktop and
 * the other runtimes use the manual JSON-config path instead.
 */
export function buildDeepLink(
  client: DeepLinkClient,
  credential: AgentCredentialJson,
  hostedUrl: string = resolveHostedMcpUrl(),
): string {
  const token = credential.api_key

  if (client === 'vscode' || client === 'vscode-insiders') {
    // VS Code and VS Code Insiders expect a URL-encoded JSON object.
    // The scheme differs: `vscode:` vs `vscode-insiders:`.
    const payload = JSON.stringify({
      name: 'haven',
      type: 'http',
      url: hostedUrl,
      headers: { Authorization: `Bearer ${token}` },
    })
    const scheme = client === 'vscode-insiders' ? 'vscode-insiders' : 'vscode'
    return `${scheme}:mcp/install?${encodeURIComponent(payload)}`
  }

  // Cursor — base64-encoded headers blob.
  const headersJson = JSON.stringify({ Authorization: `Bearer ${token}` })
  // btoa is Latin-1 only — the encodeURIComponent + unescape idiom keeps
  // Unicode (e.g. IDN hosts via NEXT_PUBLIC_HAVEN_MCP_URL) from throwing.
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

/** CTA label for each deep-link button. */
export const DEEP_LINK_LABEL: Record<DeepLinkClient, string> = {
  cursor: 'Add to Cursor',
  vscode: 'Add to VS Code',
  'vscode-insiders': 'Add to VS Code Insiders',
}

/**
 * Whether a client has a working deep-link install scheme. Driven by the
 * registry's `oneClick` flag so it stays in sync with the tile chip.
 */
export function hasDeepLink(client: HostedClientId): client is DeepLinkClient {
  return client === 'cursor' || client === 'vscode' || client === 'vscode-insiders'
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent starter prompt — paste-into-chat handoff message
//
// Why this exists: safety-tuned chat agents (Claude in particular) treat a
// pasted-in private key as a catastrophic leak and refuse to use it for
// signing, even in-session, even with the user's permission. That's the
// right instinct for a Treasury key, but it's overcautious for a Haven
// delegate key — the AllowanceModule caps what it can spend on-chain, so
// "key leaked" really only means "spend up to today's allowance, then it
// hits the wall". The model doesn't know that without context.
//
// The starter prompt gives the agent that context up front, in the same
// message that hands over the key. With this framing, Claude accepts the
// key for in-session signing without trying to lecture the user about
// rotating it; the model is doing exactly what it should, just with
// accurate threat info.
//
// IMPORTANT custody invariants enforced by tests:
//   - The api_key (Bearer token to Haven) is NEVER in this prompt. It
//     already lives in the agent's MCP config and adding it here would
//     be a second copy in chat history with no upside.
//   - The delegate key appears exactly once. Pasting the same key in
//     two places multiplies the surface area for accidental leakage.
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentStarterPromptOptions {
  /** Suggested first-action verb. Defaults to a payment intent example. */
  exampleAction?: string
}

function setupResetLabel(mins: number): string {
  if (mins === 0) return 'one-time'
  if (mins === 60) return 'per hour'
  if (mins === 1440) return 'per day'
  if (mins === 10080) return 'per week'
  if (mins === 43200) return 'per 30 days'
  if (mins < 60) return `per ${mins}m`
  if (mins % 1440 === 0) return `per ${mins / 1440}d`
  if (mins % 60 === 0) return `per ${mins / 60}h`
  return `per ${mins}m`
}

function setupPromptLanguage(language: HostedConnectLanguage): string {
  return language === 'toml' ? 'toml' : language
}

/**
 * Build the default copy-ready prompt for the Connect Agent done step.
 *
 * This is intentionally copied directly from the UI and not rendered by
 * default: it contains both the Haven connect token (identity) and the agent
 * signing key (authority). Runtime-specific config still comes from
 * buildHostedConnectSnippet so the manual and prompt-first paths cannot drift.
 */
export function buildHostedSetupPrompt(
  client: HostedClientId,
  credential: AgentCredentialJson,
  hostedUrl: string = resolveHostedMcpUrl(),
): string {
  const option = HOSTED_CLIENT_REGISTRY.find((c) => c.id === client)
  const runtimeLabel = option?.label ?? client
  const snippet = buildHostedConnectSnippet(client, credential, hostedUrl)
  const network = credential.network ?? `Chain ${credential.chain_id}`
  const budgets =
    credential.budget_summary.length > 0
      ? credential.budget_summary.map(
          (b) => `- ${b.amount} ${b.token} ${setupResetLabel(b.reset_period_min)}`,
        )
      : ['- No agent budget was included. Ask me to review the agent rules before payment.']
  const destinations =
    snippet.destinationPaths && snippet.destinationPaths.length > 0
      ? [
          '',
          'Save the config in the right place for this runtime:',
          ...snippet.destinationPaths.map((p) => `- ${p.label}: ${p.path}`),
        ]
      : []

  // Custom/SDK runtimes ('other') get a secret-free handoff: the signing key
  // is referenced by its on-disk path rather than pasted into the chat. The
  // connect snippet for 'other' is already file-referenced, so this keeps the
  // entire prompt free of secret material — nothing sensitive lands in the
  // custom agent's context, memory, or transcript. First-class runtimes keep
  // the inline key, framed by the bounded-spend control model above (see the
  // buildAgentStarterPrompt note on why safety-tuned agents need that framing).
  const signingKeySection =
    client === 'other'
      ? [
          '',
          'Signing key',
          `Do not paste the signing key into this chat. It is on disk at ~/.haven/agents/${credential.agent_id}/signer.json (chmod 600). Have the runtime read it only at signing time and keep it out of your context, memory, and logs.`,
        ]
      : ['', 'Signing key', credential.delegate_key]

  // The first key-handling rule must match where the key actually lives for
  // this runtime. For 'other' it sits in signer.json on disk (read at signing
  // time); telling that agent to keep the key "in memory only" would directly
  // contradict the signing-key section above. First-class runtimes paste the
  // key into chat, so "in memory only" is the right instruction for them.
  const keyHandlingRule =
    client === 'other'
      ? '- The signing key stays in signer.json on disk; have the runtime read it only at signing time, and keep it out of your context, memory, and logs.'
      : '- Keep the signing key in memory or in the agent runtime\'s local secret store only.'

  return [
    `Please connect this agent to Haven in ${runtimeLabel}.`,
    '',
    'What to set up',
    `- Agent: ${credential.agent_name}`,
    `- Runtime: ${runtimeLabel}`,
    `- Haven wallet: ${credential.safe_address}`,
    `- Network: ${network}`,
    '- Agent budget:',
    ...budgets,
    '',
    'Important control model',
    '- The Haven connect token identifies this agent. It is not enough to authorize payments by itself.',
    '- The signing key authorizes payments locally, and payments must stay within the user-approved agent budget and on-chain rules.',
    '- Haven does not hold this signing key and cannot use the connect token alone to move money.',
    '',
    `Set up ${runtimeLabel}`,
    snippet.guidance,
    ...destinations,
    '',
    `\`\`\`${setupPromptLanguage(snippet.language)}`,
    snippet.code,
    '```',
    ...(snippet.postNote ? ['', snippet.postNote] : []),
    ...signingKeySection,
    '',
    'Rules for this key',
    keyHandlingRule,
    '- Do not commit it, upload it, paste it into shared logs, or send it to Haven.',
    '- Before attempting a payment, check the active agent budget and ask me to approve actions in Haven when a request is outside the rules.',
    `- If this credential may have leaked, tell me to pause or revoke the agent in Haven: ${credential.revoke_url}`,
  ].join('\n')
}

/**
 * Build the message a user pastes into their agent chat after the MCP
 * connection is in place. Frames the delegate key as bounded-spend so the
 * model accepts it for in-session signing, and walks the haven_pay → sign
 * → haven_submit handshake so the agent knows the right tool sequence.
 */
export function buildAgentStarterPrompt(
  credential: AgentCredentialJson,
  options: AgentStarterPromptOptions = {},
): string {
  const lines = [
    `You're connected to Haven via MCP. Signing key for this session:`,
    ``,
    credential.delegate_key,
    ``,
    `This key only spends within the on-chain allowance set in Haven —`,
    `call haven_get_allowances to see the caps. Even if exposed it can't`,
    `move money beyond those caps, so it's safe to keep in memory for`,
    `this session. Don't persist it to any file or commit it anywhere.`,
    ``,
    `Flow: I give you a payment intent → you call haven_pay (or`,
    `haven_x402_authorize for an HTTP 402 challenge) → sign the returned`,
    `payload_hash locally with the key → haven_submit with just the`,
    `signature. The key never leaves this chat.`,
    ``,
    options.exampleAction ??
      `Ready when you are — give me a payment intent (token, amount, recipient) and I'll handle the rest.`,
  ]
  return lines.join('\n')
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
