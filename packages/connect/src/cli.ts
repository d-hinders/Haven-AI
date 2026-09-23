#!/usr/bin/env node

import type { DoctorLevel, DoctorReport } from './doctor.js'
import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { helpText, parseArgs } from './args.js'
import { failedConnectOutcome, failureOutcomeFor, runConnect } from './runtime.js'
import { redactForAutomation, redactSecrets } from './redact.js'
import { isConnectError } from './connect-error.js'

export interface CliIo {
  stdout: (message: string) => void
  stderr: (message: string) => void
}

/**
 * Report a subcommand failure on BOTH channels (#2184).
 *
 * Every subcommand but the main connect run used to write its failure to
 * stderr alone and leave stdout empty. To a `--json` caller parsing stdout
 * that is indistinguishable from a stream it stopped reading — which is
 * exactly how a field `haven-reset` reported "the tombstone command did not
 * create TOMBSTONE.json" with no error to show for it (#2175). One helper, so
 * the next subcommand inherits the behaviour instead of re-deciding it.
 *
 * `envelope` carries the branch's own success discriminant inverted
 * (`{ unwired: false }`, `{ rekey: 'failed' }`), so a failure record can never
 * be mistaken for a success payload — this matters most for `--doctor`, whose
 * success output IS a JSON report.
 *
 * `message` rides along ONLY for a connector-authored `ConnectError`, the same
 * gate `failedConnectOutcome` applies. A bare `Error` here is an unguarded
 * failure whose raw text can carry agent ids, local paths, or arbitrary OS
 * detail (`rekey.ts` throws several such); that text reaches stderr, where it
 * always did, and never the machine channel.
 */
function failSubcommand(
  io: CliIo,
  json: boolean,
  err: unknown,
  envelope: Record<string, unknown>,
  fallback: { code: string; nextAction: string },
): number {
  const message = err instanceof Error ? err.message : String(err)
  io.stderr(`${redactSecrets(message)}\n`)
  if (json) {
    io.stdout(
      `${redactSecrets(
        JSON.stringify({
          ...envelope,
          error: {
            code: isConnectError(err) ? err.code : fallback.code,
            next_action: isConnectError(err) ? err.nextAction : fallback.nextAction,
            ...(isConnectError(err) && message ? { message } : {}),
          },
        }),
      )}\n`,
    )
  }
  return 1
}

/** #3121: one marker per verdict level — `✓` ok, `!` advisory, `✗` failed. */
function levelMarker(level: DoctorLevel): string {
  return level === 'ok' ? '✓' : level === 'advisory' ? '!' : '✗'
}

