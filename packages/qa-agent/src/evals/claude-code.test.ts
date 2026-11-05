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
  buildChildEnv,
  buildClaudeCodeCommand,
  buildColdChildEnv,
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

// ── #4678: the child env is an explicit allowlist ──────────────────────────

describe('the child env is an explicit allowlist (#4678)', () => {
  it('strips the eval harness secrets and keeps what claude needs', () => {
    const env = buildChildEnv(
      {
        PATH: '/usr/bin',
        HOME: '/home/runner',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
        AGENT_EVALS_DELEGATE_KEY: 'delegate-secret',
        AGENT_EVALS_API_KEY: 'eval-api-key',
        QA_EVAL_AGENT_API_KEY: 'eval-api-key',
        HAVEN_CREDENTIALS: '/runner/haven-eval-agent/agent.json',
        QA_EVAL_SECRET_MANIFEST: '/runner/eval-secret-manifest/manifest.json',
      },
      { QA_EVAL_TRIAL_API_KEY: 'sk_trial' },
    )
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/home/runner')
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth')
    // The trial's own wiring is merged OVER the allowlist.
    expect(env.QA_EVAL_TRIAL_API_KEY).toBe('sk_trial')
    for (const name of [
      'AGENT_EVALS_DELEGATE_KEY',
      'AGENT_EVALS_API_KEY',
      'QA_EVAL_AGENT_API_KEY',
      'HAVEN_CREDENTIALS',
      'QA_EVAL_SECRET_MANIFEST',
    ]) {
      expect(env[name], name).toBeUndefined()
    }
  })

  it('the spawned session sees no delegate key — end to end', async () => {
    const previous = process.env.AGENT_EVALS_DELEGATE_KEY
    process.env.AGENT_EVALS_DELEGATE_KEY = 'delegate-secret'
    try {
      const dir = await mkdtemp(join(tmpdir(), 'fake-claude-'))
      const script = join(dir, 'fake-claude.mjs')
      await writeFile(
        script,
        `const line = JSON.stringify({ type: 'result', subtype: 'success', result: 'delegate=' + (process.env.AGENT_EVALS_DELEGATE_KEY ?? 'absent') + ' path=' + (process.env.PATH ? 'yes' : 'no') });\n` +
          `process.stdout.write(line + '\\n');\n`,
      )
      const logBase = join(await mkdtemp(join(tmpdir(), 'fake-claude-log-')), 's')
      const adapter = new ClaudeCodeAdapter({ commandTemplate: `node ${shellQuote(script)} {instruction}`, logPath: logBase, timeoutMs: 30_000 })
      const log = await adapter.runTask({ task: { id: 'fake-task' }, instruction: 'x' } as unknown as ResolvedTask, 1)
      expect(log.finalMessage).toBe('delegate=absent path=yes')
    } finally {
      if (previous === undefined) delete process.env.AGENT_EVALS_DELEGATE_KEY
      else process.env.AGENT_EVALS_DELEGATE_KEY = previous
    }
  })
})

// ── #4680: the cold profile's env ──────────────────────────────────────────

describe('buildColdChildEnv — no Haven credentials, the trial HOME', () => {
  it('strips every Haven and harness credential class', () => {
    const env = buildColdChildEnv(
      {
        PATH: '/usr/bin',
        HOME: '/home/runner',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
        HAVEN_CREDENTIALS: '/tmp/agent.json',
        HAVEN_API_URL: 'https://api.test',
        QA_EVAL_AGENT_API_KEY: 'sk_agent_secret',
        QA_EVAL_AGENT_ACCOUNT: '0xabc',
        QA_EVAL_RECIPIENT: '0xdef',
        QA_EVAL_SECRET_MANIFEST: '/tmp/manifest.json',
        QA_EVAL_SIGNER_CLI: '/tmp/signer.js',
        QA_EVAL_HOSTED_MCP_URL: 'https://mcp.test/v1',
        QA_EVAL_TRIAL_CREDENTIALS: '/tmp/trial/agent.json',
        QA_EVAL_TRIAL_API_KEY: 'sk_agent_trial',
        AGENT_EVALS_DELEGATE_KEY: '0xdeadbeef',
        AGENT_EVALS_API_KEY: 'sk_agent_eval',
        QA_X402_BINDING_SIGNER: '0x123',
      },
      { HOME: '/tmp/trial-home', QA_EVAL_TRIAL_HOME: '/tmp/trial-home', QA_EVAL_TRIAL_MCP_CONFIG: '/tmp/trial-home/mcp.json' },
    )
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/tmp/trial-home')
    // claude's own auth stays: it authenticates claude, not Haven.
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-token')
    // The trial's wiring stays: the command template and MCP config need it.
    expect(env.QA_EVAL_TRIAL_MCP_CONFIG).toBe('/tmp/trial-home/mcp.json')
    for (const name of [
      'HAVEN_CREDENTIALS',
      'HAVEN_API_URL',
      'QA_EVAL_AGENT_API_KEY',
      'QA_EVAL_AGENT_ACCOUNT',
      'QA_EVAL_RECIPIENT',
      'QA_EVAL_SECRET_MANIFEST',
      'QA_EVAL_SIGNER_CLI',
      'QA_EVAL_HOSTED_MCP_URL',
      'QA_EVAL_TRIAL_CREDENTIALS',
      'QA_EVAL_TRIAL_API_KEY',
      'AGENT_EVALS_DELEGATE_KEY',
      'AGENT_EVALS_API_KEY',
      'QA_X402_BINDING_SIGNER',
    ]) {
      expect(env[name], name).toBeUndefined()
    }
  })

  it('the adapter passes the cold env to spawn (proved on the environment)', async () => {
    const previous = process.env.HAVEN_CREDENTIALS
    process.env.HAVEN_CREDENTIALS = '/tmp/agent.json'
    try {
      const dir = await mkdtemp(join(tmpdir(), 'fake-claude-cold-'))
      const script = join(dir, 'fake-claude.mjs')
      await writeFile(
        script,
        `const line = JSON.stringify({ type: 'result', subtype: 'success', result: 'haven=' + (process.env.HAVEN_CREDENTIALS ?? 'absent') + ' home=' + (process.env.HOME ?? 'absent') });\n` +
          `process.stdout.write(line + '\\n');\n`,
      )
      const logBase = join(await mkdtemp(join(tmpdir(), 'fake-claude-cold-log-')), 's')
      const adapter = new ClaudeCodeAdapter({ commandTemplate: `node ${shellQuote(script)} {instruction}`, logPath: logBase, timeoutMs: 30_000 })
      const log = await adapter.runTask(
        {
          task: { id: 'cold-task' },
          instruction: 'x',
          coldProfile: { landingUrl: 'https://dev.example', cliPackage: '@haven_ai/cli@dev' },
          trialEnv: { HOME: '/tmp/trial-home' },
        } as unknown as ResolvedTask,
        1,
      )
      expect(log.finalMessage).toBe('haven=absent home=/tmp/trial-home')
    } finally {
      if (previous === undefined) delete process.env.HAVEN_CREDENTIALS
      else process.env.HAVEN_CREDENTIALS = previous
    }
  })
})
