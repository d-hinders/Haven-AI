import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { access } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { ConnectError } from './connect-error.js'
import { runtimeConfigPathFor } from './config-writers.js'
import { runtimeProfile, type RuntimeId } from './runtime-registry.js'

/**
 * Installed-client scan + interactive pick (#1719).
 *
 * The rung that answers "which runtime am I configuring?" for a HUMAN in a
 * plain terminal, where there is no agent shell to detect. Two properties hold
 * it up, and both are load-bearing:
 *
 * 1. **Only clients the connector can actually write.** A row that cannot be
 *    configured is not a choice, it is a dead end wearing a choice's clothes.
 * 2. **The scan populates the choices; it never selects.** Finding exactly one
 *    installed app tells you what EXISTS, not where the user wants their agent
 *    to run — and the cost of being wrong is an API key and a delegate key
 *    written into an app the user does not use. `scanInstalledClients` returns
 *    candidates and nothing else; only an answer typed at the prompt resolves
 *    a runtime.
 */
export interface InstalledClientCandidate {
  runtime: RuntimeId
  label: string
  /** What made this a candidate — shown at the prompt so the pick is informed. */
  detail: string
  /**
   * The config file Haven would write for this client, when it owns one.
   * `null` for Claude Code, which is configured through its own CLI. Set
   * regardless of which evidence found the client — `evidence` is what says
   * whether that file exists today.
   */
  configPath: string | null
  evidence: 'config-file' | 'client-directory'
}

interface ScanTarget {
  runtime: RuntimeId
  label: string
  /** The config file the connector would write, when it owns a file path. */
  configPath: string | null
  /** Paths that mean "this client is installed" even with no MCP config yet. */
  markers: string[]
}

export interface ScanInstalledClientsOptions {
  homeDir?: string
  /** Workspace root, for the project-local `.vscode/` marker. */
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Injectable so the scan is testable without a populated home directory. */
  exists?: (path: string) => Promise<boolean>
}

/**
 * Ranked highest-confidence first WITHIN each evidence tier. An existing MCP
 * config file outranks a bare client directory across the board — a client the
 * user has already pointed at some MCP server is likelier to be the one they
 * are pointing at Haven now.
 */
const SCAN_ORDER: readonly RuntimeId[] = [
  'claude-code',
  'codex-cli',
  'cursor',
  'vscode',
  'vscode-insiders',
  'claude-desktop',
  'hermes',
]

export function installedClientTargets(
  homeDir: string = homedir(),
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): ScanTarget[] {
  const targets: ScanTarget[] = [
    {
      runtime: 'claude-code',
      label: 'Claude Code',
      // Claude Code is configured through its own CLI (`claude mcp add-json`),
      // not by writing a file this module owns — so its evidence is the
      // client directory, never a config path.
      configPath: null,
      markers: [join(homeDir, '.claude'), join(homeDir, '.claude.json')],
    },
    {
      runtime: 'codex-cli',
      // Both Codex surfaces write the same ~/.codex/config.toml, so they are
      // ONE candidate. Splitting them would ask the user to answer a question
      // whose answers are the same write.
      label: 'Codex (CLI or Desktop)',
      configPath: runtimeConfigPathFor('codex-cli', homeDir),
      markers: [join(homeDir, '.codex')],
    },
    {
      runtime: 'cursor',
      label: 'Cursor',
      configPath: runtimeConfigPathFor('cursor', homeDir),
      markers: [join(homeDir, '.cursor')],
    },
    {
      runtime: 'vscode',
      label: 'VS Code',
      configPath: runtimeConfigPathFor('vscode', homeDir),
      markers: [resolve(cwd, '.vscode')],
    },
    {
      runtime: 'vscode-insiders',
      label: 'VS Code Insiders',
      configPath: runtimeConfigPathFor('vscode-insiders', homeDir),
      markers: [],
    },
    {
      runtime: 'claude-desktop',
      label: 'Claude Desktop',
      configPath: runtimeConfigPathFor('claude-desktop', homeDir),
      markers: [],
    },
    {
      runtime: 'hermes',
      label: 'Hermes Agent',
      configPath: runtimeConfigPathFor('hermes', homeDir),
      markers: [env.HERMES_HOME ?? join(homeDir, '.hermes')],
    },
  ]
  // Belt and braces against a future profile losing its writer: an unwritable
  // runtime must never reach the prompt (property 1 above).
  return targets.filter((target) => runtimeProfile(target.runtime, {}).canWriteRuntimeConfig)
}

export async function scanInstalledClients(
  options: ScanInstalledClientsOptions = {},
): Promise<InstalledClientCandidate[]> {
  const exists = options.exists ?? pathExists
  const targets = installedClientTargets(options.homeDir, options.cwd, options.env ?? process.env)
  const found: InstalledClientCandidate[] = []
  for (const target of targets) {
    if (target.configPath && (await exists(target.configPath))) {
      found.push({
        runtime: target.runtime,
        label: target.label,
        detail: `MCP config found at ${target.configPath}`,
        configPath: target.configPath,
        evidence: 'config-file',
      })
      continue
    }
    for (const marker of target.markers) {
      if (!(await exists(marker))) continue
      found.push({
        runtime: target.runtime,
        label: target.label,
        detail: `installed (${marker})`,
        configPath: target.configPath,
        evidence: 'client-directory',
      })
      break
    }
  }
  return found.sort((a, b) => {
    if (a.evidence !== b.evidence) return a.evidence === 'config-file' ? -1 : 1
    return SCAN_ORDER.indexOf(a.runtime) - SCAN_ORDER.indexOf(b.runtime)
  })
}