/** Advisories across the flat list and every wired agent's checks — the same set the rolled-up level reads. */
function advisoryCount(report: DoctorReport): number {
  // The primary directory's checks ARE the flat list (doctor.ts copies them by
  // id), so it is excluded here or the single-agent case counts itself twice
  // (#3145 review, finding 1) — the same set the "Other agents" section prints.
  const others = report.agents
    .filter((agent) => agent.classification === 'wired' && agent.directory !== report.credentialDirectory)
    .flatMap((agent) => agent.checks)
  return [...report.checks, ...others].filter((check) => check.level === 'advisory').length
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
      // #2091: same stderr mirror as the run-failure path below.
      io.stderr(`${redactForAutomation(err instanceof Error ? err.message : String(err))}\n`)
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
    const { writeAgentTombstone, tombstonesDirForAgentDirectory } = await import('./tombstone.js')
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
        // #3251: the ledger of the root that holds the retired directory —
        // ~/.haven/agents/<x> → ~/.haven/tombstones, exactly as before; a
        // directory under any other root → <root>/.tombstones.
        tombstonesDir: tombstonesDirForAgentDirectory(parsed.tombstone.directory),
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
          `A surviving tombstone record was mirrored to ${redactSecrets(info.recordPath)}\n`,
        )
        io.stdout(
          'Restart EVERY long-lived MCP host (gateway, TUI workers, editors): each holds the ' +
            'wiring snapshot from its own start time, and the tombstone only speaks when a stale ' +
            'host next probes the old path. The mirrored record keeps this retirement observable ' +
            'even after the agent directory itself is deleted.\n',
        )
      }
      return 0
    } catch (err) {
      // #2175 introduced this record; #2184 moved it into `failSubcommand` so
      // the three sibling subcommands share it rather than each re-deciding.
      return failSubcommand(io, parsed.json, err, { tombstoned: false }, {
        code: 'tombstone_failed',
        nextAction: 'review_the_error_and_retry_with_a_valid_agent_directory',
      })
    }
  }
  if (parsed.unwire) {
    // #2169: tombstone-first removal of ONE agent's wiring from every runtime
    // config it appears in + the Hermes dotenv key. Refuses — never guesses —
    // when the bare pair is provably another agent's.
    const { unwireAgent } = await import('./unwire.js')
    const { tombstonesDirForAgentDirectory } = await import('./tombstone.js')
    const { homedir } = await import('node:os')
    const { join } = await import('node:path')
    const homeDir = homedir()
    const root = parsed.options.credentialsDir ?? join(homeDir, '.haven', 'agents')
    const directory =
      parsed.unwireDir ?? (parsed.options.serverName ? join(root, parsed.options.serverName) : root)
    try {
      const result = await unwireAgent({
        directory,
        slug: parsed.options.serverName,
        reason: parsed.unwire.reason,
        replacedBy: parsed.unwire.replacedBy,
        destroyKeyMaterial: parsed.unwire.destroyKeyMaterial,
        homeDir,
        // #3251: the ledger of the root that holds the directory being
        // retired. Derived from the RESOLVED directory, not from
        // --credentials-dir: `--unwire --credentials-dir <path>` names the agent
        // directory itself, not a root. ~/.haven/agents/<slug> →
        // ~/.haven/tombstones, exactly as before; any other root →
        // <root>/.tombstones.
        tombstonesDir: tombstonesDirForAgentDirectory(directory, homeDir),
      })
      const failures = result.runtimes.filter((r) => r.status === 'refused' || r.status === 'unreadable')
      // #3123: a retained teardown is a refusal too — the wiring is gone, the
      // key material deliberately is not, and the exit code says so.
      const retained = result.teardown.status === 'retained'
      if (parsed.json) {
        io.stdout(
          `${redactSecrets(
            JSON.stringify({
              unwired: true,
              agent_id: result.agentId,
              slug: result.slug ?? null,
              directory: result.directory,
              tombstoned: result.tombstoned,
              runtimes: result.runtimes.map((r) => ({
                runtime: r.runtime,
                label: r.label,
                status: r.status,
                ...(r.detail ? { detail: r.detail } : {}),
              })),
              // #3122: additive — whether the local server-name binding record was released.
              binding_released: result.bindingReleased,
              // #3123: additive — what happened to the key material and why.
              teardown: {
                status: result.teardown.status,
                probe: result.teardown.probe,
                detail: result.teardown.detail,
                ...(result.teardown.remedy ? { remedy: result.teardown.remedy } : {}),
              },
            }),
          )}\n`,
        )
      } else {
        io.stdout(redactSecrets(`Unwired agent ${result.agentId} at ${result.directory}.\n`))
        io.stdout(
          result.tombstoned
            ? '  · Tombstoned first: any long-lived host still resolving the old wrapper gets the HAVEN-TOMBSTONE diagnosis.\n'
            : '  · Directory was already tombstoned.\n',
        )
        for (const r of result.runtimes) {
          const mark = r.status === 'removed' ? '✓' : r.status === 'clean' ? '–' : '✗'
          io.stdout(redactSecrets(`  ${mark} ${r.label}: ${r.status}${r.detail ? ` — ${r.detail}` : ''}\n`))
        }
        io.stdout(result.bindingReleased
          ? '  ✓ MCP server-name binding: released (the name is free for the next setup).\n'
          : '  – MCP server-name binding: none recorded for this directory.\n')
        const t = result.teardown
        io.stdout(redactSecrets(`  ${t.status === 'retained' ? '✗' : t.status === 'forced' ? '!' : '✓'} Key material: ${t.status} (probe: ${t.probe}) — ${t.detail}\n`))
        if (t.remedy) io.stdout(redactSecrets(`    ↳ ${t.remedy}\n`))
        io.stdout(
          failures.length > 0
            ? '  Some entries were NOT removed (✗ above). Re-run `--unwire` after resolving each refusal —\n' +
              '  it is idempotent.\n'
            : retained
              ? '  The wiring is gone; the key material is not (✗ above). `--doctor` will keep reporting this directory\n' +
                '  as `superseded` until the key is revoked or destroyed — that is the honest state.\n'
              : '  Verify: `--doctor --runtime <runtime>` per host should report this agent as `retired` with a\n' +
                '  clean runtime-config check.\n',
        )
        io.stdout(
          'Restart EVERY long-lived MCP host (gateway, TUI workers, editors): each holds the wiring snapshot\n' +
            'from its own start time. ' +
            (retained
              ? 'This directory\u2019s local key material was KEPT (see above); the tombstone\n'
              : 'This directory\u2019s local key material was removed and the tombstone\n') +
            'record + #2155 mirror survive — but nothing was REVOKED on the backend. If you have not\n' +
            'already, revoke the agent on the Haven agent page to stop it spending entirely.\n',
        )
      }
      return failures.length > 0 || retained ? 1 : 0
    } catch (err) {
      return failSubcommand(io, parsed.json, err, { unwired: false }, {
        code: 'unwire_failed',
        nextAction: 'review_the_error_and_rerun_unwire_which_is_idempotent',
      })
    }
  }
  if (parsed.pruneSignerRuntimes) {
    // #3123: reclaim signer-runtime directories no credential directory
    // references. Its own flag — not part of --repair (which installs) and
    // never automatic. Exit 1 only when a removal FAILED.
    const { pruneSignerRuntimes } = await import('./prune-runtimes.js')
    try {
      const report = await pruneSignerRuntimes(
        { dryRun: parsed.pruneSignerRuntimes.dryRun },
        { credentialsDir: parsed.options.credentialsDir },
      )
      if (parsed.json) {
        io.stdout(`${redactSecrets(JSON.stringify({
          pruned: true,
          version: report.version,
          dry_run: report.dryRun,
          level: report.level,
          root: report.root,
          removed: report.removed,
          reclaimed_bytes: report.reclaimedBytes,
          entries: report.entries.map((e) => ({
            key: e.key, kind: e.kind, bytes: e.bytes, action: e.action, level: e.level,
            referenced_by: e.referencedBy, detail: e.detail,
          })),
        }))}\n`)
      } else {
        io.stdout(`Signer runtimes under ${report.root}${report.dryRun ? ' (dry run — nothing removed)' : ''}:\n`)
        if (report.entries.length === 0) io.stdout('  (none)\n')
        for (const e of report.entries) {
          const mark = e.level === 'failed' ? '✗' : e.level === 'advisory' ? '!' : e.action === 'removed' ? '✓' : '•'
          // A kept directory is never sized (#3151 review): say so instead of printing a false 0 MB.
          const size = e.bytes > 0 ? `${Math.round(e.bytes / 1024 / 1024)} MB` : e.action === 'kept' ? 'not sized' : '0 MB'
          io.stdout(redactSecrets(`  ${mark} ${e.key} (${e.kind}, ${size}): ${e.detail}\n`))
        }
        io.stdout(
          report.dryRun
            ? `Would remove ${report.entries.filter((e) => e.action === 'would_remove').length} director(y/ies); re-run without --dry-run to reclaim.\n`
            : `Removed ${report.removed} director(y/ies), reclaimed ${Math.round(report.reclaimedBytes / 1024 / 1024)} MB.\n`,
        )
      }
      return report.level === 'failed' ? 1 : 0
    } catch (err) {
      return failSubcommand(io, parsed.json, err, { pruned: false }, {
        code: 'prune_failed',
        nextAction: 'review_the_error_and_rerun_prune_which_is_idempotent',
      })
    }
  }
  if (parsed.rekey) {
    // #1700: replace an agent's signing key on this machine. Two phases with
    // the owner's dashboard between them — this connector never calls the
    // re-key API, which is owner-authenticated by design.
    const { startRekey, finishRekey } = await import('./rekey.js')
    const { restartGuidance } = await import('./rekey-restart.js')
    const common = {
      serverName: parsed.options.serverName,
      credentialsDir: parsed.options.credentialsDir,
      runtime: parsed.options.runtime,
    }
    try {
      if (parsed.rekey.phase === 'start') {
        const result = await startRekey(common)
        if (parsed.json) {
          // The address is public; the private half never appears here or
          // anywhere else this process writes to a stream.
          io.stdout(
            `${redactSecrets(
              JSON.stringify({
                rekey: 'started',
                agent_id: result.agentId,
                new_delegate_address: result.newDelegateAddress,
                expires_at: result.expiresAt,
              }),
            )}\n`,
          )
        } else {
          for (const line of result.messages) io.stdout(redactSecrets(`${line}\n`))
        }
        return 0
      }

      const result = await finishRekey({ ...common, newApiKey: parsed.rekey.newApiKey })
      const restart = restartGuidance(parsed.options.runtime)
      if (parsed.json) {
        io.stdout(
          `${redactSecrets(
            JSON.stringify({
              rekey: 'finished',
              agent_id: result.agentId,
              new_delegate_address: result.newDelegateAddress,
              mcp_servers: result.serverNames,
              restart_commands: restart.commands,
            }),
          )}\n`,
        )
      } else {
        for (const line of result.messages) io.stdout(redactSecrets(`${line}\n`))
        io.stdout('\n')
        for (const line of restart.lines) io.stdout(redactSecrets(`${line}\n`))
      }
      return 0
    } catch (err) {
      return failSubcommand(io, parsed.json, err, { rekey: 'failed' }, {
        code: 'rekey_failed',
        nextAction: 'review_the_error_and_rerun_the_rekey_phase',
      })
    }
  }
  if (parsed.doctor || parsed.repair) {
    const { runDoctor, runRepair } = await import('./doctor.js')
    // '' is the doctor's "no flag given" input: it resolves the runtime from
    // the setup record, else reports it unknown (#3120). Reachable for
    // --doctor since #3210; --repair never gets here without a flag (args.ts).
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
        // #3121: three markers for three levels. `!` is an advisory — worth
        // reading, nothing broken, and it never reaches the exit code.
        for (const check of report.checks) {
          io.stdout(redactSecrets(`${levelMarker(check.level)} ${check.label}: ${check.detail}\n`))
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
            const failed = agent.checks.filter((check) => check.level === 'failed')
            const advised = agent.checks.filter((check) => check.level === 'advisory')
            const verdict = agent.classification === 'wired'
              ? failed.length > 0
                ? `wired, ${failed.length} check(s) FAILED`
                : advised.length > 0
                  ? `wired, ${advised.length} advisory finding(s)`
                  : 'wired, all checks passed'
              // #1915: `parked` is the one classification whose bare name says
              // nothing a reader can act on — it is not a broken agent, it is
              // a directory with no agent in it and a private key still in it.
              // Spell that out here; the path and state are on the parked
              // re-key check above.
              : agent.classification === 'parked'
                ? 'parked re-key only — no identity.json in this directory, but key material is still there'
                : agent.classification
            io.stdout(redactSecrets(`  ${failed.length > 0 ? '✗' : advised.length > 0 ? '!' : '•'} ${name}: ${verdict}\n`))
            for (const check of [...failed, ...advised]) {
              io.stdout(redactSecrets(`      ${levelMarker(check.level)} ${check.label}: ${check.detail}\n`))
              if (check.repair) io.stdout(redactSecrets(`        ↳ repair: ${check.repair}\n`))
            }
          }
        }
        io.stdout(
          report.level === 'failed'
            ? 'One or more checks FAILED — see repairs above.\n'
            : report.level === 'advisory'
              ? `No failures. ${advisoryCount(report)} advisory finding(s) — see the ! line(s) above.\n`
              : 'All checks passed.\n',
        )
      }
      // #3121: the exit code counts only real failures. `report.ok` is the
      // same predicate (`level !== 'failed'`), kept for --json consumers.
      return report.level === 'failed' ? 1 : 0
    } catch (err) {
      return failSubcommand(io, parsed.json, err, { doctor: 'failed' }, {
        code: 'doctor_failed',
        nextAction: 'review_the_error_and_rerun_doctor',
      })
    }
  }
  try {
    // --json is the automation contract: emit the outcome promptly instead of
    // blocking up to the approval-wait bound (#1377 D).
    const result = await runConnect(
      {
        ...parsed.options,
        // #1377 D / #2484: leave prose runs UNSPECIFIED (undefined) so
        // runConnect's stdout-TTY narration gate decides whether there is a
        // watching human to narrate to — an agent invoking prose as a tool
        // call has none and must not sit opaque in the wait. --json stays an
        // explicit false (skip, emit promptly).
        waitForApproval: parsed.json ? false : undefined,
        // #1719: only a human-facing run may be asked which installed client to
        // configure. --json is the automation contract — it must fail with a
        // machine-readable code, never block on stdin. runConnect additionally
        // requires a real TTY before it prompts.
        interactive: !parsed.json,
        // #2528: reported to the backend at register, so the funnel can tell a
        // machine-readable run from a narrated one. Read from the SAME
        // `parsed.json` the three flags above use, rather than inferred later
        // from `waitForApproval` — that flag is already false for a prose run
        // with no TTY (#2484), so inferring would mislabel real prose runs.
        runMode: parsed.json ? 'json' : 'prose',
      },
      {
        log: (message) => (parsed.json ? io.stderr : io.stdout)(`${message}\n`),
        redactPaths: parsed.json,
      },
    )
    if (parsed.json) io.stdout(`${JSON.stringify(result.outcome)}\n`)
    return 0
  } catch (err) {
    if (parsed.json) {
      // #2091: mirror the redacted message to stderr as well — stdout stays
      // pure JSON for the automation contract, but the prose channel must
      // never be silently discarded (progress lines already go to stderr in
      // --json mode; the failure that ends the run belongs there too). Same
      // redaction bar as those progress lines and the JSON message field:
      // redactForAutomation, which also masks credential-file paths.
      io.stderr(`${redactForAutomation(err instanceof Error ? err.message : String(err))}\n`)
      // #2173: the run's OWN record when it built one, so the object printed
      // here is byte-identical to the one persisted to `last-connect-outcome.json`.
      // Re-deriving it from the raw `--runtime` hint would report the hint,
      // not the runtime detection actually resolved (#1672).
      io.stdout(`${JSON.stringify(failureOutcomeFor(parsed.options.runtime, err))}\n`)
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
