/**
 * The Claude Code headless adapter — eval lane 2 of #3957 (#3959).
 *
 * Runs ONE task through `claude -p` in `--output-format stream-json` mode and
 * grades the same task files and graders as the Hermes lane, UNMODIFIED
 * (#3959 acceptance): the stream's `assistant` / `user` lines carry the same
 * `tool_use` / `tool_result` blocks the Hermes session JSONL does, so the
 * recorded log lands in the harness-neutral model of `types.ts` — nothing is
 * forked. Reuses `resultFieldsFromText` from the Hermes adapter (the refusal
 * envelope reader); only the transport around it is lane-specific.
 *
 * MONEY-PATH (#3959): authentication is the OWNER'S subscription token from
 * `claude setup-token`, passed as `CLAUDE_CODE_OAUTH_TOKEN` in the
 * environment by the caller (the agent-evals workflow, behind a protected
 * GitHub environment). This module never reads, logs, echoes or persists the
 * token — it appears only in the child process env, inherited whole.
 *
 * What this adapter OWNS vs what the caller owns:
 *
 *   adapter   — {instruction} substitution, session capture (stdout → a
 *               stream-JSON log file), parsing into the grader model, and
 *               the per-session cost record (`total_cost_usd` from the
 *               result line — the number the cost pilot and the job summary
 *               report).
 *   caller    — everything money-relevant about the command: the MCP config,
 *               the Haven-tools-only allowlist, the model. Those live in the
 *               `QA_EVAL_CLAUDE_CODE_COMMAND` template, which the workflow
 *               file owns and shows, so the allowlist is reviewable in the
 *               open (the #3959 acceptance criterion). The adapter refuses
 *               to invent a template — same discipline as the Hermes
 *               adapter's `QA_EVAL_HERMES_COMMAND`.
 *
 * `claude -p` is limited to the Haven MCP tools by that allowlist: no Bash,
 * file or web tools. A denied call still surfaces in the stream as a
 * tool_use + error tool_result, which is exactly what the no-retry graders
 * need to see.
 */

import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resultFieldsFromText } from './hermes.js'
import type { AgentRunLog, RecordedToolCall, ResolvedTask } from './types.js'

export const CLAUDE_CODE_COMMAND_ENV = 'QA_EVAL_CLAUDE_CODE_COMMAND'
export const CLAUDE_CODE_LOG_ENV = 'QA_EVAL_CLAUDE_CODE_SESSION_LOG'

/** What one Claude Code session reported about itself (the result line). */
export interface ClaudeCodeSessionMeta {
  /** `total_cost_usd` — the number the cost pilot records (#3959 scope 1). */
  costUsd?: number
  /** The model the session actually ran on, from the stream (not the request). */
  model?: string
  durationMs?: number
  numTurns?: number
  /** The log file the session stream was captured to (kept for the pilot's evidence). */
  logPath?: string
  /** `claude`'s exit code when it was not 0 (e.g. the turn limit), with the session still graded. */
  exitCode?: number
}

/** One session's cost record, keyed to the task/trial that produced it. */
export interface ClaudeCodeSession extends ClaudeCodeSessionMeta {
  taskId: string
  trial: number
}

export interface ClaudeCodeAdapterConfig {
  /**
   * Full command template. `{instruction}` is REQUIRED, `{log}` optional —
   * but the adapter captures stdout itself, so `{log}` only matters if the
   * template wants to redirect it explicitly. NO DEFAULT is invented: the
   * allowlist and MCP config belong in the workflow file, in the open.
   */
  commandTemplate: string
  /** Base path for session logs; per-trial files get `.taskId.trialN.jsonl` suffixes. */
  logPath?: string
  timeoutMs: number
}

export class ClaudeCodeAdapterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClaudeCodeAdapterError'
  }
}

