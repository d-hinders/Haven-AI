/**
 * The cold profile's eval-only command tool (#4680).
 *
 * The adversarial cases are the point: `Bash` stays denied because a
 * shell-prefix allowlist is too easy to get wrong, so this tool must refuse
 * `&& env`, command substitution, an alternate package, a file read and an
 * arbitrary subcommand — and still run the manifest's CLI command.
 */

import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  COMMAND_TOOL_DESCRIPTION,
  COMMAND_TOOL_NAME,
  buildCommandEnv,
  handleRpc,
  runCommand,
  validateCommandRequest,
  type SpawnFn,
} from './command-tool.js'

const PKG = '@haven_ai/cli@dev'

describe('validateCommandRequest — the closed allowlist', () => {
  it('accepts the manifest CLI command (npx <pkg> --help)', () => {
    expect(validateCommandRequest({ argv: ['npx', PKG, '--help'] }, PKG)).toEqual({ ok: true, argv: ['npx', PKG, '--help'] })
  })

  it('accepts npx -y <pkg> login … (what the 2026-09-28 agent ran)', () => {
    const argv = ['npx', '-y', PKG, 'login', '--api', 'https://api.test', '--json', '--no-wait']
    expect(validateCommandRequest({ argv }, PKG)).toEqual({ ok: true, argv })
  })

  it('accepts the read-only subcommands', () => {
    for (const argv of [
      ['npx', PKG, 'whoami'],
      ['npx', PKG, 'wallets', 'list'],
      ['npx', PKG, 'wallets', 'funding', '--json'],
      ['npx', PKG, 'activity', 'list'],
      ['npx', PKG, 'catalog', 'list'],
      ['npx', PKG, 'contacts', 'list'],
      ['npx', PKG, '--version'],
    ]) {
      expect(validateCommandRequest({ argv }, PKG).ok, argv.join(' ')).toBe(true)
    }
  })

  it('refuses `&& env` — a shell metacharacter in the argv', () => {
    const r = validateCommandRequest({ argv: ['npx', PKG, '--help', '&&', 'env'] }, PKG)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/character outside the allowed set/)
  })

  it('refuses command substitution', () => {
    for (const argv of [
      ['npx', PKG, '$(env)'],
      ['npx', PKG, '`env`'],
      ['npx', PKG, '--help;env'],
    ]) {
      expect(validateCommandRequest({ argv }, PKG).ok, argv.join(' ')).toBe(false)
    }
  })

  it('refuses an alternate package', () => {
    const r = validateCommandRequest({ argv: ['npx', '@evil/pkg', '--help'] }, PKG)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/package must be the CLI package/)
  })

  it('refuses a file read — argv[0] must be npx', () => {
    for (const argv of [
      ['cat', '/etc/passwd'],
      ['node', '-e', 'process.exit(0)'],
      ['/bin/sh', '-c', 'env'],
    ]) {
      expect(validateCommandRequest({ argv }, PKG).ok, argv.join(' ')).toBe(false)
    }
  })

  it('refuses an arbitrary subcommand', () => {
    const r = validateCommandRequest({ argv: ['npx', PKG, 'delete-everything'] }, PKG)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/not allowed before the login wall/)
  })

  it('refuses a write subcommand under a read-only command', () => {
    expect(validateCommandRequest({ argv: ['npx', PKG, 'wallets', 'rename', 'x'] }, PKG).ok).toBe(false)
    expect(validateCommandRequest({ argv: ['npx', PKG, 'agents', 'connect'] }, PKG).ok).toBe(false)
  })

  it('refuses when the manifest package was not read', () => {
    const r = validateCommandRequest({ argv: ['npx', PKG, '--help'] }, '')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toMatch(/not read from the manifest/)
  })

  it('refuses a malformed request', () => {
    expect(validateCommandRequest({}, PKG).ok).toBe(false)
    expect(validateCommandRequest({ argv: [] }, PKG).ok).toBe(false)
    expect(validateCommandRequest({ argv: ['npx', 1] }, PKG).ok).toBe(false)
    expect(validateCommandRequest(null, PKG).ok).toBe(false)
  })
})

describe('buildCommandEnv — the scrubbed child env', () => {
  it('keeps only the allowlist and sets HOME to the trial directory', () => {
    const env = buildCommandEnv(
      {
        PATH: '/usr/bin',
        HOME: '/home/runner',
        HAVEN_CREDENTIALS: '/tmp/agent.json',
        QA_EVAL_AGENT_API_KEY: 'sk_agent_secret',
        AGENT_EVALS_DELEGATE_KEY: '0xdeadbeef',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
      },
      '/tmp/trial-home',
    )
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/tmp/trial-home')
    expect(env.PWD).toBe('/tmp/trial-home')
    expect(env.HAVEN_CREDENTIALS).toBeUndefined()
    expect(env.QA_EVAL_AGENT_API_KEY).toBeUndefined()
    expect(env.AGENT_EVALS_DELEGATE_KEY).toBeUndefined()
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })
})

