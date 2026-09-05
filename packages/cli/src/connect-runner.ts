import { spawn } from 'node:child_process'

/**
 * Running the connector as a child process, for `haven agents connect --run`
 * (#2527).
 *
 * ## The command is not ours to edit
 *
 * The backend builds `connector_command` and the setup prompt states the rule
 * an agent must follow: the command may be changed in exactly two ways, and
 * appending `--json` is one of them. So this splits the printed command and
 * appends `--json` — nothing else. It does not add `--replace`, it does not add
 * `--name`, it does not rewrite `--api`, and it never composes a command of its
 * own. `haven agents connect` has no flags for those on purpose: a wiring
 * collision is a decision for the human, and a CLI that could resolve one would
 * be making that decision on their behalf (boundary note on #2527 from #2551).
 *
 * ## Why the exit code is not the verdict
 *
 * The connector exits **1** on a refusal while still writing a complete outcome
 * object to stdout (`cli.test.ts`, the `wiring_collision` case). Treating a
 * non-zero exit as "it did not run" would throw away exactly the structured
 * refusal the human needs. So the outcome is parsed from stdout whatever the
 * exit code was, and the exit code only decides what to do when there is no
 * parseable outcome at all.
 *
 * ## Refusals are recognised structurally, never by name
 *
 * A refusal is "the outcome carries an `error`". The relay text comes from
 * `error.next_action`. Nothing here enumerates `runtime_undetermined` or
 * `wiring_collision`, so a refusal added to the connector tomorrow reaches the
 * user through this path without a CLI change — which is the whole point of
 * the connector having a typed vocabulary in the first place.
 */

/** The connector's `--json` outcome. Only the fields this CLI reads. */
export interface ConnectorOutcome {
  schema_version?: number
  outcome?: 'complete' | 'action_required' | 'failed' | string
  next_action?: string
  approval?: { required?: boolean; expires_at?: string | null; url?: string }
  error?: {
    code?: string
    next_action?: string
    message?: string
    allowed_runtimes?: readonly string[]
    installed_clients?: readonly string[]
    suggested_runtime?: string
    superseded_agent_ids?: readonly string[]
    suggested_name?: string
  }
  [key: string]: unknown
}

export interface ConnectorRun {
  /** The parsed outcome, when the connector produced one. */
  outcome: ConnectorOutcome | null
  exitCode: number
  /** Everything the connector wrote to stderr, already streamed to ours. */
  stderr: string
  /** stdout that was not the outcome object — kept so a failure can say why. */
  stdoutNoise: string
}

export interface Spawner {
  (command: string, args: string[], onStderr: (chunk: string) => void): Promise<{
    stdout: string
    stderr: string
    exitCode: number
  }>
}

/**
 * Split a printed connector command into argv.
 *
 * The backend shell-quotes the setup token and the API url with single quotes
 * (`buildConnectorCommand`), so this understands single quotes and nothing
 * else. It is deliberately not a shell: no globbing, no variable expansion, no
 * `&&`. A command carrying anything this cannot represent is refused rather
 * than approximated, because the alternative is executing a rewritten version
 * of a command whose whole contract is that it is not rewritten.
 */
export function splitConnectorCommand(command: string): string[] {
  const argv: string[] = []
  let current = ''
  let quoted = false
  let started = false

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]
    if (quoted) {
      if (ch === "'") quoted = false
      else current += ch
      continue
    }
    if (ch === "'") {
      quoted = true
      started = true
      continue
    }
    if (ch === ' ' || ch === '\t') {
      if (started) argv.push(current)
      current = ''
      started = false
      continue
    }
    // The ONE backslash form this understands: POSIX `'\''`, which is how the
    // backend's `shellQuote` escapes a single quote inside a quoted value
    // (`'a'\''b'` means `a'b`). Supported because the builder can emit it, and
    // a command the builder can produce but `--run` cannot execute is a broken
    // contract rather than a safe refusal. Every OTHER backslash is still
    // refused — this is a parser for one known quoting function, not a shell.
    if (ch === '\\') {
      if (command[i + 1] === "'") {
        current += "'"
        started = true
        i += 1
        continue
      }
      throw new Error('Refusing to run a connector command with a backslash escape')
    }
    if (ch === '"' || ch === '`' || ch === '$' || ch === '|' || ch === '&' || ch === ';' ||
        ch === '>' || ch === '<' || ch === '(' || ch === ')' || ch === '\n') {
      throw new Error(`Refusing to run a connector command containing ${JSON.stringify(ch)}`)
    }
    current += ch
    started = true
  }
  if (quoted) throw new Error('Refusing to run a connector command with an unterminated quote')
  if (started) argv.push(current)
  if (argv.length === 0) throw new Error('The backend returned an empty connector command')
  return argv
}

