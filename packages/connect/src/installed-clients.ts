import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { access, readFile as fsReadFile } from 'node:fs/promises'
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
  /**
   * The file the config-file evidence was found in, when this candidate
   * carries that tier. Usually the same file `configPath` names — except for
   * Claude Code, whose evidence lives in `~/.claude.json` while `configPath`
   * stays `null` (the connector would configure it through its own CLI, not
   * by writing a file it owns).
   */
  evidencePath?: string | null
  evidence: 'config-file' | 'client-directory'
}

interface ScanTarget {
  runtime: RuntimeId
  label: string
  /** The config file the connector would write, when it owns a file path. */
  configPath: string | null
  /**
   * A file whose existence grants config-file evidence even when the
   * connector does not own it for writing (`configPath` null). Set only for
   * Claude Code: a user-scope `~/.claude.json` that carries an `mcpServers`
   * key means Claude Code has already been pointed at some MCP server.
   */
  evidencePath?: string
  /**
   * Extra condition on the evidence file's CONTENT (absent: existence alone
   * is evidence). Claude Code needs it — a `~/.claude.json` without an
   * `mcpServers` key is only a directory-tier marker, as before.
   */
  evidenceMatches?: (contents: string) => boolean
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
  /** Injectable so the `mcpServers` evidence check is testable without a real file. */
  readFile?: (path: string) => Promise<string>
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
      // not by writing a file this module owns — so `configPath` stays null
      // and the write still goes through the CLI. But a user-scope
      // `~/.claude.json` carrying an `mcpServers` key IS config-file
      // evidence: the user has already pointed Claude Code at some MCP
      // server. It is not the file the connector would write, hence the
      // separate evidence path (#3732): without it, a Codex config won by
      // construction on any machine where the user runs Claude Code.
      configPath: null,
      evidencePath: join(homeDir, '.claude.json'),
      evidenceMatches: (contents) => {
        try {
          const parsed: unknown = JSON.parse(contents)
          return typeof parsed === 'object' && parsed !== null && 'mcpServers' in parsed
        } catch {
          return false
        }
      },
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
      // The chat app, a separate runtime from Claude Code. Named so a user in
      // the desktop app's Code tab cannot read this row as "where I am" —
      // it sorted above Claude Code whenever both had config (#3732).
      label: 'Claude Desktop (chat app)',
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
  const readFile = options.readFile ?? ((path: string) => fsReadFile(path, 'utf8'))
  const targets = installedClientTargets(options.homeDir, options.cwd, options.env ?? process.env)
  const found: InstalledClientCandidate[] = []
  for (const target of targets) {
    if (target.configPath && (await exists(target.configPath))) {
      found.push({
        runtime: target.runtime,
        label: target.label,
        detail: `MCP config found at ${target.configPath}`,
        configPath: target.configPath,
        evidencePath: target.configPath,
        evidence: 'config-file',
      })
      continue
    }
    if (target.evidencePath && (await hasConfigEvidence(target, exists, readFile))) {
      found.push({
        runtime: target.runtime,
        label: target.label,
        detail: `MCP config found at ${target.evidencePath}`,
        configPath: target.configPath,
        evidencePath: target.evidencePath,
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
        evidencePath: null,
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
 * Whether the target's separate evidence path earns config-file evidence:
 * the file must exist, and when the target pins a content rule
 * (`evidenceMatches`), the file must satisfy it. A file that cannot be READ
 * grants nothing — unreadable is not evidence (#3732).
 */
async function hasConfigEvidence(
  target: ScanTarget,
  exists: (path: string) => Promise<boolean>,
  readFile: (path: string) => Promise<string>,
): Promise<boolean> {
  const path = target.evidencePath as string
  if (!(await exists(path))) return false
  if (!target.evidenceMatches) return true
  try {
    return target.evidenceMatches(await readFile(path))
  } catch {
    return false
  }
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
 * A suggestion is offered only when one candidate is CLEARLY first: a lone
 * candidate, or a single live MCP config file among bare client directories —
 * the one tier difference the scan treats as evidence. Candidates within a
 * tier are separated only by `SCAN_ORDER`, a fixed preference rather than a
 * fact about this machine, so suggesting the winner of that tiebreak would
 * dress an arbitrary choice as a finding.
 *
 * The suggestion is derived from the WHOLE array rather than from the first
 * two entries, so it does not depend on the caller having sorted anything.
 * This is exported, and an unsorted list reaching a positional rule would
 * yield a quietly wrong suggestion — never a selection, since only the caller
 * can act on it, but wrong is still wrong. `installedClients` preserves the
 * order it was given, which for `scanInstalledClients` is likeliest-first.
 */
export function installedClientHint(
  candidates: readonly InstalledClientCandidate[],
): InstalledClientHint {
  const installedClients = candidates.map((candidate) => candidate.runtime)
  if (candidates.length === 1) {
    return { installedClients, suggestedRuntime: candidates[0].runtime }
  }
  const configured = candidates.filter((candidate) => candidate.evidence === 'config-file')
  return configured.length === 1
    ? { installedClients, suggestedRuntime: configured[0].runtime }
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
  const hint = installedClientHint(candidates)
  io.write('Haven could not detect which agent runtime this is.\n')
  io.write('These agent clients are installed on this machine:\n')
  candidates.forEach((candidate, index) => {
    // The suggested runtime may be MARKED (a hint, from `installedClientHint`)
    // but is never pre-selected: an untyped Enter must not write an API key
    // and a delegate key into whichever client sorts first (#3732).
    const suggested = hint.suggestedRuntime === candidate.runtime ? ' (suggested)' : ''
    io.write(`  ${index + 1}) ${candidate.label}${suggested} — ${candidate.detail}\n`)
  })
  io.write('Haven writes an API key and a signing key into the client you pick, so pick the one your agent actually runs in.\n')

  for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt += 1) {
    const answer = await io.question(`Which one? [1-${candidates.length}]: `)
    if (answer === null) throw promptAbortedError('the prompt was cancelled')
    const trimmed = answer.trim()
    // Empty input is NOT a default (#3732, owner decision 2026-10-07): the
    // scan populates the choices; it never selects — and neither does an
    // untyped Enter, which would write live keys into whichever client sorts
    // first. Avoiding it costs one keystroke; being wrong costs a key in a
    // client the user does not use. Re-ask, spending an attempt, exactly
    // like the wiring-collision prompt ("Empty input is NOT a default",
    // wiring-collision.ts).
    if (trimmed === '') {
      io.write(`Type the number of the client to configure (1-${candidates.length}).\n`)
      continue
    }
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
      'Run the connector command again, or pass --runtime <name> to skip the prompt.',
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

/**
 * The readline-backed prompt IO, shared with the #2551 wiring-collision prompt
 * so the two interactive rungs cannot drift on Ctrl-C / EOF handling.
 */
export function defaultPromptIo(): PromptIo {
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
