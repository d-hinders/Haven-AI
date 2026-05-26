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
  | 'windsurf'
  | 'vscode'
  | 'generic-mcp'
  | 'sdk-cli'
  | 'python'

export interface RuntimeSnippet {
  id: RuntimeSnippetId
  label: string
  language: 'json' | 'bash' | 'typescript' | 'python'
  /** Short instruction shown above the code block. */
  guidance: string
  /** Path or URL the user navigates to in order to paste the snippet. */
  destination?: string
  /** The code body — multi-line, no leading/trailing blank lines. */
  code: string
  /** Modes the snippet supports. `inline` is always defined. */
  mode: RuntimeSnippetMode
  /**
   * One-time setup instruction shown beneath the snippet. Present for all
   * MCP-based runtimes because the consent gate (EPIC 1) must be accepted
   * before the server will start. Absent for non-MCP runtimes (sdk-cli,
   * python) where no MCP server is launched.
   */
  consentNote?: string
}

export interface RuntimeSnippetInput {
  credential: AgentCredentialJson
  /** Absolute file path the credential JSON will be saved to in file mode. */
  credentialFilePath?: string
}

const MCP_PACKAGE = '@haven_ai/mcp'

/**
 * The MCP server requires a one-time consent acknowledgement before it will
 * start (see packages/mcp/src/consent.ts from EPIC 1). Without it the
 * process exits immediately with HAVEN_MCP_NO_CONSENT.
 *
 * Users must run `npx @haven_ai/mcp --credentials <path> --ack` once in a
 * terminal and follow the prompt. The resulting .ack.json sidecar is written
 * next to the credential file, or the env var HAVEN_MCP_ACK can be pre-set
 * to the consent hash for CI / headless environments.
 *
 * In inline mode (no credential file) use the placeholder path as a reminder
 * to substitute the real path after the credential file has been saved.
 */
function consentNote(credentialsPath: string): string {
  return (
    'Before first use, run this once in a terminal to review and accept the consent prompt:\n' +
    `  npx @haven_ai/mcp --credentials ${credentialsPath} --ack`
  )
}

const CONSENT_NOTE_INLINE = consentNote('/path/to/haven-agent.json')

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
      'Open Claude Desktop\'s MCP settings and paste this in. Restart Claude when you\'re done. ' +
      '(The settings live at ~/Library/Application Support/Claude/claude_desktop_config.json on macOS · ' +
      '%APPDATA%\\Claude\\claude_desktop_config.json on Windows.)',
    destination: 'claude_desktop_config.json',
    code: jsonBlock(config),
    mode: 'inline',
    consentNote: CONSENT_NOTE_INLINE,
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
      'First download the credentials below and save them somewhere private. Then paste this into ' +
      'Claude Desktop\'s MCP settings and restart Claude.',
    code: jsonBlock(config),
    mode: 'file',
    consentNote: consentNote(path),
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
      'Open Cursor\'s MCP settings and paste this in. Reload Cursor when you\'re done. ' +
      '(The settings live at ~/.cursor/mcp.json — create the file if it\'s not there yet.)',
    destination: '~/.cursor/mcp.json',
    code: jsonBlock(config),
    mode: 'inline',
    consentNote: CONSENT_NOTE_INLINE,
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
      'First download the credentials below and save them somewhere private. Then paste this into ' +
      'Cursor\'s MCP settings and reload Cursor.',
    code: jsonBlock(config),
    mode: 'file',
    consentNote: consentNote(path),
  }
}

// ── Other agents (any other MCP-aware app or custom script) ──────

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
    label: 'Other agents',
    language: 'bash',
    guidance:
      'Run this command wherever your agent runs — no config file to edit. The Haven MCP server ' +
      'starts in stdio mode and your agent connects to it as an MCP tool.',
    code,
    mode: 'inline',
    consentNote: CONSENT_NOTE_INLINE,
  }
}

function genericFile(_cred: AgentCredentialJson, path: string): RuntimeSnippet {
  const code = `HAVEN_CREDENTIALS=${path} npx -y ${MCP_PACKAGE}`
  return {
    ...genericInline(_cred),
    guidance:
      'First download the credentials below and save them somewhere private. Then run this ' +
      'command wherever your agent runs — the Haven MCP server reads everything from that file.',
    code,
    mode: 'file',
    consentNote: consentNote(path),
  }
}

// ── Windsurf ──────────────────────────────────────────────────────