/** A fake child process: emits stdout/stderr data then closes. */
function fakeSpawn(record: { argv?: string[]; opts?: Record<string, unknown> }, out = 'ok\n', code = 0): SpawnFn {
  return (command: string, args: string[], opts: Record<string, unknown>) => {
    record.argv = [command, ...args]
    record.opts = opts
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(out))
      child.emit('close', code)
    })
    return child as never
  }
}

describe('runCommand — no shell, the trial HOME, the scrubbed env', () => {
  it('spawns the argv with shell:false and the trial HOME', async () => {
    const record: { argv?: string[]; opts?: Record<string, unknown> } = {}
    const outcome = await runCommand(['npx', PKG, '--help'], {
      trialHome: '/tmp/trial-home',
      env: { PATH: '/usr/bin', HOME: '/tmp/trial-home' },
      spawn: fakeSpawn(record),
    })
    expect(outcome.ok).toBe(true)
    expect(outcome.stdout).toBe('ok\n')
    expect(record.argv).toEqual(['npx', PKG, '--help'])
    expect(record.opts?.shell).toBe(false)
    expect(record.opts?.cwd).toBe('/tmp/trial-home')
    expect((record.opts?.env as Record<string, string>).HOME).toBe('/tmp/trial-home')
  })

  it('reports a non-zero exit as not ok', async () => {
    const outcome = await runCommand(['npx', PKG, 'whoami'], {
      trialHome: '/tmp/trial-home',
      env: {},
      spawn: fakeSpawn({}, '', 3),
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.exitCode).toBe(3)
  })
})

describe('handleRpc — the MCP surface', () => {
  const deps = { cliPackage: PKG, trialHome: '/tmp/trial-home', env: { HOME: '/tmp/trial-home' } }

  it('lists ONE tool with a neutral name and description that hint at no path', async () => {
    const res = (await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, deps)) as {
      result: { tools: Array<{ name: string; description: string }> }
    }
    expect(res.result.tools).toHaveLength(1)
    expect(res.result.tools[0]!.name).toBe(COMMAND_TOOL_NAME)
    expect(res.result.tools[0]!.description).toBe(COMMAND_TOOL_DESCRIPTION)
    for (const hint of ['/for-agents', '/llms', 'haven', 'Haven', 'onboarding', 'login']) {
      expect(res.result.tools[0]!.description).not.toContain(hint)
    }
  })

  it('answers initialize and ping', async () => {
    const init = (await handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize' }, deps)) as { result: { serverInfo: { name: string } } }
    expect(init.result.serverInfo.name).toBe('eval-command')
    expect(await handleRpc({ jsonrpc: '2.0', id: 2, method: 'ping' }, deps)).toEqual({ jsonrpc: '2.0', id: 2, result: {} })
  })

  it('returns a refusal as an isError tool RESULT, not a protocol error', async () => {
    const res = (await handleRpc(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: COMMAND_TOOL_NAME, arguments: { argv: ['npx', PKG, '--help', '&&', 'env'] } } },
      deps,
    )) as { result: { isError: boolean; content: Array<{ text: string }> } }
    expect(res.result.isError).toBe(true)
    expect(res.result.content[0]!.text).toMatch(/^refused:/)
  })

  it('runs an allowed command through the injected spawn', async () => {
    const record: { argv?: string[]; opts?: Record<string, unknown> } = {}
    const res = (await handleRpc(
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: COMMAND_TOOL_NAME, arguments: { argv: ['npx', PKG, '--help'] } } },
      { ...deps, spawn: fakeSpawn(record, 'usage\n') },
    )) as { result: { isError: boolean; content: Array<{ text: string }> } }
    expect(res.result.isError).toBe(false)
    expect(res.result.content[0]!.text).toContain('usage')
    expect(record.argv).toEqual(['npx', PKG, '--help'])
  })

  it('ignores a notification (no id) and refuses an unknown method', async () => {
    expect(await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, deps)).toBeUndefined()
    const res = (await handleRpc({ jsonrpc: '2.0', id: 5, method: 'nope' }, deps)) as { error: { code: number } }
    expect(res.error.code).toBe(-32601)
  })
})
