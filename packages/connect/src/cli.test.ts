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
