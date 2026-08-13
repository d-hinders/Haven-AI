#!/usr/bin/env node

import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
    // --json is the automation contract: emit the outcome promptly instead of
    // blocking up to the approval-wait bound (#1377 D).
    const result = await runConnect(
      { ...parsed.options, waitForApproval: !parsed.json },
      {
        log: (message) => (parsed.json ? io.stderr : io.stdout)(`${message}\n`),
        redactPaths: parsed.json,
      },
    )
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

/**
 * npm executes package bins through a `node_modules/.bin` symlink. Node keeps
 * that symlink in `process.argv[1]`, whereas `import.meta.url` identifies the
 * real module path. Resolve both sides before comparing so a published
 * `haven-connect` bin starts, while an ordinary `runCli` import remains inert.
 */
export function isCliEntrypoint(
  argvPath: string | undefined = process.argv[1],
  moduleUrl: string = import.meta.url,
): boolean {
  if (!argvPath) return false
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    // Keep the direct-file behavior when a loader provides an unresolvable
    // path. A missing path cannot be a safe reason to run imported CLI code.
    return pathToFileURL(argvPath).href === moduleUrl
  }
}

if (isCliEntrypoint()) void main()