/**
 * The scan's findings as DATA, for the `--json` refusal (#2174).
 *
 * The interactive prompt is deliberately omitted under `--json`, which threw
 * this signal away exactly where it was most useful: an agent retrying a
 * `runtime_undetermined` refusal picked from a nine-value menu on
 * self-knowledge alone, while the connector already knew which client configs
 * exist on the machine.
 *
 * Property 2 above is preserved verbatim and is the reason this returns a
 * HINT rather than a runtime: the caller still has to refuse. Finding exactly
 * one installed app tells you what exists, not where the user wants their
 * agent to run, and the cost of being wrong is an API key and a delegate key
 * written into an app they do not use.
 */
export interface InstalledClientHint {
  /** Runtime ids the scan found, likeliest first. */
  installedClients: readonly RuntimeId[]
  /**
   * The top hit, and only when it is unambiguously top — see
   * `installedClientHint`. A value an agent may echo back as `--runtime`;
   * never a selection the connector makes for it.
   */
  suggestedRuntime?: RuntimeId
}

/**
 * A suggestion is offered only when the scan's own ranking makes one candidate
 * CLEARLY first: a lone candidate, or a live MCP config file outranking
 * everything else, which is the one tier difference the scan treats as
 * evidence. Two candidates in the same tier are separated only by `SCAN_ORDER`
 * — a fixed preference, not a fact about this machine — so suggesting the
 * winner of that tiebreak would dress an arbitrary choice as a finding.
 */
export function installedClientHint(
  candidates: readonly InstalledClientCandidate[],
): InstalledClientHint {
  const installedClients = candidates.map((candidate) => candidate.runtime)
  const [first, second] = candidates
  if (!first) return { installedClients }
  const clearlyFirst = !second
    || (first.evidence === 'config-file' && second.evidence !== 'config-file')
  return clearlyFirst
    ? { installedClients, suggestedRuntime: first.runtime }
    : { installedClients }
}

export interface PromptIo {
  write: (text: string) => void
  /** Resolves the typed line, or `null` on EOF / Ctrl-C. */
  question: (query: string) => Promise<string | null>
}

/** Bounded so a piped-but-TTY-looking stdin cannot spin forever. */
const MAX_PROMPT_ATTEMPTS = 3

export async function promptForInstalledClient(
  candidates: readonly InstalledClientCandidate[],
  io: PromptIo = defaultPromptIo(),
): Promise<RuntimeId> {
  if (candidates.length === 0) throw noInstalledClientsError()
  io.write('Haven could not detect which agent runtime this is.\n')
  io.write('These agent clients are installed on this machine:\n')
  candidates.forEach((candidate, index) => {
    io.write(`  ${index + 1}) ${candidate.label} — ${candidate.detail}\n`)
  })
  io.write('Haven writes an API key and a signing key into the client you pick, so pick the one your agent actually runs in.\n')

  for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt += 1) {
    const answer = await io.question(`Which one? [1-${candidates.length}] (default 1 — ${candidates[0].label}): `)
    if (answer === null) throw promptAbortedError('the prompt was cancelled')
    const trimmed = answer.trim()
    // Empty ACCEPTS the pre-selected default. That is still a choice the user
    // made at the prompt — the scan itself never gets to select (property 2).
    if (trimmed === '') return candidates[0].runtime
    const picked = Number.parseInt(trimmed, 10)
    if (Number.isInteger(picked) && picked >= 1 && picked <= candidates.length) {
      return candidates[picked - 1].runtime
    }
    io.write(`"${trimmed}" is not one of 1-${candidates.length}.\n`)
  }
  throw promptAbortedError(`no valid choice after ${MAX_PROMPT_ATTEMPTS} attempts`)
}

/**
 * The whole rung as one thunk: scan, refuse if nothing writable is installed,
 * otherwise prompt. This is what `resolveRuntimeSelection` calls, which is why
 * the registry needs no knowledge of the filesystem or of readline.
 */
export async function resolveRuntimeByInstalledClientPrompt(
  options: ScanInstalledClientsOptions & { io?: PromptIo } = {},
): Promise<RuntimeId> {
  const candidates = await scanInstalledClients(options)
  if (candidates.length === 0) throw noInstalledClientsError()
  return promptForInstalledClient(candidates, options.io ?? defaultPromptIo())
}

function noInstalledClientsError(): ConnectError {
  return new ConnectError(
    'runtime_no_installed_clients',
    'Could not determine the agent runtime: nothing was detected in this environment, and no agent client Haven can configure is installed on this machine. ' +
      'Re-run with --runtime <name> naming the client you want configured, or --runtime other to store credentials and finish the MCP setup by hand.',
    'rerun_connect_with_explicit_runtime',
  )
}

function promptAbortedError(reason: string): ConnectError {
  return new ConnectError(
    'runtime_prompt_aborted',
    `Runtime not chosen (${reason}). Nothing was written: no agent was created, no credentials were stored, and the Haven setup token is still unused. ` +
      'Run the setup command again, or pass --runtime <name> to skip the prompt.',
    'rerun_connect_and_choose_a_runtime',
  )
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function defaultPromptIo(): PromptIo {
  return {
    write: (text) => process.stdout.write(text),
    question: (query) =>
      new Promise<string | null>((resolvePromise) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout })
        let settled = false
        const settle = (value: string | null) => {
          if (settled) return
          settled = true
          rl.close()
          resolvePromise(value)
        }
        // Without an explicit SIGINT listener readline's Ctrl-C behaviour
        // depends on the host; with one, Ctrl-C is an abort we report as such
        // and exit non-zero from, having written nothing.
        rl.once('SIGINT', () => settle(null))
        rl.once('close', () => settle(null))
        rl.question(query, (answer) => settle(answer))
      }),
  }
}
