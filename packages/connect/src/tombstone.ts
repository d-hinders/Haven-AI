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

import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { redactSecrets } from './redact.js'

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
    'Then verify with: npx @haven_ai/connect@alpha --doctor --runtime <runtime>',
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
 * Replace the directory's signer wrapper with a tombstone and record the
 * retirement in TOMBSTONE.json. Key files are not touched. Idempotent — a
 * re-run overwrites the tombstone with the same content shape.
 */
export async function writeAgentTombstone(input: WriteTombstoneInput): Promise<TombstoneInfo> {
  // The directory must already exist: a mistyped path would otherwise be
  // silently created and reported as a successful retirement. (#1681 review)
  const dirStat = await stat(input.directory).catch(() => null)
  if (!dirStat?.isDirectory()) {
    throw new Error(`Not a directory: ${input.directory} — nothing to tombstone.`)
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
  await writeFile(join(input.directory, TOMBSTONE_FILENAME), JSON.stringify(info, null, 2) + '\n', 'utf8')
  return info
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
