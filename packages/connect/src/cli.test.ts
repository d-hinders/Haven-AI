import { describe, expect, it } from 'vitest'
import { runCli } from './cli.js'

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
