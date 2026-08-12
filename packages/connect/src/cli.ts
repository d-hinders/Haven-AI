#!/usr/bin/env node

import { pathToFileURL } from 'node:url'
import { helpText, parseArgs } from './args.js'
import { failedConnectOutcome, runConnect } from './runtime.js'
import { redactSecrets } from './redact.js'

export interface CliIo {
  stdout: (message: string) => void
  stderr: (message: string) => void
}

export async function runCli(
  argv: string[],
  io: CliIo = {
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message),
  },
): Promise<number> {
  const wantsJson = argv.includes('--json')
  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (err) {
    if (wantsJson) {
      io.stdout(`${JSON.stringify(failedConnectOutcome(undefined, err))}\n`)
    } else {
      io.stderr(`${redactSecrets(err instanceof Error ? err.message : String(err))}\n`)
    }
    return 1
  }
  if (parsed.help) {
    io.stdout(`${helpText()}\n`)
    return 0
  }
  try {
    const result = await runConnect(parsed.options, {
      log: (message) => (parsed.json ? io.stderr : io.stdout)(`${message}\n`),
      redactPaths: parsed.json,
    })
    if (parsed.json) io.stdout(`${JSON.stringify(result.outcome)}\n`)
    return 0
  } catch (err) {
    if (parsed.json) {
      io.stdout(`${JSON.stringify(failedConnectOutcome(parsed.options.runtime, err))}\n`)
    } else {
      io.stderr(`${redactSecrets(err instanceof Error ? err.message : String(err))}\n`)
    }
    return 1
  }
}

async function main(): Promise<void> {
  const exitCode = await runCli(process.argv.slice(2))
  if (exitCode !== 0) process.exitCode = exitCode
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) void main()
