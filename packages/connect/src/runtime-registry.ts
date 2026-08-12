export type RuntimeId =
  | 'claude-code'
  | 'codex-desktop'
  | 'codex-cli'
  | 'cursor'
  | 'vscode'
  | 'vscode-insiders'
  | 'claude-desktop'
  | 'hermes'
  | 'other'

export type RestartMode = 'restart-session' | 'restart-app' | 'hot-reload' | 'manual'

export interface RuntimeProfile {
  id: RuntimeId
  label: string
  restartMode: RestartMode
  canWriteRuntimeConfig: boolean
  /** Precise, runtime-owned instruction for loading a freshly written MCP entry. */
  activationInstruction: string
}

const RUNTIME_PROFILES: Record<RuntimeId, RuntimeProfile> = {
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    restartMode: 'restart-session',
    canWriteRuntimeConfig: true,
    activationInstruction: 'Start a new Claude Code session so it loads the Haven MCP entries.',
  },
  'codex-cli': {
    id: 'codex-cli',
    label: 'Codex CLI',
    restartMode: 'restart-session',
    canWriteRuntimeConfig: true,
    activationInstruction: 'Start a fresh Codex CLI session (for example, run `codex resume --last`).',
  },
  'codex-desktop': {
    id: 'codex-desktop',
    label: 'Codex Desktop',
    restartMode: 'restart-session',
    canWriteRuntimeConfig: true,
    activationInstruction: 'Quit and reopen Codex Desktop so it loads the Haven MCP entries.',
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    restartMode: 'hot-reload',
    canWriteRuntimeConfig: true,
    activationInstruction: 'Wait for Cursor to hot-reload the Haven MCP entries; no app restart is required.',
  },
  vscode: {
    id: 'vscode',
    label: 'VS Code',
    restartMode: 'hot-reload',
    canWriteRuntimeConfig: true,
    activationInstruction: 'Wait for VS Code to hot-reload the Haven MCP entries; no app restart is required.',
  },
  'vscode-insiders': {
    id: 'vscode-insiders',
    label: 'VS Code Insiders',
    restartMode: 'hot-reload',
    canWriteRuntimeConfig: true,
    activationInstruction: 'Wait for VS Code Insiders to hot-reload the Haven MCP entries; no app restart is required.',
  },
  'claude-desktop': {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    restartMode: 'restart-app',
    canWriteRuntimeConfig: true,
    activationInstruction: 'Quit and reopen Claude Desktop so it loads the Haven MCP entries.',
  },
  hermes: {
    id: 'hermes',
    label: 'Hermes Agent',
    restartMode: 'restart-session',
    canWriteRuntimeConfig: true,
    activationInstruction: 'Start a new Hermes session; in Hermes Gateway, run `/restart` instead.',
  },
  other: {
    id: 'other',
    label: 'Other agent runtime',
    restartMode: 'manual',
    canWriteRuntimeConfig: false,
    activationInstruction: 'Finish the manual MCP setup shown above, then start a fresh session in that runtime.',
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
  hermes: 'hermes',
  'hermes-agent': 'hermes',
  hermes_agent: 'hermes',
  hermesagent: 'hermes',
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

/**
 * The one safe post-activation check for every supported topology. It only
 * reads the connected agent and its live budget; it never signs, funds, or
 * creates a payment.
 */
export function runtimeVerificationInstruction(runtime: RuntimeId): string {
  const label = RUNTIME_PROFILES[runtime].label
  return `In ${label}, run the read-only \`haven_get_agent\` and \`haven_get_allowances\` tools to confirm the Haven wallet and live budget. Do not sign, fund, or create a payment to verify setup.`
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
  if (env.HERMES_HOME || env.HERMES_AGENT) return 'hermes'
  return null
}