/** Read the adapter config from env, refusing to guess. */
export function claudeCodeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ClaudeCodeAdapterConfig {
  const template = env[CLAUDE_CODE_COMMAND_ENV]?.trim()
  if (!template) {
    throw new ClaudeCodeAdapterError(
      `${CLAUDE_CODE_COMMAND_ENV} is not set — the adapter does not guess how Claude Code is ` +
        `invoked (the allowlist, the MCP config and the model belong in that template, which ` +
        `the agent-evals workflow file owns and shows). Set it to a command containing {instruction}.`,
    )
  }
  if (!template.includes('{instruction}')) {
    throw new ClaudeCodeAdapterError(`${CLAUDE_CODE_COMMAND_ENV} must contain {instruction} — the task instruction has to reach the agent`)
  }
  return {
    commandTemplate: template,
    logPath: env[CLAUDE_CODE_LOG_ENV]?.trim() || undefined,
    timeoutMs: 30 * 60_000,
  }
}

/** Build the concrete command for one resolved task. */
export function buildClaudeCodeCommand(cfg: ClaudeCodeAdapterConfig, instruction: string): string {
  return cfg.commandTemplate.replaceAll('{instruction}', shellQuote(instruction))
}

/** Single-quote for the shell, escaping embedded quotes. */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

/**
 * Launch one task through `claude -p` and collect its tool-call log.
 * The stream-JSON session is captured to a log file and parsed; the
 * session's `total_cost_usd` is recorded on the adapter for the report.
 */
export class ClaudeCodeAdapter {
  readonly name = 'claude-code'
  readonly sessions: ClaudeCodeSession[] = []

  constructor(private readonly cfg: ClaudeCodeAdapterConfig) {}

  async runTask(resolved: ResolvedTask, trial: number): Promise<AgentRunLog> {
    const taskId = resolved.task.id
    const base = this.cfg.logPath ?? (await mkdtemp(join(tmpdir(), 'qa-eval-claude-')))
    const logPath = `${base}.${taskId}.trial${trial}.jsonl`
    const command = buildClaudeCodeCommand(this.cfg, resolved.instruction)
    const { code, stderrTail } = await this.runCommand(command, logPath, taskId, trial)
    const raw = await readFile(logPath, 'utf8')
    const { log, session } = parseClaudeCodeStreamLog(raw, { taskId, trial })
    // A non-zero exit after the agent worked (the turn limit, for one) still
    // leaves a gradeable session: grade it and record the code. A non-zero
    // exit with NO tool call is an infrastructure failure (auth rejected, the
    // plan's usage limit), even when claude printed an error as its `result`
    // text, and must not be graded as the agent's behaviour.
    if (code !== 0 && log.calls.length === 0) {
      throw new ClaudeCodeAdapterError(
        `claude exited ${code} for ${taskId} trial ${trial}: ` +
          // claude -p reports auth and usage-limit failures as its `result`
          // text on stdout, not on stderr: quote it, or the cause is lost.
          `${log.finalMessage ? `result: ${log.finalMessage.slice(0, 400)}; ` : ''}` +
          `${stderrTail.slice(-400) || '(no stderr)'}`,
      )
    }
    this.sessions.push({ ...session, logPath, taskId, trial, ...(code !== 0 && code !== null ? { exitCode: code } : {}) })
    return log
  }

  /**
   * Run one session, resolving only when the process has closed AND the
   * captured stdout has been flushed to `logPath`: the final `result` line
   * (the one carrying `total_cost_usd`) is the last thing written, so reading
   * the file on `close` alone can lose it.
   */
  private runCommand(
    command: string,
    logPath: string,
    taskId: string,
    trial: number,
  ): Promise<{ code: number | null; stderrTail: string }> {
    return new Promise((resolve, reject) => {
      let settled = false
      let exitCode: number | null | undefined
      let flushed = false
      const done = (err?: Error) => {
        if (settled) return
        if (!err && (exitCode === undefined || !flushed)) return
        settled = true
        clearTimeout(timer)
        err ? reject(err) : resolve({ code: exitCode ?? null, stderrTail })
      }
      // The token travels ONLY in the inherited env — never in the command
      // string, never logged. An error report quotes the template, which is
      // the caller's own (secret-free) command, and the stderr TAIL only.
      const child = spawn(command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        done(new ClaudeCodeAdapterError(`claude session timed out after ${this.cfg.timeoutMs}ms (${taskId} trial ${trial})`))
      }, this.cfg.timeoutMs)
      let stderrTail = ''
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = `${stderrTail}${chunk}`.slice(-2000)
      })
      const out = createWriteStream(logPath)
      out.on('finish', () => {
        flushed = true
        done()
      })
      out.on('error', (err) => done(new ClaudeCodeAdapterError(`could not write the session log: ${err.message}`)))
      if (child.stdout) child.stdout.pipe(out)
      else out.end()
      child.on('error', (err) => done(new ClaudeCodeAdapterError(`could not launch claude: ${err.message}`)))
      child.on('close', (code) => {
        exitCode = code
        done()
      })
    })
  }
}

