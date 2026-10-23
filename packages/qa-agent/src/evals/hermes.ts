/**
 * The Hermes (Nous Research) adapter — eval lane 1 of #3957.
 *
 * What is KNOWN and what is deliberately a seam:
 *
 * KNOWN (from the repo): connect wires the hosted+signer MCP pair into
 * Hermes with a derived pair name on non-production backends
 * (`haven-<slug>-dev` / `haven-signer-<slug>-dev`), stores the pair's API key
 * in the Hermes dotenv under `MCP_HAVEN_<SLUG>_API_KEY`
 * (`packages/connect/src/server-names.ts`), and provisions the whole thing
 * with `--runtime hermes` + a `hv_setup_…` dashboard token. Inside a Hermes
 * session the MCP tools are namespaced `mcp__<server>__<tool>`.
 *
 * THE SEAM (answered live 2026-10-15, runbook § the wrapper): `hermes -z
 * {instruction} --yolo` runs ONE task non-interactively and exits; the tool
 * trace lives in the profile's `state.db`, which a wrapper reads and emits
 * as the normalized log. The adapter takes the harness command and log path
 * from env and refuses to invent a default — a guessed flag would burn a
 * night of the partner's machine on a run that never launched. The LOG
 * PARSER, though, is concrete and tested: it reads the Anthropic-style
 * session JSONL (assistant `tool_use` blocks + user `tool_result` blocks)
 * and our own normalized JSON.
 *
 * #3959 (Claude Code adapter) reuses the task format, graders and this log
 * contract; it must NOT copy them.
 */

import { exec } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { deepFind, parseMaybeJson } from './json-reading.js'
import { bareToolName } from './tools.js'
import type { AgentRunLog, RecordedToolCall, ServerRole } from './types.js'

const execAsync = promisify(exec)

export const HERMES_COMMAND_ENV = 'QA_EVAL_HERMES_COMMAND'
export const HERMES_LOG_ENV = 'QA_EVAL_HERMES_SESSION_LOG'

/** What the adapter needs to launch one task. */
export interface HermesAdapterConfig {
  /**
   * Full command template. `{instruction}` and `{log}` are substituted; the
   * command runs through the shell. REQUIRED — no default is invented
   * (partner open question #2).
   */
  commandTemplate: string
  /** Where the adapter expects the session log. `{log}` in the template, or this. */
  logPath: string
  timeoutMs: number
}

export class HermesAdapterError extends Error {
  constructor(
    message: string,
    readonly openQuestion?: string,
  ) {
    super(message)
    this.name = 'HermesAdapterError'
  }
}

/** Read the adapter config from env, refusing to guess. */
export function hermesAdapterConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HermesAdapterConfig {
  const template = env[HERMES_COMMAND_ENV]?.trim()
  if (!template) {
    throw new HermesAdapterError(
      `${HERMES_COMMAND_ENV} is not set — the adapter does not guess how Hermes runs one task ` +
        `non-interactively. The verified shape is a wrapper around ` +
        `\`hermes -z {instruction} --yolo\` that reads the profile's state.db and emits the ` +
        `normalized AgentRunLog JSON — see docs/operations/agent-evals.md § "The Hermes lane ` +
        `as actually run". Set it to that wrapper command containing {instruction}.`,
      'runbook-hermes-wrapper',
    )
  }
  if (!template.includes('{instruction}')) {
    throw new HermesAdapterError(`${HERMES_COMMAND_ENV} must contain {instruction} — the task instruction has to reach the agent`)
  }
  const logPath = env[HERMES_LOG_ENV]?.trim()
  if (!logPath && !template.includes('{log}')) {
    throw new HermesAdapterError(
      `no session log path: set ${HERMES_LOG_ENV} or put {log} in the command template — ` +
        `without a recorded log the graders have nothing to read`,
    )
  }
  return { commandTemplate: template, logPath: logPath ?? '', timeoutMs: 30 * 60_000 }
}

/** Build the concrete command for one resolved task. */
export function buildHermesCommand(cfg: HermesAdapterConfig, instruction: string, logPath: string): string {
  return cfg.commandTemplate
    .replaceAll('{instruction}', shellQuote(instruction))
    .replaceAll('{log}', shellQuote(logPath))
}

/** Single-quote for the shell, escaping embedded quotes. */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

/**
 * Launch one task through Hermes and collect its tool-call log.
 * Returns the parsed {@link AgentRunLog} — the graders' only input.
 */
