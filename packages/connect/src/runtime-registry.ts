export type RuntimeId =
  | 'claude-code'
  | 'codex-desktop'
  | 'codex-cli'
  | 'cursor'
  | 'vscode'
  | 'vscode-insiders'
  | 'claude-desktop'
  | 'other'

export type RestartMode = 'restart-session' | 'restart-app' | 'hot-reload' | 'manual'

export interface RuntimeProfile {
  id: RuntimeId
  label: string
  restartMode: RestartMode
  canWriteRuntimeConfig: boolean
}

const RUNTIME_PROFILES: Record<RuntimeId, RuntimeProfile> = {
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    restartMode: 'restart-session',
    canWriteRuntimeConfig: true,
  },
  'codex-cli': {
    id: 'codex-cli',
    label: 'Codex CLI',
    restartMode: 'restart-session',
    canWriteRuntimeConfig: true,
  },
  'codex-desktop': {
    id: 'codex-desktop',
    label: 'Codex Desktop',
    restartMode: 'restart-session',
    canWriteRuntimeConfig: true,
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    restartMode: 'hot-reload',
    canWriteRuntimeConfig: true,
  },
  vscode: {
    id: 'vscode',
    label: 'VS Code',
    restartMode: 'hot-reload',
    canWriteRuntimeConfig: true,
  },
  'vscode-insiders': {
    id: 'vscode-insiders',
    label: 'VS Code Insiders',
    restartMode: 'hot-reload',
    canWriteRuntimeConfig: true,
  },
  'claude-desktop': {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    restartMode: 'restart-app',
    canWriteRuntimeConfig: true,
  },
  other: {
    id: 'other',
    label: 'Other agent runtime',
    restartMode: 'manual',
    canWriteRuntimeConfig: false,
  },
}

const RUNTIME_ALIASES: Record<string, RuntimeId> = {
  claude: 'claude-code',
  'claude-code': 'claude-code',
  claudecode: 'claude-code',
  'claude_code': 'claude-code',
  codex: 'codex-cli',
  'codex-cli': 'codex-cli',
  codexcli: 'codex-cli',
  'codex_cli': 'codex-cli',
  'codex-desktop': 'codex-desktop',
  'codex_desktop': 'codex-desktop',
  codexdesktop: 'codex-desktop',
  'codex-app': 'codex-desktop',
  'codex_app': 'codex-desktop',
  codexapp: 'codex-desktop',
  cursor: 'cursor',
  vscode: 'vscode',
  'vs-code': 'vscode',
  'vs_code': 'vscode',
  code: 'vscode',
  'vscode-insiders': 'vscode-insiders',
  'vscode_insiders': 'vscode-insiders',
  vscodeinsiders: 'vscode-insiders',
  'vs-code-insiders': 'vscode-insiders',
  'code-insiders': 'vscode-insiders',
  insiders: 'vscode-insiders',
  'claude-desktop': 'claude-desktop',
  'claude_desktop': 'claude-desktop',
  claudesktop: 'claude-desktop',
  desktop: 'claude-desktop',
  other: 'other',
  manual: 'other',
}

export function runtimeProfile(runtime: string | undefined, env: NodeJS.ProcessEnv = process.env): RuntimeProfile {
  return RUNTIME_PROFILES[normalizeRuntime(runtime, env)]
}

export function normalizeRuntime(runtime: string | undefined, env: NodeJS.ProcessEnv = process.env): RuntimeId {
  const explicit = normalizeRuntimeName(runtime)
  if (explicit) return explicit
  return detectRuntime(env) ?? 'other'
}

export function restartRequiredForRuntime(runtime: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = runtimeProfile(runtime, env).restartMode
  return mode === 'restart-session' || mode === 'restart-app'
}

/**
 * Desktop GUI runtimes really do require a restart for the user to see the new
 * MCP server — the MCP server lifecycle is tied to app launch, not to the
 * current conversation. The agent who reported the "restart not needed"
 * surprise was using Claude Code (a CLI session that picks up new MCP servers
 * in-session via the deferred-tool mechanism). Don't softpedal the restart
 * instruction on Claude Desktop / Codex Desktop just because Claude Code is
 * looser about it.
 */
export function runtimeRequiresHardRestart(runtime: RuntimeId): boolean {
  return runtime === 'claude-desktop' || runtime === 'codex-desktop'
}

function normalizeRuntimeName(runtime: string | undefined): RuntimeId | null {
  const key = runtime?.trim().toLowerCase()
  if (!key) return null
  return RUNTIME_ALIASES[key.replace(/\s+/g, '-')] ?? null
}

function detectRuntime(env: NodeJS.ProcessEnv): RuntimeId | null {
  if (env.CLAUDECODE || env.CLAUDE_CODE || env.CLAUDECODE_CWD) return 'claude-code'
  if (env.CODEX_SANDBOX || env.CODEX_HOME || env.CODEX_CWD) return 'codex-cli'
  if (env.VSCODE_CWD || env.VSCODE_IPC_HOOK_CLI || env.TERM_PROGRAM === 'vscode') return 'vscode'
  return null
}
