/**
 * Agent-directory tombstones (#1681) — for the RECREATION case, where an old
 * directory is abandoned. (#1700's --rekey deliberately writes no tombstone:
 * it rewrites credentials in place at a stable path, so no dead path exists —
 * owner decision on epic #1694, 2026-08-21.)
 *
 * A long-lived MCP host loads its wiring snapshot once, at process start.
 * When an agent is recreated and its old directory is later removed, every
 * such host keeps spawning the OLD wrapper path — and the spawn fails with a
 * FileNotFoundError the host masks as "Connection closed", parked and
 * re-probed every five minutes, indefinitely. The field report behind this
 * counted 5,356 occurrences of one dead UUID, and TWO different long-lived
 * processes each parked on a DIFFERENT dead UUID, because each holds the
 * snapshot from its own start time.
 *
 * A tombstone replaces the wrapper with a script that tells the truth: which
 * agent this was, when and why it was retired, and that THIS host must be
 * restarted. The park loop does not disappear — nothing local can reach into
 * a running host's memory — but every five-minute probe now logs the
 * diagnosis instead of a masked symptom, in exactly the stderr log where the
 * original investigation had to dig it out by hand.
 *
 * What a tombstone deliberately does NOT do:
 * - It never touches key material. identity.json / signer.json are left
 *   exactly as found — connect never revokes and never deletes credentials
 *   (#1688's standing rule). A retirement flow that wants the keys gone
 *   deletes them itself, and the tombstone survives to keep the path honest.
 * - It does not try to speak MCP. A well-formed JSON-RPC error needs the
 *   request id, which means reading stdin and racing client timeouts; a
 *   fast, loud stderr exit lands in the host's MCP stderr log — the place
 *   the #1681 forensics actually looked — on every probe, with no protocol
 *   to get subtly wrong.
 */

import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { connectorRerunCommand } from '@haven_ai/sdk'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { redactSecrets } from './redact.js'
import { ConnectError } from './connect-error.js'

export const TOMBSTONE_FILENAME = 'TOMBSTONE.json'

export interface TombstoneInfo {
  agent_id: string
  retired_at: string
  reason: string
  replaced_by?: string
}

export interface WriteTombstoneInput {
  /** The agent credential directory being retired. */
  directory: string
  agentId: string
  /** Why the directory was retired — rendered verbatim in the diagnosis. */
  reason: string
  /** The agent that superseded this one, when there is one. */
  replacedBy?: string
  /** Injectable for tests; defaults to now. */
  retiredAt?: string
  /** Root for the SURVIVING mirror record; defaults to ~/.haven/tombstones. */
  tombstonesDir?: string
}

/**
 * Where tombstone records survive OUTSIDE the retired agent directory.
 *
 * A tombstone written only inside the per-agent dir dies the moment that dir
 * is deleted — and the whole point of a tombstone is to keep speaking for an
 * OLD, possibly already-removed path. The mirror is keyed by agent id (the
 * durable identity; dirs may be uuid- or slug-named) so `--doctor` and humans
 * can always find WHO was retired and WHY even after `~/.haven/agents/<id>`
 * is long gone. Same redaction as the in-place record; no key material.
 * (#1681 review follow-up: the tombstone must live outside the per-agent tree
 * to survive a reset.)
 */
export function defaultTombstonesDir(baseDir?: string): string {
  return join(baseDir ?? join(homedir(), '.haven'), 'tombstones')
}

const MIRROR_MODE = 0o600

/**
 * Every tombstone record mirrored under the tombstones root — INCLUDING
 * retirees whose credential directory has since been deleted, which is the
 * case the in-place record cannot cover. Non-throwing: a missing or
 * unreadable record file is skipped, like every other enumeration path.
 */
export async function readTombstoneRecords(
  tombstonesDir?: string,
): Promise<Array<TombstoneInfo & { recordPath: string }>> {
  const root = tombstonesDir ?? defaultTombstonesDir()
  let entries: string[] = []
  try {
    entries = await readdir(root)
  } catch {
    return []
  }
  const records: Array<TombstoneInfo & { recordPath: string }> = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const recordPath = join(root, entry)
    try {
      const parsed = JSON.parse(await readFile(recordPath, 'utf8')) as TombstoneInfo
      if (typeof parsed?.agent_id === 'string') {
        records.push({ ...parsed, recordPath })
      }
    } catch {
      // unreadable record — skip; the in-place copy (if any) still speaks
    }
  }
  return records
}

/** The marker string hosts and humans can grep their MCP stderr logs for. */
export const TOMBSTONE_MARKER = 'HAVEN-TOMBSTONE'