export async function runHermesTask(
  cfg: HermesAdapterConfig,
  opts: { taskId: string; trial: number; instruction: string },
): Promise<AgentRunLog> {
  const logPath = cfg.logPath.includes('{')
    ? cfg.logPath
    : `${cfg.logPath}.${opts.taskId}.trial${opts.trial}.jsonl`
  const command = buildHermesCommand(cfg, opts.instruction, logPath)
  try {
    await execAsync(command, { timeout: cfg.timeoutMs })
  } catch (err) {
    const e = err as { message?: string; killed?: boolean }
    throw new HermesAdapterError(
      `harness command failed for ${opts.taskId} trial ${opts.trial}: ${e.message?.slice(0, 400) ?? err}`,
    )
  }
  const raw = await readFile(logPath, 'utf8')
  return parseHermesSessionLog(raw, { taskId: opts.taskId, trial: opts.trial })
}

// ── The log parser ─────────────────────────────────────────────────────────
//
// Accepts two shapes, in one pass each:
//   1. Anthropic-style session JSONL: `{"type":"assistant","message":{"content":[
//      {"type":"tool_use","id":..,"name":"mcp__haven-x-dev__haven_pay","input":{..}}]}}`
//      and `{"type":"user","message":{"content":[{"type":"tool_result",
//      "tool_use_id":..,"is_error":..,"content":[{"type":"text","text":..}]}]}}`.
//   2. Our own normalized JSON: a single object that IS an AgentRunLog
//      (adapters that already speak the model write it directly).

interface ToolUseBlock {
  type: 'tool_use'
  id?: string
  name: string
  input?: Record<string, unknown>
}
interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id?: string
  is_error?: boolean
  content?: Array<{ type?: string; text?: string }> | string
}
type ContentBlock = ToolUseBlock | ToolResultBlock | { type: 'text'; text?: string } | { type: string }

/**
 * The hosted MCP failure envelope names the condition with a SCREAMING_SNAKE
 * `code` (#4070: `DELEGATION_BUDGET_EXCEEDED`), while the backend's HTTP body
 * and the graders' pinned evidence use snake_case (`delegation_budget_exceeded`).
 * Canonicalize the former into the latter so the evidence field the graders
 * match actually exists on the recorded log — `error_code` bodies are already
 * canonical and pass through unchanged.
 */
export function canonicalErrorCode(code: string): string {
  return code
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
}

/**
 * An MCP client records a failed tool result as `{"error": "<json>"}` — the
 * refusal envelope rides inside as a STRING (the raw shape #4070 recorded in
 * the eval profile's state.db). Unwrap it before reading fields; a plain
 * prose `error` value does not parse and is left alone.
 */
function unwrapErrorShell(parsed: unknown): unknown {
  let current = parsed
  for (let hops = 0; hops < 3; hops += 1) {
    if (typeof current !== 'object' || current === null) return current
    const shell = (current as Record<string, unknown>).error
    if (typeof shell !== 'string') return current
    const inner = parseMaybeJson(shell)
    if (inner === undefined || typeof inner !== 'object' || inner === null) return current
    current = inner
  }
  return current
}

/**
 * Extract the refusal envelope fields a hosted MCP tool result carries.
 *
 * Reads the backend's `error_code` and, on a failure envelope that predates
 * that field name, the hosted `code` (#4070: the typed 403 relays as
 * `code: "DELEGATION_BUDGET_EXCEEDED"` with NO `error_code` — the adapter
 * accepts the backend's actual shape rather than demanding a second spelling
 * of the same code on the wire). A `code` on a SUCCESS envelope is not a
 * refusal and is never promoted. The `{"error": "<json>"}` shell an MCP
 * client wraps around a failed result is unwrapped first.
 */
