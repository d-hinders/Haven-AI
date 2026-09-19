import type { Stats } from 'node:fs'
import { chmod, lstat } from 'node:fs/promises'

/** Owner-only: the mode every file this package writes beside a credential gets. */
export const OWNER_ONLY_MODE = 0o600

export type PermissionLog = (message: string) => void

const defaultLog: PermissionLog = (message) => process.stderr.write(`${message}\n`)

export interface PermissiveFile {
  /** The offending mode, e.g. `0644`. */
  octal: string
  /** False for a symlink, directory or device at that path — never chmod those. */
  regular: boolean
}

/**
 * Is this path readable, writable or executable by anyone but its owner?
 * `lstat`, not `stat`: a symlink planted at the path must be judged as the
 * link, never as whatever it points at (#3172 review). Returns null when the
 * path cannot be stat'ed or is owner-only, and on Windows where POSIX mode
 * bits do not map cleanly (the same carve-out `@haven_ai/mcp` makes). Pass
 * `stats` to reuse an lstat the caller already took.
 */
export async function permissiveMode(
  path: string,
  platform: NodeJS.Platform = process.platform,
  stats?: Stats,
): Promise<PermissiveFile | null> {
  if (platform === 'win32') return null
  let info: Stats
  try {
    info = stats ?? (await lstat(path))
  } catch {
    return null
  }
  if ((info.mode & 0o077) === 0) return null
  return { octal: (info.mode & 0o777).toString(8).padStart(4, '0'), regular: info.isFile() }
}

/**
 * Warn (best-effort, POSIX only) when a file this signer READS is readable
 * beyond its owner. The signer does not own the credential, so it tells the
 * operator what to run rather than changing a file it was handed.
 */
export async function warnIfFilePermissive(
  kind: string,
  path: string,
  log: PermissionLog = defaultLog,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const found = await permissiveMode(path, platform)
  if (found === null) return
  log(
    `haven-signer: warning: ${kind} at ${path} is readable beyond the owner ` +
      `(mode ${found.octal}). Run: chmod 600 ${path}`,
  )
}

export type TightenOutcome = 'owner-only' | 'tightened' | 'warned' | 'skipped'

/**
 * Tighten a file this signer WRITES to owner-only when it finds it
 * permissive (#3172): the audit sidecar was created 0644 by every release
 * before this one, so an existing sidecar is fixed in place rather than
 * warned about. Falls back to the warning when the path is not a regular
 * file (a symlink would make chmod hit whatever it points at) or when chmod
 * is refused (a file owned by another user). `skipped` covers Windows, an
 * absent path and an owner-only file alike — nothing to do.
 */
export async function tightenIfFilePermissive(
  kind: string,
  path: string,
  log: PermissionLog = defaultLog,
  platform: NodeJS.Platform = process.platform,
  stats?: Stats,
): Promise<TightenOutcome> {
  const found = await permissiveMode(path, platform, stats)
  if (found === null) return platform === 'win32' || !stats ? 'skipped' : 'owner-only'
  if (found.regular) {
    try {
      await chmod(path, OWNER_ONLY_MODE)
      log(
        `haven-signer: ${kind} at ${path} was readable beyond the owner (mode ${found.octal}); ` +
          `tightened to 0600.`,
      )
      return 'tightened'
    } catch {
      // fall through to the warning
    }
  }
  log(
    `haven-signer: warning: ${kind} at ${path} is readable beyond the owner ` +
      `(mode ${found.octal}) and was not tightened` +
      `${found.regular ? '' : ' (not a regular file)'}. Run: chmod 600 ${path}`,
  )
  return 'warned'
}
