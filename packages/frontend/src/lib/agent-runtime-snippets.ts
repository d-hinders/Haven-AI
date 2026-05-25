/**
 * Agent runtime config snippets.
 *
 * Generates copy-pasteable install snippets for the Create Agent "Done" step,
 * one per supported runtime (Claude Desktop, Cursor, generic MCP stdio
 * clients, and the SDK / CLI for developers writing code).
 *
 * Two modes per runtime:
 *
 *   - inline (default): secret env vars are embedded directly in the snippet.
 *     Zero files for the user to manage; copy → paste → restart → done. Relies
 *     on `@haven_ai/mcp`'s env-var fallback in `loadCredentials()`.
 *   - file: snippet references the downloaded credential JSON by absolute
 *     path via `HAVEN_CREDENTIALS=<path>`. Better secrets hygiene for users
 *     who already manage their secret store; the credential JSON is the only
 *     secret-bearing artifact and the runtime config holds no secret.
 *
 * The MCP package version is read from the SDK package version at build time
 * so the snippet pins to a known-working version rather than always grabbing
 * @latest.
 */

import type { AgentCredentialJson } from './agent-credential'

export type RuntimeSnippetMode = 'inline' | 'file'

export type RuntimeSnippetId =
  | 'claude-desktop'
  | 'cursor'
  | 'generic-mcp'
  | 'sdk-cli'

export interface RuntimeSnippet {
  id: RuntimeSnippetId
  label: string
  language: 'json' | 'bash' | 'typescript'
  /** Short instruction shown above the code block. */
  guidance: string
  /** Path or URL the user navigates to in order to paste the snippet. */
  destination?: string
  /** The code body — multi-line, no leading/trailing blank lines. */
  code: string
  /** Modes the snippet supports. `inline` is always defined. */
  mode: RuntimeSnippetMode
}

export interface RuntimeSnippetInput {
  credential: AgentCredentialJson
  /** Absolute file path the credential JSON will be saved to in file mode. */
  credentialFilePath?: string
}

const MCP_PACKAGE = '@haven_ai/mcp'