export function resultFieldsFromText(text: string): { errorCode?: string; nextTool?: string; nextToolServerRole?: ServerRole; ok?: boolean; paymentId?: string; idempotentReplay?: boolean } {
  const parsed = parseMaybeJson(text)
  if (parsed !== undefined) {
    const envelope = unwrapErrorShell(parsed)
    if (envelope !== undefined && typeof envelope === 'object' && envelope !== null) {
      const success = deepFind(envelope, 'success')
      const rawCode = deepFind(envelope, 'code')
      const errorCode =
        deepFind(envelope, 'error_code') ??
        (success === false && typeof rawCode === 'string' ? canonicalErrorCode(rawCode) : undefined)
      const nextTool = deepFind(envelope, 'next_tool_name')
      const role = deepFind(envelope, 'next_tool_server_role')
      const paymentId = deepFind(envelope, 'payment_id')
      const replay = deepFind(envelope, 'idempotent_replay')
      return {
        ...(replay === true ? { idempotentReplay: true } : {}),
        ...(typeof errorCode === 'string' ? { errorCode } : {}),
        ...(typeof nextTool === 'string' ? { nextTool: bareToolName(nextTool) } : {}),
        ...(role === 'hosted' || role === 'signer' ? { nextToolServerRole: role } : {}),
        ...(success === false ? { ok: false } : success === true ? { ok: true } : {}),
        // #3992 A1: a payment id that only appears in the RESULT (the create
        // call's own response, not the next call's arguments) still reaches
        // `payment_status_settled`.
        ...(typeof paymentId === 'string' ? { paymentId } : {}),
      }
    }
  }
  // Best-effort regex fallback for prose-wrapped envelopes. The generic
  // `code` spelling is only trusted on a payload that also says it failed —
  // a `code` on a success body means something else entirely.
  const errorCode =
    /"error_code"\s*:\s*"([A-Za-z0-9_]+)"/.exec(text)?.[1] ??
    (/"success"\s*:\s*false/.test(text) ? /"code"\s*:\s*"([A-Za-z0-9_]+)"/.exec(text)?.[1] : undefined)
  const nextTool = /"next_tool_name"\s*:\s*"([A-Za-z0-9_]+)"/.exec(text)?.[1]
  const paymentId = /"payment_id"\s*:\s*"([^"]+)"/.exec(text)?.[1]
  const replay = /"idempotent_replay"\s*:\s*true/.test(text)
  return {
    ...(replay ? { idempotentReplay: true } : {}),
    ...(errorCode !== undefined ? { errorCode: canonicalErrorCode(errorCode) } : {}),
    ...(nextTool !== undefined ? { nextTool: bareToolName(nextTool) } : {}),
    ...(paymentId !== undefined ? { paymentId } : {}),
  }
}

/**
 * Parse a recorded Hermes session into an {@link AgentRunLog}.
 * Exported for unit tests against a recorded fixture — no model, no network.
 */
export function parseHermesSessionLog(raw: string, meta: { taskId: string; trial: number }): AgentRunLog {
  const trimmed = raw.trim()
  if (!trimmed) return { ...meta, calls: [] }

  // Shape 2: our normalized JSON.
  if (trimmed.startsWith('{')) {
    const single = parseMaybeJson(trimmed)
    if (single && typeof single === 'object' && Array.isArray((single as { calls?: unknown }).calls)) {
      return single as AgentRunLog
    }
  }

  const calls: RecordedToolCall[] = []
  const callFor = new Map<string, RecordedToolCall>()
  let finalMessage: string | undefined

  for (const line of trimmed.split('\n')) {
    const stripped = line.trim()
    if (!stripped) continue
    let entry: { type?: string; message?: { content?: ContentBlock[] | string } }
    try {
      entry = JSON.parse(stripped) as typeof entry
    } catch {
      continue
    }
    const content = entry.message?.content
    const blocks: ContentBlock[] = typeof content === 'string' ? [] : (content ?? [])
    for (const block of blocks) {
      if (block?.type === 'tool_use') {
        const tu = block as ToolUseBlock
        const call: RecordedToolCall = { name: tu.name, args: tu.input }
        calls.push(call)
        if (tu.id) callFor.set(tu.id, call)
      } else if (block?.type === 'tool_result') {
        const tr = block as ToolResultBlock
        const text = Array.isArray(tr.content)
          ? tr.content.map((c) => c?.text ?? '').join('\n')
          : typeof tr.content === 'string'
            ? tr.content
            : ''
        const fields = resultFieldsFromText(text)
        // Attach to the originating call by id.
        const target = tr.tool_use_id ? callFor.get(tr.tool_use_id) : undefined
        if (target) {
          target.result = { ...fields, ok: tr.is_error ? false : (fields.ok ?? true) }
        }
      } else if (block?.type === 'text' && typeof (block as { text?: string }).text === 'string') {
        finalMessage = (block as { text?: string }).text
      }
    }
  }
  return { ...meta, calls, ...(finalMessage !== undefined ? { finalMessage } : {}) }
}