function tombstoneScript(info: TombstoneInfo): string {
  const lines = [
    `${TOMBSTONE_MARKER}: this Haven agent was retired.`,
    '',
    `  agent:      ${info.agent_id}`,
    `  retired at: ${info.retired_at}`,
    `  reason:     ${info.reason}`,
    ...(info.replaced_by ? [`  replaced by: ${info.replaced_by}`] : []),
    '',
    'This process is running with a wiring snapshot that predates the',
    'retirement — it loaded its MCP config at startup and has kept it since.',
    'Restart THIS host to pick up the current wiring. If several long-lived',
    'hosts are running (a gateway, a TUI worker, an editor), restart EVERY',
    'one of them: each holds the snapshot from its own start time, so after',
    'a chain of recreations each can be parked on a DIFFERENT old agent.',
    '',
    `Then verify with: ${connectorRerunCommand('--doctor --runtime <runtime>')}`,
  ]
  // Fully self-contained: no imports, no reads — a tombstone that could
  // itself fail to start would recreate the exact masking it exists to end.
  return [
    '#!/usr/bin/env node',
    `// ${TOMBSTONE_MARKER} — written by @haven_ai/connect (#1681). Safe to delete`,
    '// once every long-lived MCP host on this machine has been restarted.',
    `process.stderr.write(${JSON.stringify(lines.join('\n') + '\n')})`,
    'process.exit(1)',
    '',
  ].join('\n')
}

/**
 * Replace the directory's signer wrapper with a tombstone, record the
 * retirement in TOMBSTONE.json, and MIRROR the record under the tombstones
 * root so it survives the directory's later deletion. Key files are not
 * touched. Idempotent — a re-run overwrites the tombstone with the same
 * content shape.
 *
 * Returns the tombstone info plus the MIRROR path (`recordPath`), so callers
 * can point at the record that outlives the directory.
 */
export async function writeAgentTombstone(
  input: WriteTombstoneInput,
): Promise<TombstoneInfo & { recordPath: string }> {
  // The directory must already exist: a mistyped path would otherwise be
  // silently created and reported as a successful retirement. (#1681 review)
  const dirStat = await stat(input.directory).catch(() => null)
  if (!dirStat?.isDirectory()) {
    // A ConnectError rather than a bare Error (#2175): this is the refusal an
    // automating caller actually hits, and the overwhelmingly likely cause is
    // a path built from the AGENT ID when the directory is slug-named (#1696).
    // A stable code lets that caller tell "wrong path" apart from every other
    // reason a retirement did not happen.
    throw new ConnectError(
      'tombstone_directory_not_found',
      `Not a directory: ${input.directory} — nothing to tombstone. ` +
        'Agent directories are named by their wiring SLUG when the agent has one, and by the ' +
        'agent id otherwise — so a path built from an agent id will not exist for a named agent. ' +
        'List ~/.haven/agents (or read the directories from --doctor --json) and pass one of those.',
      'retry_with_an_existing_agent_directory',
    )
  }
  const info: TombstoneInfo = {
    // reason / replaced_by are persisted to disk and re-emitted to the host's
    // MCP stderr log on EVERY stale probe, potentially for months — redact
    // like every other output path, at the write layer so any future caller
    // inherits it. (#1681 review, finding 1)
    agent_id: input.agentId,
    retired_at: input.retiredAt ?? new Date().toISOString(),
    reason: redactSecrets(input.reason),
    ...(input.replacedBy ? { replaced_by: redactSecrets(input.replacedBy) } : {}),
  }
  const binDir = join(input.directory, 'bin')
  await mkdir(binDir, { recursive: true })
  const wrapperPath = join(binDir, 'haven-signer.mjs')
  await writeFile(wrapperPath, tombstoneScript(info), 'utf8')
  await chmod(wrapperPath, 0o755)
  const record = JSON.stringify(info, null, 2) + '\n'
  await writeFile(join(input.directory, TOMBSTONE_FILENAME), record, 'utf8')
  // Surviving mirror (#1681 follow-up): keyed by agent id, OUTSIDE the dir, so
  // a retirement flow that then deletes the agent directory cannot silence
  // the diagnosis. Same redaction; no key material. Collisions (same agent id
  // tombstoned twice) overwrite — latest retirement wins, in-place records
  // remain authoritative.
  const root = input.tombstonesDir ?? defaultTombstonesDir()
  await mkdir(root, { recursive: true, mode: 0o700 })
  const recordPath = join(root, `${info.agent_id}.json`)
  await writeFile(recordPath, record, { mode: MIRROR_MODE })
  return { ...info, recordPath }
}

/** The tombstone record for a directory, or null when it is not tombstoned. */
export async function readAgentTombstone(directory: string): Promise<TombstoneInfo | null> {
  try {
    const parsed = JSON.parse(await readFile(join(directory, TOMBSTONE_FILENAME), 'utf8')) as TombstoneInfo
    if (typeof parsed?.agent_id !== 'string') return null
    return parsed
  } catch {
    return null
  }
}
