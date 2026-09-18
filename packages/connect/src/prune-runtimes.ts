/**
 * #3123: reclaim signer-runtime directories nothing depends on.
 *
 * `~/.haven/signer-runtime/<key>/` is written once per pinned manifest
 * version — and, since #2424, once per `HAVEN_*_SPEC` override, under a
 * `directory_key` that is a hash of the resolved specs, so on a developer
 * machine the override-keyed directories are likely the bulk of the pile.
 * Nothing ever reclaimed them (`git grep -i prune` over the connector was
 * empty before this file).
 *
 * The rule is the safe one: a directory is KEPT when any credential
 * directory's `signer-runtime.json` names it as `runtime_directory` —
 * wired, superseded, retired, whatever its classification, because "a
 * directory nobody is using" is exactly what the doctor exists to decide,
 * not this — or when it is the manifest's current pin (what `--repair`
 * would install into). Everything else under the root is removed, or listed
 * under `--dry-run`. Enumeration walks the ROOT, never the manifest's version
 * list, so override-keyed directories are seen (S4).
 *
 * A running signer whose directory is removed: on POSIX the process keeps
 * its open files and keeps serving until it restarts; since only
 * UNREFERENCED directories are removed, no credential directory's wrapper
 * points at one, so no configured agent can be started against a removed
 * directory. On a platform where the removal fails (`EBUSY`), the entry is
 * reported `failed` and the exit code says so; nothing else is affected.
 *
 * Findings use #3121's three levels rather than a second scale: `removed` and
 * `kept` are `ok`, a `would_remove` under --dry-run is an `advisory`
 * (worth reading, nothing broken), a `failed` removal is `failed`.
 */
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MCP_RUNTIME_MANIFEST } from './runtime-manifest.js'
import type { DoctorLevel } from './doctor.js'

export interface PruneEntry {
  directory: string
  key: string
  kind: 'version' | 'override' | 'unknown'
  bytes: number
  /** The credential directories whose sidecar names this runtime (empty when unreferenced). */
  referencedBy: string[]
  action: 'kept' | 'removed' | 'would_remove' | 'failed'
  level: DoctorLevel
  detail: string
}

export interface PruneReport {
  version: 1
  root: string
  dryRun: boolean
  entries: PruneEntry[]
  removed: number
  reclaimedBytes: number
  level: DoctorLevel
}

export interface PruneDeps {
  homeDir?: string
  /** An explicit `--credentials-dir` names ONE agent directory; its siblings are its parent's (#1688 B2). */
  credentialsDir?: string
  rm?: (directory: string) => Promise<void>
}

export function signerRuntimeRoot(homeDir: string): string {
  return join(homeDir, '.haven', 'signer-runtime')
}

function classifyKey(key: string): PruneEntry['kind'] {
  if (key.startsWith('override-')) return 'override'
  if (key === MCP_RUNTIME_MANIFEST.signerVersion || /^\d+\.\d+\.\d+/.test(key)) return 'version'
  return 'unknown'
}

async function directoryBytes(directory: string): Promise<number> {
  let total = 0
  const walk = async (dir: string): Promise<void> => {
    let entries: import('node:fs').Dirent[] = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) {
        try {
          total += (await stat(path)).size
        } catch {
          // A file that vanished mid-walk counts nothing.
        }
      }
    }
  }
  await walk(directory)
  return total
}

/** Every `runtime_directory` any credential directory's sidecar names, keyed to the directories naming it. */
export async function referencedRuntimeDirectories(homeDir: string, credentialsDir?: string): Promise<Map<string, string[]>> {
  const root = credentialsDir ? join(credentialsDir, '..') : join(homeDir, '.haven', 'agents')
  const referenced = new Map<string, string[]>()
  let entries: string[] = []
  try {
    entries = await readdir(root)
  } catch {
    return referenced
  }
  for (const entry of entries) {
    const directory = join(root, entry)
    try {
      const sidecar = JSON.parse(await readFile(join(directory, 'signer-runtime.json'), 'utf8')) as { runtime_directory?: unknown }
      if (typeof sidecar.runtime_directory === 'string' && sidecar.runtime_directory.length > 0) {
        const list = referenced.get(sidecar.runtime_directory) ?? []
        list.push(directory)
        referenced.set(sidecar.runtime_directory, list)
      }
    } catch {
      // No sidecar, or unreadable: this directory references nothing.
    }
  }
  return referenced
}

export function rollUpPruneLevel(entries: ReadonlyArray<Pick<PruneEntry, 'level'>>): DoctorLevel {
  if (entries.some((e) => e.level === 'failed')) return 'failed'
  if (entries.some((e) => e.level === 'advisory')) return 'advisory'
  return 'ok'
}

/**
 * Enumerate the root and decide each directory. `dryRun` reports without
 * removing; otherwise unreferenced directories are removed one by one and a
 * removal that throws is reported `failed` rather than aborting the run.
 */
export async function pruneSignerRuntimes(input: { dryRun: boolean }, deps: PruneDeps = {}): Promise<PruneReport> {
  const homeDir = deps.homeDir ?? homedir()
  const root = signerRuntimeRoot(homeDir)
  const referenced = await referencedRuntimeDirectories(homeDir, deps.credentialsDir)
  const pin = join(root, MCP_RUNTIME_MANIFEST.signerVersion)
  const remove = deps.rm ?? (async (directory: string) => rm(directory, { recursive: true, force: false }))
  const entries: PruneEntry[] = []
  let keys: string[] = []
  try {
    keys = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  } catch {
    return { version: 1, root, dryRun: input.dryRun, entries, removed: 0, reclaimedBytes: 0, level: 'ok' }
  }
  let removed = 0
  let reclaimedBytes = 0
  for (const key of keys) {
    const directory = join(root, key)
    const bytes = await directoryBytes(directory)
    const referencedBy = referenced.get(directory) ?? []
    const kind = classifyKey(key)
    if (referencedBy.length > 0 || directory === pin) {
      entries.push({
        directory, key, kind, bytes, referencedBy,
        action: 'kept', level: 'ok',
        detail: referencedBy.length > 0
          ? `kept — named by ${referencedBy.length} credential director${referencedBy.length === 1 ? 'y' : 'ies'}`
          : 'kept — the connector\'s current pinned version (what --repair installs)',
      })
      continue
    }
    if (input.dryRun) {
      entries.push({
        directory, key, kind, bytes, referencedBy,
        action: 'would_remove', level: 'advisory',
        detail: `would remove — no credential directory names it (${kind}-keyed)`,
      })
      continue
    }
    try {
      await remove(directory)
      removed += 1
      reclaimedBytes += bytes
      entries.push({ directory, key, kind, bytes, referencedBy, action: 'removed', level: 'ok', detail: `removed — no credential directory named it (${kind}-keyed)` })
    } catch (err) {
      entries.push({
        directory, key, kind, bytes, referencedBy,
        action: 'failed', level: 'failed',
        detail: `removal failed: ${err instanceof Error ? err.message : String(err)} — a signer process may still hold it open; stop it and re-run`,
      })
    }
  }
  return { version: 1, root, dryRun: input.dryRun, entries, removed, reclaimedBytes, level: rollUpPruneLevel(entries) }
}