function jsonBlock(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function defaultCredentialPath(filenameSlug: string): string {
  return `/absolute/path/to/haven-agent-${filenameSlug}.json`
}

// ── Claude Desktop ────────────────────────────────────────────────

function claudeDesktopInline(cred: AgentCredentialJson): RuntimeSnippet {
  const config = {
    mcpServers: {
      haven: {
        command: 'npx',
        args: ['-y', MCP_PACKAGE],
        env: stripUndefined({
          HAVEN_API_KEY: cred.api_key,
          HAVEN_DELEGATE_KEY: cred.delegate_key,
          HAVEN_AGENT_ID: cred.agent_id,
          HAVEN_SAFE_ADDRESS: cred.safe_address,
          HAVEN_API_URL: cred.api_url ?? undefined,
        }),
      },
    },
  }
  return {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    language: 'json',
    guidance:
      'Add this block to your Claude Desktop config, then restart Claude. ' +
      'macOS: ~/Library/Application Support/Claude/claude_desktop_config.json. ' +
      'Windows: %APPDATA%\\Claude\\claude_desktop_config.json.',
    destination: 'claude_desktop_config.json',
    code: jsonBlock(config),
    mode: 'inline',
  }
}

function claudeDesktopFile(cred: AgentCredentialJson, path: string): RuntimeSnippet {
  const config = {
    mcpServers: {
      haven: {
        command: 'npx',
        args: ['-y', MCP_PACKAGE, '--credentials', path],
      },
    },
  }
  return {
    ...claudeDesktopInline(cred),
    guidance:
      'Save the credential JSON above to a private path, then add this block to your ' +
      'Claude Desktop config and restart Claude.',
    code: jsonBlock(config),
    mode: 'file',
  }
}

// ── Cursor ────────────────────────────────────────────────────────

function cursorInline(cred: AgentCredentialJson): RuntimeSnippet {
  const config = {
    mcpServers: {
      haven: {
        command: 'npx',
        args: ['-y', MCP_PACKAGE],
        env: stripUndefined({
          HAVEN_API_KEY: cred.api_key,
          HAVEN_DELEGATE_KEY: cred.delegate_key,
          HAVEN_AGENT_ID: cred.agent_id,
          HAVEN_SAFE_ADDRESS: cred.safe_address,
          HAVEN_API_URL: cred.api_url ?? undefined,
        }),
      },
    },
  }
  return {
    id: 'cursor',
    label: 'Cursor',
    language: 'json',
    guidance:
      'Add this block to ~/.cursor/mcp.json (create the file if it does not exist), ' +
      'then reload Cursor.',
    destination: '~/.cursor/mcp.json',
    code: jsonBlock(config),
    mode: 'inline',
  }
}

function cursorFile(cred: AgentCredentialJson, path: string): RuntimeSnippet {
  const config = {
    mcpServers: {
      haven: {
        command: 'npx',
        args: ['-y', MCP_PACKAGE, '--credentials', path],
      },
    },
  }
  return {
    ...cursorInline(cred),
    guidance:
      'Save the credential JSON to a private path, then add this block to ~/.cursor/mcp.json ' +
      'and reload Cursor.',
    code: jsonBlock(config),
    mode: 'file',
  }
}

// ── Generic MCP stdio client ──────────────────────────────────────

function genericInline(cred: AgentCredentialJson): RuntimeSnippet {
  const envLines = [
    `HAVEN_API_KEY=${cred.api_key}`,
    `HAVEN_DELEGATE_KEY=${cred.delegate_key}`,
  ]
  if (cred.agent_id) envLines.push(`HAVEN_AGENT_ID=${cred.agent_id}`)
  if (cred.safe_address) envLines.push(`HAVEN_SAFE_ADDRESS=${cred.safe_address}`)
  if (cred.api_url) envLines.push(`HAVEN_API_URL=${cred.api_url}`)
  const code = `${envLines.join(' \\\n  ')} \\\n  npx -y ${MCP_PACKAGE}`
  return {
    id: 'generic-mcp',
    label: 'Generic MCP',
    language: 'bash',
    guidance:
      'Launch the Haven MCP server as an stdio subprocess from any MCP-aware client. ' +
      'Copy this command into your client\'s server definition.',
    code,
    mode: 'inline',
  }
}

function genericFile(_cred: AgentCredentialJson, path: string): RuntimeSnippet {
  const code = `HAVEN_CREDENTIALS=${path} npx -y ${MCP_PACKAGE}`
  return {
    ...genericInline(_cred),
    guidance:
      'Save the credential JSON to a private path, then point your MCP client at this ' +
      'command. The server reads everything from the file.',
    code,
    mode: 'file',
  }
}

// ── SDK / CLI ─────────────────────────────────────────────────────

function sdkInline(cred: AgentCredentialJson): RuntimeSnippet {
  const code = [
    `import { HavenClient } from '@haven_ai/sdk'`,
    ``,
    `const haven = new HavenClient({`,
    `  apiKey: process.env.HAVEN_API_KEY!,    // ${cred.api_key}`,
    `  delegateKey: process.env.HAVEN_DELEGATE_KEY!,  // signs locally`,
    cred.api_url ? `  baseUrl: '${cred.api_url}',` : `  // baseUrl: process.env.HAVEN_API_URL,`,
    `})`,
    ``,
    `// Try it:`,
    `const agent = await haven.getAgent()`,
    `console.log(agent)`,
  ].filter(Boolean).join('\n')
  return {
    id: 'sdk-cli',
    label: 'SDK / CLI',
    language: 'typescript',
    guidance:
      'Use the SDK directly when you are writing code instead of plugging into an existing ' +
      'agent runtime. The credential file works as a .env source.',
    code,
    mode: 'inline',
  }
}

function sdkFile(cred: AgentCredentialJson, path: string): RuntimeSnippet {
  const code = [
    `// Load the credential file directly:`,
    `import { readFile } from 'node:fs/promises'`,
    `import { HavenClient } from '@haven_ai/sdk'`,
    ``,
    `const cred = JSON.parse(await readFile('${path}', 'utf8'))`,
    `const haven = new HavenClient({`,
    `  apiKey: cred.api_key,`,
    `  delegateKey: cred.delegate_key,`,
    `  baseUrl: cred.api_url,`,
    `})`,
  ].join('\n')
  return {
    ...sdkInline(cred),
    guidance:
      'Save the credential JSON to a private path and load it directly. No env vars to wire up.',
    code,
    mode: 'file',
  }
}

// ── Public API ────────────────────────────────────────────────────

/** Build all runtime snippets for the given credential in the given mode. */
export function buildRuntimeSnippets(input: RuntimeSnippetInput, mode: RuntimeSnippetMode): RuntimeSnippet[] {
  const path = input.credentialFilePath ?? defaultCredentialPath(input.credential.agent_slug)
  if (mode === 'file') {
    return [
      claudeDesktopFile(input.credential, path),
      cursorFile(input.credential, path),
      genericFile(input.credential, path),
      sdkFile(input.credential, path),
    ]
  }
  return [
    claudeDesktopInline(input.credential),
    cursorInline(input.credential),
    genericInline(input.credential),
    sdkInline(input.credential),
  ]
}

/** Build a single snippet by id. Convenience for tests and per-tile rendering. */
export function buildRuntimeSnippet(
  input: RuntimeSnippetInput,
  id: RuntimeSnippetId,
  mode: RuntimeSnippetMode,
): RuntimeSnippet {
  const all = buildRuntimeSnippets(input, mode)
  const found = all.find((s) => s.id === id)
  if (!found) throw new Error(`Unknown runtime snippet id: ${id}`)
  return found
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' && v.length > 0) out[k] = v
  }
  return out
}