/** The real spawner. Injected in tests so no child process runs there. */
export const nodeSpawner: Spawner = (command, args, onStderr) =>
  new Promise((resolve, reject) => {
    // `shell: false` is the point: argv goes to the process as-is, so nothing
    // in a token or url can be read as shell syntax.
    const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
      // Streamed rather than buffered to the end: a connector run can take
      // minutes, and its stderr is the only progress a human sees.
      onStderr(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }))
  })

/**
 * Find the connector's outcome object in its stdout.
 *
 * The contract is one JSON object on stdout under `--json`. This assumes none
 * of the things that contract does not actually say: not that the object is
 * the whole stream (a package manager on the `npx` path writes its own lines),
 * not that it is on one line (a pretty-printed object), and not that it is
 * alone on its line (`npm notice {...}`). Each of those assumptions turned a
 * real refusal into "no outcome" in an earlier version. The LAST balanced
 * object wins.
 */
export function parseOutcome(stdout: string): { outcome: ConnectorOutcome | null; noise: string } {
  const noise: string[] = []
  let outcome: ConnectorOutcome | null = null

  // A scanner over the WHOLE stream, not over lines. Two assumptions died
  // here, both of them unstated until a reviewer looked: that the object is on
  // one line (a pretty-printed refusal was swallowed), and that the object is
  // ALONE on its line (`npm notice {...}` or a trailing word dropped it the
  // same way). Both regressed a real refusal to "the connector produced no
  // outcome", losing the exit code and the `next_action` a caller branches on.
  // Anything outside a balanced object is noise; the LAST balanced object
  // wins, so a stray object from a package manager cannot displace the
  // outcome.
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  let plain = ''

  for (let i = 0; i < stdout.length; i += 1) {
    const ch = stdout[i]

    if (depth === 0) {
      if (ch === '{') {
        depth = 1
        start = i
        inString = false
        escaped = false
      } else {
        plain += ch
      }
      continue
    }

    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        const candidate = stdout.slice(start, i + 1)
        try {
          // No `Array.isArray` check here, deliberately. A candidate always
          // starts at `{`, so `JSON.parse` can only return an object — the
          // anchor IS the guarantee. An earlier version carried the array
          // check as well and a mutation removing it passed the whole suite,
          // because it was unreachable: a guard nothing can violate reads like
          // protection while proving nothing, which is the shape this file has
          // already been wrong about once.
          outcome = JSON.parse(candidate) as ConnectorOutcome
        } catch {
          plain += candidate
        }
        start = -1
      }
    }
  }

  // An object that never closed is not an outcome; keep it readable rather
  // than dropping it, so a truncated stream still says something.
  if (depth > 0 && start >= 0) plain += stdout.slice(start)

  for (const line of plain.split('\n')) {
    const text = line.trim()
    if (text) noise.push(text)
  }
  return { outcome, noise: noise.join('\n') }
}

/** Is this outcome a refusal the human has to act on? */
export function isRefusal(outcome: ConnectorOutcome | null): boolean {
  return Boolean(outcome?.error)
}

/**
 * The one line that goes first (#2483's one-gate rule).
 *
 * An approval that is waiting outranks everything else on screen, and a
 * refusal outranks a completed run. The text is built from what the connector
 * said rather than from a table of codes here.
 */
export function relayLine(outcome: ConnectorOutcome | null): string | null {
  if (!outcome) return null
  if (outcome.error) {
    const message = outcome.error.message?.trim()
    const next = outcome.error.next_action ?? outcome.next_action
    // The message is the connector's own prose and is what a human reads; the
    // next action is what an agent branches on. Both, in that order.
    return message
      ? `${message}${next ? ` (next: ${next})` : ''}`
      : `The connector refused${next ? `: ${next}` : '.'}`
  }
  if (outcome.approval?.required) {
    return outcome.approval.url
      ? `Approve the budget to finish: ${outcome.approval.url}`
      : 'Approve the budget in your Haven tab to finish.'
  }
  return null
}

/**
 * Run the connector command, appending `--json` and nothing else.
 */
export async function runConnector(
  connectorCommand: string,
  spawner: Spawner,
  onStderr: (chunk: string) => void,
): Promise<ConnectorRun> {
  const argv = splitConnectorCommand(connectorCommand)
  // Appended, never inserted: the rule is "exactly `--json` appended", and a
  // flag placed anywhere else is a different command line.
  const args = [...argv.slice(1), '--json']
  const { stdout, stderr, exitCode } = await spawner(argv[0], args, onStderr)
  const { outcome, noise } = parseOutcome(stdout)
  return { outcome, exitCode, stderr, stdoutNoise: noise }
}
