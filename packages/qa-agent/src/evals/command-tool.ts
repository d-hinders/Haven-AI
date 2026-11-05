/**
 * The cold profile's ONE eval-only MCP tool (#4680).
 *
 * A cold agent gets the dev landing URL and "Set it all up so my agent can pay
 * for things", with no path named. It needs to run the CLI the deployment's
 * manifest serves — but `Bash` stays denied, because a shell-prefix allowlist
 * is too easy to get wrong. So this tool runs a command from an **argv array
 * with no shell**, and accepts only:
 *
 *   npx [-y] <the CLI package the manifest serves> <allowed subcommand> …
 *
 * The package is read at TRIAL START from the deployment's manifest
 * (`packages.cli.one_liner`), never baked into the task file, so the task
 * follows the product. The subcommands are the ones that make sense before the
 * login wall: `--help`, `--version`, `login`, `logout`, `whoami`, `guide`, and
 * the read-only `wallets` / `activity` / `catalog` / `contacts` subcommands.
 * `agents connect` is deliberately absent — it is #4682's slice.
 *
 * The tool has a neutral name and description that hint at no path: an agent
 * that reads "run a command-line tool" learns nothing about `/for-agents.md`.
 *
 * ## Why the validation is a closed allowlist, not a denylist
 *
 * `&& env`, `$(…)`, backticks, `;`, `|`, `<`, `>` and quotes are refused by
 * the argv charset alone; an alternate package is refused by the package
 * equality check; a file read is refused because `argv[0]` must be `npx`; an
 * arbitrary subcommand is refused by the subcommand map. Every refusal names
 * the rule, never the value, so a transcript cannot leak what it tried.
 *
 * ## The environment
 *
 * The child gets a SCRUBBED env: no `HAVEN_CREDENTIALS`, no
 * `QA_EVAL_AGENT_API_KEY`, no `AGENT_EVALS_DELEGATE_KEY`, no
 * `CLAUDE_CODE_OAUTH_TOKEN`. `HOME` is the trial's own directory, so
 * `haven login` writes a session that cannot warm a later trial.
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { createInterface } from 'node:readline'

/** The tool's neutral name — it hints at no path. */
export const COMMAND_TOOL_NAME = 'run_command'

/** The tool's neutral description — it hints at no path. */
export const COMMAND_TOOL_DESCRIPTION = 'Run a command-line tool and return its output.'

/** The env var carrying the CLI package spec the manifest served at trial start. */
export const CLI_PACKAGE_ENV = 'QA_EVAL_CLI_PACKAGE'

/** The env var carrying the trial's own HOME (also the child's cwd). */
export const TRIAL_HOME_ENV = 'QA_EVAL_TRIAL_HOME'

/** The env var bounding one command, ms. */
export const COMMAND_TIMEOUT_ENV = 'QA_EVAL_COMMAND_TIMEOUT_MS'

/** The default bound: two minutes is enough for `npx` to resolve and run. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000

/**
 * The argv charset. Deliberately narrow: no whitespace, no shell
 * metacharacters (`& | ; < > ( ) { } [ ] * ? ~ ! # % ^ \` $`), no quotes.
 * A URL's `:` `/` `.` and a device code's `-` `_` survive.
 */
const SAFE_ARG = /^[A-Za-z0-9@._:/=+_-]+$/

/**
 * The subcommands that make sense before the login wall. `'any'` means the
 * remaining argv is flags/values (login's `--poll <code>`, `--api <url>`);
 * an array means the NEXT token must be one of the read-only subcommands.
 */
const ALLOWED_SUBCOMMANDS: Record<string, readonly string[] | 'any'> = {
  '--help': 'any',
  '--version': 'any',
  login: 'any',
  logout: 'any',
  whoami: 'any',
  guide: 'any',
  wallets: ['list', 'balances', 'funding'],
  activity: ['list', 'export'],
  catalog: ['list'],
  contacts: ['list'],
}

/** The env names the command child inherits — an allowlist, never `{...process.env}`. */
export const COMMAND_ENV_ALLOWLIST = [
  'PATH', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'TMPDIR', 'TEMP', 'TMP', 'PWD', 'HOSTNAME',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'NPM_CONFIG_CACHE', 'npm_config_cache',
] as const

