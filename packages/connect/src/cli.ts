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
  if (parsed.tombstone) {
    // #1681: retire a credential directory in place. Reads the stored
    // identity for the agent id, replaces the wrapper with a truth-telling
    // tombstone, touches NO key material, and tells the user what the
    // tombstone cannot do for them: restart every long-lived host.
    const { writeAgentTombstone } = await import('./tombstone.js')
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    try {
      let agentId = 'unknown'
      try {
        const identity = JSON.parse(
          await readFile(join(parsed.tombstone.directory, 'identity.json'), 'utf8'),
        ) as { agent_id?: string }
        agentId = identity.agent_id ?? 'unknown'
      } catch {
        // A directory whose identity no longer parses can still be retired —
        // the tombstone then names it as unknown, which is honest.
      }
      const info = await writeAgentTombstone({
        directory: parsed.tombstone.directory,
        agentId,
        reason: parsed.tombstone.reason ?? 'retired by operator via --tombstone',
        replacedBy: parsed.tombstone.replacedBy,
      })
      if (parsed.json) {
        io.stdout(`${redactSecrets(JSON.stringify({ tombstoned: true, ...info }))}\n`)
      } else {
        io.stdout(redactSecrets(`Tombstoned agent ${info.agent_id} at ${parsed.tombstone.directory}.\n`))
        io.stdout(
          'Key files were NOT touched and nothing was revoked — revoke the agent on the Haven ' +
            'agent page if you have not already.\n',
        )
        io.stdout(
          'Restart EVERY long-lived MCP host (gateway, TUI workers, editors): each holds the ' +
            'wiring snapshot from its own start time, and the tombstone only speaks when a stale ' +
            'host next probes the old path.\n',
        )
      }
      return 0
    } catch (err) {
      io.stderr(`${redactSecrets(err instanceof Error ? err.message : String(err))}\n`)
      return 1
    }
  }
  if (parsed.doctor || parsed.repair) {
    const { runDoctor, runRepair } = await import('./doctor.js')
    const runtime = parsed.options.runtime ?? ''
    const credentialsDir = parsed.options.credentialsDir
    try {
      if (parsed.repair) {
        const repair = await runRepair({ runtime, credentialsDir })
        for (const message of repair.messages) io.stderr(`${redactSecrets(message)}\n`)
        if (!repair.ok) return 1
      }
      const report = await runDoctor({ runtime, credentialsDir })
      // Defensively redacted like every other output path — the report is
      // secret-free by construction, but signerCapabilities is untrusted
      // process output and belts are cheap (#1589 review).
      if (parsed.json) {
        io.stdout(`${redactSecrets(JSON.stringify(report))}\n`)
      } else {
        for (const check of report.checks) {
          io.stdout(redactSecrets(`${check.ok ? '✓' : '✗'} ${check.label}: ${check.detail}\n`))
          if (check.repair) io.stdout(redactSecrets(`    ↳ repair: ${check.repair}\n`))
        }
        // #1697: the other agents on this machine. The flat list above
        // describes ONE agent; multi-agent means the rest still have to be
        // accounted for, by name and by verdict, never silently dropped.
        const otherAgents = report.agents.filter((agent) => agent.directory !== report.credentialDirectory)
        if (otherAgents.length > 0) {
          io.stdout('\nOther agents on this machine:\n')
          for (const agent of otherAgents) {
            const name = agent.slug ? `${agent.slug} (${agent.agentId ?? 'unknown'})` : agent.agentId ?? 'unknown'
            const failed = agent.checks.filter((check) => !check.ok)
            const verdict = agent.classification === 'wired'
              ? failed.length === 0 ? 'wired, all checks passed' : `wired, ${failed.length} check(s) FAILED`
              : agent.classification
            io.stdout(redactSecrets(`  ${failed.length > 0 ? '✗' : '•'} ${name}: ${verdict}\n`))
            for (const check of failed) {
              io.stdout(redactSecrets(`      ✗ ${check.label}: ${check.detail}\n`))
              if (check.repair) io.stdout(redactSecrets(`        ↳ repair: ${check.repair}\n`))
            }
          }
        }
        io.stdout(report.ok ? 'All checks passed.\n' : 'One or more checks FAILED — see repairs above.\n')
      }
      return report.ok ? 0 : 1
    } catch (err) {
      io.stderr(`${redactSecrets(err instanceof Error ? err.message : String(err))}\n`)
      return 1
    }
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
