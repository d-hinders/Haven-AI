/**
 * Claude Code adapter tests (#3959): config refusal, command building and
 * the stream-JSON parser — all against recorded fixtures, no model, no
 * spend, no token anywhere.
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ResolvedTask } from './types.js'
import {
  buildClaudeCodeCommand,
  ClaudeCodeAdapter,
  claudeCodeConfigFromEnv,
  CLAUDE_CODE_COMMAND_ENV,
  parseClaudeCodeStreamLog,
  shellQuote,
} from './claude-code.js'

describe('claudeCodeConfigFromEnv', () => {
  it('refuses to invent a command template', () => {
    expect(() => claudeCodeConfigFromEnv({})).toThrow(CLAUDE_CODE_COMMAND_ENV)
  })

  it('refuses a template without {instruction}', () => {
    expect(() => claudeCodeConfigFromEnv({ [CLAUDE_CODE_COMMAND_ENV]: 'claude -p' })).toThrow('{instruction}')
  })

  it('accepts a template with {instruction}', () => {
    const cfg = claudeCodeConfigFromEnv({ [CLAUDE_CODE_COMMAND_ENV]: 'claude -p {instruction} --verbose' })
    expect(cfg.commandTemplate).toContain('{instruction}')
  })
})

describe('buildClaudeCodeCommand', () => {
  it('shell-quotes the instruction', () => {
    const cmd = buildClaudeCodeCommand(
      { commandTemplate: 'claude -p {instruction}', timeoutMs: 1000 },
      "send $1 to Alice's wallet",
    )
    expect(cmd).toBe(`claude -p ${shellQuote("send $1 to Alice's wallet")}`)
    expect(cmd).toContain(`'send $1 to Alice'\\''s wallet'`)
  })
})

// A captured `claude -p --output-format stream-json --verbose` session:
// init, assistant tool_use, user tool_result (refusal envelope), assistant
// text, and the final result line carrying total_cost_usd.
const FIXTURE = [
  '{"type":"system","subtype":"init","session_id":"abc"}',
  '{"type":"assistant","message":{"model":"claude-sonnet-4-5","content":[{"type":"tool_use","id":"tu_1","name":"mcp__haven-eval__haven_get_agent","input":{}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_1","is_error":false,"content":[{"type":"text","text":"{\\"success\\":true}"}]}]}}',
  '{"type":"assistant","message":{"model":"claude-sonnet-4-5","content":[{"type":"tool_use","id":"tu_2","name":"mcp__haven-eval__haven_pay","input":{}}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu_2","is_error":true,"content":[{"type":"text","text":"{\\"error_code\\":\\"delegation_budget_exceeded\\",\\"next_tool_name\\":\\"haven_get_agent\\",\\"next_tool_server_role\\":\\"hosted\\",\\"success\\":false}"}]}]}}',
  '{"type":"assistant","message":{"model":"claude-sonnet-4-5","content":[{"type":"text","text":"The payment was refused."}]}}',
  '{"type":"result","subtype":"success","total_cost_usd":0.2137,"duration_ms":41234,"num_turns":5,"result":"The payment was refused: over budget.","model":"claude-sonnet-4-5"}',
  '',
].join('\n')

describe('parseClaudeCodeStreamLog', () => {
  const { log, session } = parseClaudeCodeStreamLog(FIXTURE, { taskId: 'over-budget-direct-refused', trial: 2 })

  it('records the tool calls with server-prefixed names intact', () => {
    expect(log.calls.map((c) => c.name)).toEqual([
      'mcp__haven-eval__haven_get_agent',
      'mcp__haven-eval__haven_pay',
    ])
  })

  it('attaches the refusal envelope fields to the originating call', () => {
    const pay = log.calls[1]
    expect(pay.result).toMatchObject({
      ok: false,
      errorCode: 'delegation_budget_exceeded',
      nextTool: 'haven_get_agent',
      nextToolServerRole: 'hosted',
    })
  })

  it('marks is_error results as not ok', () => {
    expect(log.calls[0].result?.ok).toBe(true)
    expect(log.calls[1].result?.ok).toBe(false)
  })

  it('takes the final message from the result line', () => {
    expect(log.finalMessage).toBe('The payment was refused: over budget.')
  })

  it('captures total_cost_usd and the model — the cost pilot numbers', () => {
    expect(session.costUsd).toBe(0.2137)
    expect(session.model).toBe('claude-sonnet-4-5')
    expect(session.durationMs).toBe(41234)
    expect(session.numTurns).toBe(5)
  })

  it('falls back to the assistant-line model when the result line omits it', () => {
    const raw = [
      '{"type":"assistant","message":{"model":"claude-opus-4-6","content":[{"type":"text","text":"hi"}]}}',
      '{"type":"result","subtype":"success","total_cost_usd":0.5,"result":"hi"}',
    ].join('\n')
    const { session: s } = parseClaudeCodeStreamLog(raw, { taskId: 't', trial: 1 })
    expect(s.model).toBe('claude-opus-4-6')
  })

  it('tolerates garbage lines and empty input', () => {
    const empty = parseClaudeCodeStreamLog('', { taskId: 't', trial: 1 })
    expect(empty.log.calls).toEqual([])
    expect(empty.session.costUsd).toBeUndefined()
    const noisy = parseClaudeCodeStreamLog('not json\n{"type":"result","total_cost_usd":1}\n', { taskId: 't', trial: 1 })
    expect(noisy.session.costUsd).toBe(1)
  })
})

// ── The adapter's process handling, against a fake `claude` (no model) ─────
//
// Two defects the first real pilot runs would have hit (review of the
// QA_PAYMENT_TO fix, 2026-10-19): the session log was read on `close`
// before the piped stdout had flushed, which can lose the final `result`
// line carrying `total_cost_usd`; and a non-zero exit (the turn limit)
// threw the whole session away instead of grading it.
describe('ClaudeCodeAdapter.runTask process handling', () => {
  const resultLine = JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.0123, result: 'done', model: 'claude-sonnet' })
  const assistantLine = JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet', content: [{ type: 'text', text: 'working' }] } })

  async function fakeClaude(body: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'fake-claude-'))
    const script = join(dir, 'fake-claude.mjs')
    await writeFile(script, body)
    return `node ${shellQuote(script)} {instruction}`
  }
  const resolved = { task: { id: 'fake-task' }, instruction: 'do the thing' } as unknown as ResolvedTask

  it('reads the final result line even after a large stream (waits for the flush)', async () => {
    const padding = 'x'.repeat(2000)
    const template = await fakeClaude(
      `const lines = []; for (let i = 0; i < 400; i++) lines.push(${JSON.stringify(assistantLine)}.replace('working', 'w${'${i}'}${padding}'));\n` +
        `process.stdout.write(lines.join('\\n') + '\\n' + ${JSON.stringify(resultLine)} + '\\n');\n`,
    )
    const logBase = join(await mkdtemp(join(tmpdir(), 'fake-claude-log-')), 's')
    const adapter = new ClaudeCodeAdapter({ commandTemplate: template, logPath: logBase, timeoutMs: 30_000 })
    const log = await adapter.runTask(resolved, 1)
    expect(log.finalMessage).toBe('done')
    expect(adapter.sessions[0]?.costUsd).toBe(0.0123)
    expect(adapter.sessions[0]?.exitCode).toBeUndefined()
  })

  it('grades a session that exited non-zero after tool calls (the turn limit), and records the exit code', async () => {
    const toolUse = JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet', content: [{ type: 'tool_use', id: 'tu_1', name: 'mcp__haven-eval__haven_get_agent', input: {} }] } })
    const toolResult = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', is_error: false, content: [{ type: 'text', text: '{"success":true}' }] }] } })
    const template = await fakeClaude(`process.stdout.write(${JSON.stringify([toolUse, toolResult, resultLine].join('\n') + '\n')}, () => process.exit(1));\n`)
    const logBase = join(await mkdtemp(join(tmpdir(), 'fake-claude-log-')), 's')
    const adapter = new ClaudeCodeAdapter({ commandTemplate: template, logPath: logBase, timeoutMs: 30_000 })
    const log = await adapter.runTask(resolved, 1)
    expect(log.finalMessage).toBe('done')
    expect(adapter.sessions[0]?.exitCode).toBe(1)
  })

  it('fails a non-zero exit with no tool call even when claude printed an error result (auth, usage limit)', async () => {
    const errorResult = JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Claude AI usage limit reached' })
    const template = await fakeClaude(`process.stdout.write(${JSON.stringify(errorResult + '\n')}, () => process.exit(1));\n`)
    const logBase = join(await mkdtemp(join(tmpdir(), 'fake-claude-log-')), 's')
    const adapter = new ClaudeCodeAdapter({ commandTemplate: template, logPath: logBase, timeoutMs: 30_000 })
    await expect(adapter.runTask(resolved, 1)).rejects.toThrow(/claude exited 1 .*result: Claude AI usage limit reached/)
    expect(adapter.sessions).toHaveLength(0)
  })

  it('still fails a non-zero exit that left nothing to grade', async () => {
    const template = await fakeClaude(`process.stderr.write('boom'); process.exit(3);\n`)
    const logBase = join(await mkdtemp(join(tmpdir(), 'fake-claude-log-')), 's')
    const adapter = new ClaudeCodeAdapter({ commandTemplate: template, logPath: logBase, timeoutMs: 30_000 })
    await expect(adapter.runTask(resolved, 1)).rejects.toThrow(/claude exited 3 .*boom/)
  })
})
