import { ConnectError } from './connect-error.js'

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
  // #1682: Cowork runs Claude Code's config, so it resolves to the same
  // profile. The dashboard's command carries no --runtime for it (it is a
  // detected, command-path runtime), but an explicit `--runtime cowork` typed
  // by hand must not fall through to the no-runtime refusal.
  cowork: 'claude-code',
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
  // #1682: OpenClaw is a SNIPPET target — the user pastes an mcpServers entry
  // into ~/.openclaw/openclaw.json and restarts the gateway. That is exactly
  // the 'other' profile's behaviour (credentials written to disk, no config
  // auto-written, manual finish), so it resolves there rather than earning a
  // profile whose only distinguishing feature would be its label.
  openclaw: 'other',
  'open-claw': 'other',
  'open_claw': 'other',
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

/**
 * The flag values a refusal should offer, as data (#2091): they ride on the
 * refusal's `ConnectError.details.allowedRuntimes` so the `--json` contract
 * can list them machine-readably, not only in prose an automation run never
 * sees. Mirrors RuntimeId.
 */
export const RUNTIME_FLAG_VALUE_LIST = [
  'claude-code',
  'codex-cli',
  'codex-desktop',
  'cursor',
  'vscode',
  'vscode-insiders',
  'claude-desktop',
  'hermes',
  'other',
] as const satisfies readonly RuntimeId[]

/** The same values as refusal-message prose. */
export const RUNTIME_FLAG_VALUES = RUNTIME_FLAG_VALUE_LIST.join(', ')

export interface RuntimeSelection {
  runtime: RuntimeId | null
  source: 'force' | 'detected' | 'explicit' | 'prompted' | 'none'
  /** Set when a confident environment detection overrode a contradicting explicit hint (#1672). */
  overrodeHint?: RuntimeId
  /** Set when a supplied hint was not a runtime name at all and detection carried the run (#1719). */
  discardedHint?: string
}

export interface RuntimeResolutionOptions {
  env?: NodeJS.ProcessEnv
  /**
   * Rung 3b (#1719): the harness an AGENT executing this command reported for
   * ITSELF, when detection found nothing to go on.
   *
   * It deliberately enters at the same precedence as `--runtime`, which is
   * what makes it safe: a hint can only ever fill a vacuum, and loses to a
   * confident detection exactly as #1672 made it. In practice the agent
   * supplies it BY re-running with `--runtime <name>`; this field exists so a
   * programmatic caller can pass a self-report without pretending to be a
   * command-line flag, and so the ladder names the rung it has.
   */
  selfReported?: string
  /**
   * Rung 4 (#1719): ask a human at an interactive terminal which of the
   * clients installed on this machine to configure. Injected as a thunk so
   * the ladder stays a policy function — the scan, the readline prompt, and
   * the "nothing writable is installed" refusal all live in
   * `installed-clients.ts`. Omitted (`--json`, no TTY, library callers) means
   * the rung is skipped entirely, not answered with a guess.
   */
  promptForRuntime?: () => Promise<RuntimeId>
}

/**
 * Runtime resolution, detection-first (#1672) and self-resolving (#1719).
 *
 * The setup command carries no `--runtime`; the connector works out the
 * runtime it is executing inside. Precedence:
 *
 * 1. `--runtime-force <name>` — always wins (unknown name refuses).
 * 2. Environment detection over a CONTRADICTING hint. Detection only fires
 *    inside a real agent shell, where writing a different client's config is
 *    almost surely wrong — the claude-desktop-hint-in-Claude-Code dead end
 *    this exists to close.
 * 3. An explicit `--runtime`, or an agent's self-report, with no contradicting
 *    detection (the legit plain-terminal "configure Claude Desktop by hand"
 *    case — unchanged).
 * 4. Detection alone.
 * 5. An interactive pick among the clients actually installed here, when a
 *    human is at a TTY. The scan populates the choices; it never selects.
 * 6. Nothing known → `runtime: null`; the caller refuses BEFORE side effects
 *    rather than guessing a config location.
 *
 * A hint that is not a runtime name at all is not a hint — it is a mistake, and
 * the one thing it must never do is fall through to a config location nobody
 * asked for. With no detection to fall back on it refuses (`runtime_unrecognized`).
 * With a detection it loses to it, loudly, exactly like a contradicting hint:
 * the detected client is the right write either way, and refusing there would
 * turn every rollout window in which the dashboard learns an id before the
 * published connector does into a hard failure.
 */
export async function resolveRuntimeSelection(
  explicit: string | undefined,
  force: string | undefined,
  options: RuntimeResolutionOptions = {},
): Promise<RuntimeSelection> {
  const env = options.env ?? process.env
  if (force !== undefined) {
    const forced = normalizeRuntimeName(force)
    if (!forced) {
      throw new ConnectError(
        'runtime_force_unrecognized',
        `Unknown --runtime-force value "${force}". Valid values: ${RUNTIME_FLAG_VALUES}.`,
        'rerun_connect_with_a_valid_runtime_name',
        { allowedRuntimes: RUNTIME_FLAG_VALUE_LIST },
      )
    }
    return { runtime: forced, source: 'force' }
  }
  const detected = detectRuntime(env)
  const supplied = explicit?.trim() || options.selfReported?.trim() || undefined
  const hint = normalizeRuntimeName(supplied)
  if (supplied && !hint) {
    if (!detected) {
      throw new ConnectError(
        'runtime_unrecognized',
        `"${supplied}" is not an agent runtime Haven knows. Valid values: ${RUNTIME_FLAG_VALUES} ` +
          '(the aliases cowork, codex and openclaw are accepted too). ' +
          'Re-run with one of those, or --runtime other to store credentials and finish the MCP setup by hand. ' +
          'Nothing was written and the Haven setup token is still unused.',
        'rerun_connect_with_a_valid_runtime_name',
        { allowedRuntimes: RUNTIME_FLAG_VALUE_LIST },
      )
    }
    return { runtime: detected, source: 'detected', discardedHint: supplied }
  }
  if (detected && hint && detected !== hint) {
    return { runtime: detected, source: 'detected', overrodeHint: hint }
  }
  if (hint) return { runtime: hint, source: 'explicit' }
  if (detected) return { runtime: detected, source: 'detected' }
  if (options.promptForRuntime) {
    return { runtime: await options.promptForRuntime(), source: 'prompted' }
  }
  return { runtime: null, source: 'none' }
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