export interface CommandRequest {
  /** The argv array. `argv[0]` must be `npx`. */
  argv: string[]
}

export type CommandValidation =
  | { ok: true; argv: string[] }
  | { ok: false; reason: string }

/**
 * Validate one request against the closed allowlist. PURE — the adversarial
 * tests call it directly, and the server calls it before spawning anything.
 *
 * `cliPackage` is the spec the manifest served at trial start. An empty one
 * refuses every request: the tool cannot guess which package to run.
 */
export function validateCommandRequest(request: unknown, cliPackage: string): CommandValidation {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return { ok: false, reason: 'the request must be an object with an argv array' }
  }
  const argv = (request as { argv?: unknown }).argv
  if (!Array.isArray(argv) || argv.length === 0) {
    return { ok: false, reason: 'argv must be a non-empty array of strings' }
  }
  if (!argv.every((a): a is string => typeof a === 'string')) {
    return { ok: false, reason: 'every argv element must be a string' }
  }
  if (!cliPackage) {
    return { ok: false, reason: 'the CLI package was not read from the manifest at trial start — refusing to guess' }
  }
  // The charset check comes FIRST: it refuses `&& env`, `$(…)`, backticks,
  // `;`, `|`, redirects and quotes before any structural rule can be fooled.
  for (const arg of argv) {
    if (!SAFE_ARG.test(arg)) {
      return { ok: false, reason: 'an argv element contains a character outside the allowed set (no shell metacharacters, whitespace or quotes)' }
    }
  }
  if (argv[0] !== 'npx') {
    return { ok: false, reason: 'argv[0] must be "npx" — this tool runs the CLI the manifest serves, nothing else' }
  }
  let i = 1
  if (argv[i] === '-y') i += 1
  if (argv[i] !== cliPackage) {
    return { ok: false, reason: 'the package must be the CLI package the manifest serves at trial start' }
  }
  i += 1
  const subcommand = argv[i]
  if (subcommand === undefined) {
    return { ok: false, reason: 'a subcommand is required (--help, --version, login, whoami, …)' }
  }
  const allowed = ALLOWED_SUBCOMMANDS[subcommand]
  if (allowed === undefined) {
    return { ok: false, reason: 'that subcommand is not allowed before the login wall' }
  }
  if (allowed !== 'any') {
    const next = argv[i + 1]
    if (next === undefined || !allowed.includes(next)) {
      return { ok: false, reason: `that ${subcommand} subcommand is not read-only — allowed: ${allowed.join(', ')}` }
    }
  }
  return { ok: true, argv: [...argv] }
}

/** The scrubbed env the command child gets: allowlist + the trial's own HOME. */
export function buildCommandEnv(base: NodeJS.ProcessEnv, trialHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of COMMAND_ENV_ALLOWLIST) {
    const value = base[name]
    if (value !== undefined) env[name] = value
  }
  env.HOME = trialHome
  env.PWD = trialHome
  return env
}

export interface CommandOutcome {
  ok: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  /** True when the bound expired and the child was killed. */
  timedOut?: boolean
}

/** The minimal child-process surface the tool uses. */
export interface ChildLike {
  stdout?: { on(event: 'data', cb: (chunk: Buffer) => void): unknown } | null
  stderr?: { on(event: 'data', cb: (chunk: Buffer) => void): unknown } | null
  on(event: 'error', cb: (err: Error) => void): unknown
  on(event: 'close', cb: (code: number | null) => void): unknown
  kill(signal?: string): unknown
}

/** Injectable spawn, so a unit test can prove the argv/env without running npx. */
export type SpawnFn = (command: string, args: string[], opts: Record<string, unknown>) => ChildLike

/**
 * Run one validated argv with NO shell. `shell: false` is the whole point:
 * the argv array is the command, so `&& env` is an argument, not a second
 * command — and the validator refuses it before it gets here anyway.
 */
