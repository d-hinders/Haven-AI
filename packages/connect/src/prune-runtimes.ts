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
 * directory names it — through its `signer-runtime.json` `runtime_directory`
 * OR through the path its `bin/haven-signer.mjs` wrapper launches (a
 * directory with a missing or corrupt sidecar but an intact wrapper still
 * depends on its runtime; #3151 review) — wired, superseded, retired,
 * whatever its classification, because "a directory nobody is using" is
 * exactly what the doctor exists to decide, not this — or when it is the
 * manifest's current pin (what `--repair` would install into). Credential
 * directories are read from the default root AND, when `--credentials-dir`
 * names an agent elsewhere, from that directory's parent as well — a union,
 * never either/or, so pointing the prune at one agent cannot blind it to the
 * others (#3151 review). Paths are normalized (resolved, realpath where the
 * directory exists, no trailing slash) on both sides of the comparison.
 * Everything else under the root is removed, or listed under `--dry-run`.
 * Enumeration walks the ROOT, never the manifest's version list, so
 * override-keyed directories are seen (S4).
 *
 * The prune trusts those two reference sources; it does not read runtime
 * configs. A running signer whose directory is removed: on POSIX the process
 * keeps its open files and keeps serving until it restarts; a removed
 * directory is one no sidecar and no wrapper named, so a configured agent is
 * not started against it. On a platform where the removal fails (`EBUSY`),
 * the entry is reported `failed` and the exit code says so; nothing else is
 * affected.
 *
 * Sizes: `directoryBytes` walks every file (287k files / 1.2 GB on one
 * developer machine — tens of seconds warm, ~18 minutes cold in the #3151
 * review's sandbox; the number is the reviewer's, not a contract), so it
 * runs only for the directories the run would remove, and only when the
 * caller asks (`measure: true`, the CLI). The doctor's dry run passes
 * `measure: false` and reports names only.
 *
 * Findings use #3121's three levels rather than a second scale: `removed` and
 * `kept` are `ok`, a `would_remove` under --dry-run is an `advisory`
 * (worth reading, nothing broken), a `failed` removal is `failed`.
 */
import { readdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { MCP_RUNTIME_MANIFEST } from './runtime-manifest.js'
import type { DoctorLevel } from './doctor.js'

export interface PruneEntry {
  directory: string
  key: string
  kind: 'version' | 'override' | 'unknown'
  /** Size in bytes — `0` for every kept entry and for any `measure: false` run: sizing runs only for directories the run would remove. */
  bytes: number
  /** The credential directories whose sidecar or wrapper names this runtime (empty when unreferenced). */
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

/** Resolve, strip trailing separators, and follow symlinks when the path exists — so both sides compare alike. */
export async function normalizeRuntimePath(path: string): Promise<string> {
  const resolved = resolve(path).replace(/[\\/]+$/, '')
  try {
    return await realpath(resolved)
  } catch {
    return resolved
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Every runtime directory any credential directory names — through its
 * sidecar's `runtime_directory` or the path its wrapper launches — keyed by
 * the normalized directory, valued by the credential directories naming it.
 * Reads the default root AND the explicit directory's parent (a union).
 */
export async function referencedRuntimeDirectories(homeDir: string, credentialsDir?: string): Promise<Map<string, string[]>> {
  const roots = new Set<string>([join(homeDir, '.haven', 'agents')])
  if (credentialsDir) roots.add(dirname(resolve(credentialsDir)))
  const referenced = new Map<string, string[]>()
  const runtimeRoot = await normalizeRuntimePath(signerRuntimeRoot(homeDir))
  // A wrapper may spell the root as written at install time (before symlink
  // resolution — macOS's /var vs /private/var) or as its realpath; match both.
  const rootSpellings = [...new Set([resolve(signerRuntimeRoot(homeDir)), runtimeRoot])]
  const wrapperRe = new RegExp(`(?:${rootSpellings.map(escapeRegExp).join('|')})[\\/]+([^\\/'"\\s]+)`, 'g')
  const add = async (runtimeDirectory: string, by: string) => {
    const key = await normalizeRuntimePath(runtimeDirectory)
    const list = referenced.get(key) ?? []
    if (!list.includes(by)) list.push(by)
    referenced.set(key, list)
  }
  for (const root of roots) {
    let entries: string[] = []
    try {
      entries = await readdir(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      const directory = join(root, entry)
      try {
        const sidecar = JSON.parse(await readFile(join(directory, 'signer-runtime.json'), 'utf8')) as { runtime_directory?: unknown }
        if (typeof sidecar.runtime_directory === 'string' && sidecar.runtime_directory.length > 0) {
          await add(sidecar.runtime_directory, directory)
        }
      } catch {
        // No sidecar, or unreadable: the wrapper below is the second source.
      }
      try {
        const wrapper = await readFile(join(directory, 'bin', 'haven-signer.mjs'), 'utf8')
        // The wrapper launches `<runtime root>/<key>/node_modules/...`; every
        // root child it names is a reference, whatever the sidecar says.
        for (const match of wrapper.matchAll(wrapperRe)) await add(join(runtimeRoot, match[1]), directory)
      } catch {
        // No wrapper: nothing more to learn from this directory.
      }
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
export async function pruneSignerRuntimes(input: { dryRun: boolean; measure?: boolean }, deps: PruneDeps = {}): Promise<PruneReport> {
  const homeDir = deps.homeDir ?? homedir()
  const root = signerRuntimeRoot(homeDir)
  const measure = input.measure ?? true
  const referenced = await referencedRuntimeDirectories(homeDir, deps.credentialsDir)
  const pin = await normalizeRuntimePath(join(root, MCP_RUNTIME_MANIFEST.signerVersion))
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
    const normalized = await normalizeRuntimePath(directory)
    const referencedBy = referenced.get(normalized) ?? []
    const kind = classifyKey(key)
    if (referencedBy.length > 0 || normalized === pin) {
      entries.push({
        directory, key, kind, bytes: 0, referencedBy,
        action: 'kept', level: 'ok',
        detail: referencedBy.length > 0
          ? `kept — named by ${referencedBy.length} credential director${referencedBy.length === 1 ? 'y' : 'ies'} (sidecar or wrapper)`
          : 'kept — the connector\'s current pinned version (what --repair installs)',
      })
      continue
    }
    // Sized only here — a directory the run would remove — and only when asked.
    const bytes = measure ? await directoryBytes(directory) : 0
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