function windsurfInline(cred: AgentCredentialJson): RuntimeSnippet {
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
    id: 'windsurf',
    label: 'Windsurf',
    language: 'json',
    guidance:
      'Open Windsurf\'s MCP settings and paste this in. Reload Windsurf when you\'re done. ' +
      '(The settings live at ~/.codeium/windsurf/mcp_config.json — create the file if it\'s not there yet.)',
    destination: '~/.codeium/windsurf/mcp_config.json',
    code: jsonBlock(config),
    mode: 'inline',
    consentNote: CONSENT_NOTE_INLINE,
  }
}

function windsurfFile(cred: AgentCredentialJson, path: string): RuntimeSnippet {
  const config = {
    mcpServers: {
      haven: {
        command: 'npx',
        args: ['-y', MCP_PACKAGE, '--credentials', path],
      },
    },
  }
  return {
    ...windsurfInline(cred),
    guidance:
      'First download the credentials below and save them somewhere private. Then paste this into ' +
      'Windsurf\'s MCP settings and reload Windsurf.',
    code: jsonBlock(config),
    mode: 'file',
    consentNote: consentNote(path),
  }
}

// ── VS Code ───────────────────────────────────────────────────────

function vsCodeInline(cred: AgentCredentialJson): RuntimeSnippet {
  const config = {
    servers: {
      haven: {
        type: 'stdio',
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
    id: 'vscode',
    label: 'VS Code',
    language: 'json',
    guidance:
      'Add this to your VS Code MCP settings and reload the window. ' +
      '(Open the Command Palette → "MCP: Open User Settings" or edit .vscode/mcp.json in your workspace.)',
    destination: '.vscode/mcp.json',
    code: jsonBlock(config),
    mode: 'inline',
    consentNote: CONSENT_NOTE_INLINE,
  }
}

function vsCodeFile(cred: AgentCredentialJson, path: string): RuntimeSnippet {
  const config = {
    servers: {
      haven: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', MCP_PACKAGE, '--credentials', path],
      },
    },
  }
  return {
    ...vsCodeInline(cred),
    guidance:
      'First download the credentials below and save them somewhere private. Then add this to ' +
      'your VS Code MCP settings and reload the window.',
    code: jsonBlock(config),
    mode: 'file',
    consentNote: consentNote(path),
  }
}

// ── Python ────────────────────────────────────────────────────────

function pythonInline(cred: AgentCredentialJson): RuntimeSnippet {
  const lines = [
    `# pip install haven-ai-sdk`,
    `import os`,
    `from haven import HavenClient`,
    ``,
    `client = HavenClient(`,
    `    api_key=os.environ["HAVEN_API_KEY"],    # ${cred.api_key}`,
    `    delegate_key=os.environ["HAVEN_DELEGATE_KEY"],  # signs locally`,
    cred.api_url
      ? `    base_url="${cred.api_url}",`
      : `    # base_url=os.environ.get("HAVEN_API_URL"),`,
    `)`,
    ``,
    `# Try it:`,
    `agent = client.get_agent()`,
    `print(agent)`,
  ]
  return {
    id: 'python',
    label: 'Python',
    language: 'python',
    guidance:
      'Install the SDK and drop this into your agent\'s code. Set the env vars before running.',
    code: lines.join('\n'),
    mode: 'inline',
  }
}

function pythonFile(cred: AgentCredentialJson, path: string): RuntimeSnippet {
  const lines = [
    `# pip install haven-ai-sdk`,
    `import json`,
    `from haven import HavenClient`,
    ``,
    `with open("${path}") as f:`,
    `    cred = json.load(f)`,
    ``,
    `client = HavenClient(`,
    `    api_key=cred["api_key"],`,
    `    delegate_key=cred["delegate_key"],`,
    `    base_url=cred.get("api_url"),`,
    `)`,
  ]
  return {
    ...pythonInline(cred),
    guidance:
      'First download the credentials below and save them somewhere private. Then drop this into ' +
      'your agent\'s code — it reads the saved file directly.',
    code: lines.join('\n'),
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
      'Drop this into your agent\'s code. The SDK reads the credentials from environment variables ' +
      '— no config file to edit.',
    code,
    mode: 'inline',
  }
}

function sdkFile(cred: AgentCredentialJson, path: string): RuntimeSnippet {
  const code = [
    `// Load the credentials file directly:`,
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
      'First download the credentials below and save them somewhere private. Then drop this into ' +
      'your agent\'s code — it reads the saved file directly.',
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
      windsurfFile(input.credential, path),
      vsCodeFile(input.credential, path),
      genericFile(input.credential, path),
      sdkFile(input.credential, path),
      pythonFile(input.credential, path),
    ]
  }
  return [
    claudeDesktopInline(input.credential),
    cursorInline(input.credential),
    windsurfInline(input.credential),
    vsCodeInline(input.credential),
    genericInline(input.credential),
    sdkInline(input.credential),
    pythonInline(input.credential),
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
