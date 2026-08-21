import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isCliEntrypoint, runCli } from './cli.js'
import * as runtime from './runtime.js'

let tempDir = ''

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
  tempDir = ''
})

describe('structured Connect CLI output', () => {
  it('keeps parse errors as one JSON result on stdout', async () => {
    const stdout: string[] = []
    const stderr: string[] = []
    const exitCode = await runCli(['--json', '--unknown'], {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    })

    expect(exitCode).toBe(1)
    expect(stdout).toHaveLength(1)
    expect(stderr).toEqual([])
    expect(JSON.parse(stdout[0])).toMatchObject({
      schema_version: 1,
      outcome: 'failed',
      error: { code: 'connect_failed' },
    })
  })

  it('documents the structured mode in help', async () => {
    const stdout: string[] = []
    const exitCode = await runCli(['--help'], {
      stdout: (message) => stdout.push(message),
      stderr: () => undefined,
    })
    expect(exitCode).toBe(0)
    expect(stdout.join('')).toContain('--json')
  })
})

describe('--json wiring for the approval wait (#1377 D)', () => {
  // The one-line pass-through the review flagged as untested: flipping this
  // boolean would make automation runs block for the full 3-minute bound.
  it('passes waitForApproval:false under --json and true (default wait) without it', async () => {
    const seen: Array<boolean | undefined> = []
    const spy = vi.spyOn(runtime, 'runConnect').mockImplementation(async (options) => {
      seen.push(options.waitForApproval)
      return { outcome: { schema_version: 1, outcome: 'complete' } } as never
    })
    try {
      const io = { stdout: () => undefined, stderr: () => undefined }
      await runCli(['--setup', 'hv_setup_x', '--api', 'https://api.haven.example', '--json'], io)
      await runCli(['--setup', 'hv_setup_x', '--api', 'https://api.haven.example'], io)
    } finally {
      spy.mockRestore()
    }
    expect(seen).toEqual([false, true])
  })
})

describe('CLI entrypoint detection (#1379)', () => {
  it('recognizes an npm-style bin symlink without running ordinary imports', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'haven-connect-cli-'))
    const realCliPath = join(tempDir, 'dist', 'cli.js')
    const binPath = join(tempDir, 'node_modules', '.bin', 'haven-connect')
    await mkdir(join(tempDir, 'dist'), { recursive: true })
    await mkdir(join(tempDir, 'node_modules', '.bin'), { recursive: true })
    await writeFile(realCliPath, '#!/usr/bin/env node\n')
    await symlink('../../dist/cli.js', binPath)

    expect(isCliEntrypoint(binPath, pathToFileURL(realCliPath).href)).toBe(true)
    expect(isCliEntrypoint(undefined, pathToFileURL(realCliPath).href)).toBe(false)
  })
})

describe('--tombstone (#1681)', () => {
  async function agentDir() {
    tempDir = await mkdtemp(join(tmpdir(), 'haven-cli-tombstone-'))
    const dir = join(tempDir, 'agent-old')
    await mkdir(join(dir, 'bin'), { recursive: true })
    await writeFile(join(dir, 'identity.json'), JSON.stringify({ agent_id: 'agent-old', api_key: 'sk_agent_x' }))
    await writeFile(join(dir, 'bin', 'haven-signer.mjs'), '// real wrapper')
    return dir
  }

  it('retires the directory: tombstone written, keys untouched, exit 0, no setup token needed', async () => {
    const dir = await agentDir()
    const stdout: string[] = []
    const exitCode = await runCli(
      ['--tombstone', dir, '--reason', 'superseded', '--replaced-by', 'agent-new'],
      { stdout: (m) => stdout.push(m), stderr: () => undefined },
    )

    expect(exitCode).toBe(0)
    const { readFile } = await import('node:fs/promises')
    const script = await readFile(join(dir, 'bin', 'haven-signer.mjs'), 'utf8')
    expect(script).toContain('HAVEN-TOMBSTONE')
    const record = JSON.parse(await readFile(join(dir, 'TOMBSTONE.json'), 'utf8'))
    expect(record).toMatchObject({ agent_id: 'agent-old', reason: 'superseded', replaced_by: 'agent-new' })
    // identity.json survives byte-for-byte — connect never revokes or deletes.
    expect(await readFile(join(dir, 'identity.json'), 'utf8')).toContain('sk_agent_x')
    const out = stdout.join('')
    expect(out).toMatch(/nothing was revoked/)
    expect(out).toMatch(/Restart EVERY long-lived MCP host/)
    // The agent API key must never surface in output.
    expect(out).not.toContain('sk_agent_x')
  })

  it('--json emits one secret-free record', async () => {
    const dir = await agentDir()
    const stdout: string[] = []
    const exitCode = await runCli(['--tombstone', dir, '--json'], {
      stdout: (m) => stdout.push(m), stderr: () => undefined,
    })
    expect(exitCode).toBe(0)
    expect(stdout).toHaveLength(1)
    const record = JSON.parse(stdout[0])
    expect(record).toMatchObject({ tombstoned: true, agent_id: 'agent-old' })
    expect(stdout[0]).not.toContain('sk_agent_x')
  })

  it('a directory with unreadable identity is still retired, named unknown', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'haven-cli-tombstone-bare-'))
    const dir = join(tempDir, 'mystery')
    await mkdir(dir, { recursive: true })
    const stdout: string[] = []
    const exitCode = await runCli(['--tombstone', dir], {
      stdout: (m) => stdout.push(m), stderr: () => undefined,
    })
    expect(exitCode).toBe(0)
    expect(stdout.join('')).toContain('unknown')
  })
})

describe('--doctor per-agent output (#1697)', () => {
  it('names every OTHER agent and its verdict — a second agent is never silently dropped', async () => {
    const stdout: string[] = []
    const doctor = await import('./doctor.js')
    const spy = vi.spyOn(doctor, 'runDoctor').mockResolvedValue({
      version: 1,
      ok: false,
      runtime: 'codex-cli',
      credentialDirectory: '/home/u/.haven/agents/agent-1',
      checks: [{ id: 'credentials', label: 'Agent credentials', ok: true, detail: 'fine' }],
      agents: [
        {
          agentId: 'agent-1', directory: '/home/u/.haven/agents/agent-1',
          classification: 'wired' as const, checks: [],
        },
        {
          slug: 'ops', agentId: 'agent-ops', directory: '/home/u/.haven/agents/ops',
          classification: 'wired' as const,
          checks: [{
            id: 'identity_match', label: 'Hosted identity matches the local signing key',
            ok: false, detail: 'MISMATCH: quote as one agent and sign as another.',
            repair: 'Re-run setup for this agent.',
          }],
        },
        {
          agentId: 'agent-dead', directory: '/home/u/.haven/agents/dead',
          classification: 'retired' as const, checks: [],
        },
      ],
    })
    try {
      const exitCode = await runCli(['--doctor', '--runtime', 'codex-cli'], {
        stdout: (m) => stdout.push(m), stderr: () => undefined,
      })
      expect(exitCode).toBe(1)
      const out = stdout.join('')
      expect(out).toContain('Other agents on this machine')
      expect(out).toContain('ops (agent-ops)')
      expect(out).toContain('wired, 1 check(s) FAILED')
      expect(out).toContain('MISMATCH')
      expect(out).toContain('agent-dead: retired')
      // The primary is described by the flat list above, not repeated here.
      expect(out).not.toContain('agent-1: wired')
    } finally {
      spy.mockRestore()
    }
  })
})