export function runCommand(
  argv: string[],
  opts: { trialHome: string; env: NodeJS.ProcessEnv; timeoutMs?: number; spawn?: SpawnFn },
): Promise<CommandOutcome> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  const spawn: SpawnFn = opts.spawn ?? (nodeSpawn as unknown as SpawnFn)
  return new Promise((resolve) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    const done = (outcome: CommandOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }
    const child = spawn(argv[0]!, argv.slice(1), {
      shell: false,
      cwd: opts.trialHome,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      done({ ok: false, exitCode: null, stdout, stderr, timedOut: true })
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = `${stdout}${chunk}`.slice(-20_000)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk}`.slice(-20_000)
    })
    child.on('error', (err) => done({ ok: false, exitCode: null, stdout, stderr: `${stderr}${err.message}` }))
    child.on('close', (code) => done({ ok: code === 0, exitCode: code, stdout, stderr }))
  })
}

// ── The MCP stdio server ───────────────────────────────────────────────────
//
// MCP over stdio is newline-delimited JSON-RPC 2.0. Hand-rolled on purpose:
// the tool is ~40 lines of protocol, and a dependency on the MCP SDK would
// put a second copy of it in the qa-agent package for no gain.

interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: unknown
}

const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    argv: {
      type: 'array',
      items: { type: 'string' },
      description: 'The command and its arguments, as separate strings. No shell is used.',
    },
  },
  required: ['argv'],
  additionalProperties: false,
} as const

/** One JSON-RPC response for one request, or undefined for a notification. */
export async function handleRpc(
  request: JsonRpcRequest,
  deps: { cliPackage: string; trialHome: string; env: NodeJS.ProcessEnv; timeoutMs?: number; spawn?: SpawnFn },
): Promise<Record<string, unknown> | undefined> {
  const id = request.id
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result })
  const error = (code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
  switch (request.method) {
    case 'initialize':
      return reply({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'eval-command', version: '0.0.0' },
      })
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: [{ name: COMMAND_TOOL_NAME, description: COMMAND_TOOL_DESCRIPTION, inputSchema: TOOL_SCHEMA }] })
    case 'tools/call': {
      const params = request.params as { name?: unknown; arguments?: unknown } | undefined
      if (params?.name !== COMMAND_TOOL_NAME) {
        return error(-32602, `unknown tool ${JSON.stringify(params?.name)}`)
      }
      const validated = validateCommandRequest(params.arguments, deps.cliPackage)
      if (!validated.ok) {
        // A refusal is a tool RESULT with isError, not a protocol error: the
        // agent must see the refusal and adapt, exactly as a denied Bash call
        // surfaces in the stream.
        return reply({ content: [{ type: 'text', text: `refused: ${validated.reason}` }], isError: true })
      }
      const outcome = await runCommand(validated.argv, {
        trialHome: deps.trialHome,
        env: deps.env,
        ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
        ...(deps.spawn !== undefined ? { spawn: deps.spawn } : {}),
      })
      const text = [
        `exit ${outcome.exitCode ?? 'null'}${outcome.timedOut ? ' (timed out)' : ''}`,
        outcome.stdout ? `stdout:\n${outcome.stdout}` : '',
        outcome.stderr ? `stderr:\n${outcome.stderr}` : '',
      ]
        .filter(Boolean)
        .join('\n')
      return reply({ content: [{ type: 'text', text }], isError: !outcome.ok })
    }
    default:
      // A notification (no id) is never answered.
      return id === undefined ? undefined : error(-32601, `method not found: ${request.method}`)
  }
}

/** Serve the tool over stdio until stdin closes. */
export function serveCommandTool(env: NodeJS.ProcessEnv = process.env): void {
  const cliPackage = env[CLI_PACKAGE_ENV]?.trim() ?? ''
  const trialHome = env[TRIAL_HOME_ENV]?.trim() ?? ''
  const timeoutRaw = Number(env[COMMAND_TIMEOUT_ENV] ?? '')
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_COMMAND_TIMEOUT_MS
  const childEnv = buildCommandEnv(env, trialHome)
  const rl = createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let request: JsonRpcRequest
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`)
      return
    }
    void handleRpc(request, { cliPackage, trialHome, env: childEnv, timeoutMs }).then((response) => {
      if (response !== undefined) process.stdout.write(`${JSON.stringify(response)}\n`)
    })
  })
}

/** Runs only when this file is the process entry (the cli.ts idiom). */
const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('evals/command-tool.ts') || process.argv[1]?.endsWith('evals/command-tool.js')
  } catch {
    return false
  }
})()

if (isMain) serveCommandTool()