// ── The stream-JSON parser ─────────────────────────────────────────────────
//
// `claude -p --output-format stream-json --verbose` writes one JSON object
// per line:
//   {"type":"system","subtype":"init",...}
//   {"type":"assistant","message":{"model":..,"content":[{"type":"tool_use",..},{"type":"text",..}]}}
//   {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":..,"is_error":..,"content":[..]}]}}
//   {"type":"result","subtype":"success","total_cost_usd":..,"duration_ms":..,"num_turns":..,"result":"..","model":..}
//
// Same block shapes the Hermes session JSONL uses — but this parser is NOT a
// copy of `parseHermesSessionLog`: it reads the whole stream (which Hermes'
// does not emit) for the result line, and it keeps its own block walk so the
// two lanes can drift their capture formats without dragging each other.
// The refusal-envelope reading is shared (`resultFieldsFromText`), because
// THAT contract is the backend's, not a lane's.

interface StreamLine {
  type?: string
  message?: { model?: string; content?: Array<Record<string, unknown>> | string }
  // The result line:
  total_cost_usd?: unknown
  duration_ms?: unknown
  num_turns?: unknown
  result?: unknown
  model?: unknown
}

function numField(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function strField(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/**
 * Parse a captured Claude Code stream-JSON session into the grader model.
 * Exported for unit tests against a recorded fixture — no model, no spend.
 */
export function parseClaudeCodeStreamLog(
  raw: string,
  meta: { taskId: string; trial: number },
): { log: AgentRunLog; session: ClaudeCodeSessionMeta } {
  const calls: RecordedToolCall[] = []
  const callFor = new Map<string, RecordedToolCall>()
  let finalMessage: string | undefined
  let lastModel: string | undefined
  const session: ClaudeCodeSessionMeta = {}

  for (const line of raw.split('\n')) {
    const stripped = line.trim()
    if (!stripped) continue
    let entry: StreamLine
    try {
      entry = JSON.parse(stripped) as StreamLine
    } catch {
      continue
    }
    if (entry.type === 'result') {
      session.costUsd = numField(entry.total_cost_usd)
      session.durationMs = numField(entry.duration_ms)
      session.numTurns = numField(entry.num_turns)
      session.model = strField(entry.model)
      // The result line's `result` is the final user-facing text — the
      // "told the user" evidence, same role as Hermes' last text block.
      finalMessage = strField(entry.result) ?? finalMessage
      continue
    }
    const content = entry.message?.content
    const model = strField(entry.message?.model)
    if (model) lastModel = model
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        const call: RecordedToolCall = {
          name: block.name,
          args: block.input as Record<string, unknown> | undefined,
        }
        calls.push(call)
        if (typeof block.id === 'string') callFor.set(block.id, call)
      } else if (block.type === 'tool_result') {
        const text = Array.isArray(block.content)
          ? block.content.map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : '')).join('\n')
          : typeof block.content === 'string'
            ? block.content
            : ''
        const fields = resultFieldsFromText(text)
        const target = typeof block.tool_use_id === 'string' ? callFor.get(block.tool_use_id) : undefined
        if (target) {
          target.result = { ...fields, ok: block.is_error === true ? false : (fields.ok ?? true) }
        }
      } else if (block.type === 'text' && typeof block.text === 'string') {
        finalMessage = block.text
      }
    }
  }
  return {
    log: { ...meta, calls, ...(finalMessage !== undefined ? { finalMessage } : {}) },
    session: { ...session, ...(session.model === undefined && lastModel !== undefined ? { model: lastModel } : {}) },
  }
}

/** Persist the captured session stream (the cost pilot's per-session evidence). */
export async function writeSessionEvidence(sessions: ClaudeCodeSession[], path: string): Promise<void> {
  await writeFile(path, JSON.stringify(sessions, null, 2))
}
