import type { Stats } from 'node:fs'
import { chmod, lstat, stat } from 'node:fs/promises'

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
 * Returns null when the path cannot be stat'ed or is owner-only, and on
 * Windows where POSIX mode bits do not map cleanly (the same carve-out
 * `@haven_ai/mcp` makes). Pass `stats` to reuse a stat the caller took
 * IMMEDIATELY before — with `stats` the path is not touched, so a cached
 * `Stats` would be trusted over the disk. `follow` decides what a symlink at the path means: a file the signer
 * only READS (the credential) is judged by its target, which is what the
 * content protection is about and what the pre-#3172 `stat` did; a file the
 * signer is about to CHMOD (the audit sidecar) is judged as the link, so a
 * planted symlink is never chmod-ed through (#3172 review).
 */
export async function permissiveMode(
  path: string,
  platform: NodeJS.Platform = process.platform,
  stats?: Stats,
  follow: 'follow' | 'nofollow' = 'nofollow',
): Promise<PermissiveFile | null> {
  if (platform === 'win32') return null
  let info: Stats
  try {
    info = stats ?? (follow === 'follow' ? await stat(path) : await lstat(path))
  } catch {
    return null
  }
  if ((info.mode & 0o077) === 0) return null
  return { octal: (info.mode & 0o777).toString(8).padStart(4, '0'), regular: info.isFile() }
}

/**
 * Warn (best-effort, POSIX only) when a file this signer READS is readable
 * beyond its owner. The signer does not own the credential, so it tells the
 * operator what to run rather than changing a file it was handed. Follows a
 * symlink, as the pre-#3172 `stat` did: a link to a 0600 credential is fine.
 */
export async function warnIfFilePermissive(
  kind: string,
  path: string,
  log: PermissionLog = defaultLog,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const found = await permissiveMode(path, platform, undefined, 'follow')
  if (found === null) return
  log(
    `haven-signer: warning: ${kind} at ${path} is readable beyond the owner ` +
      `(mode ${found.octal}). Run: chmod 600 ${path}`,
  )
}

export type TightenOutcome = 'owner-only' | 'tightened' | 'warned' | 'skipped'

/**
 * Tighten a file this signer WRITES to owner-only when it finds it
 * permissive (#3172): the audit sidecar was created with the default mode
 * (0644 under the usual umask 022) by every release before this one, so an
 * existing sidecar is fixed in place rather than warned about. Judged with
 * `lstat`. Falls back to the warning when the path is not a regular file (a
 * symlink would make chmod hit whatever it points at) or when chmod is
 * refused (a file owned by another user). Outcomes: `tightened` / `warned`
 * as above; `owner-only` when there is nothing to tighten (owner-only file,
 * or no file at that path); `skipped` on Windows only.
 */
export async function tightenIfFilePermissive(
  kind: string,
  path: string,
  log: PermissionLog = defaultLog,
  platform: NodeJS.Platform = process.platform,
  stats?: Stats,
): Promise<TightenOutcome> {
  const found = await permissiveMode(path, platform, stats)
  if (found === null) return platform === 'win32' ? 'skipped' : 'owner-only'
  if (!found.regular) {
    // A symlink (or device, or directory) at the sidecar path: chmod would
    // follow it to whatever it points at, and `appendFile` already writes
    // the audit rows through it. The remedy is to remove the link, not to
    // chmod its target — and the link's own mode bits mean nothing, so they
    // are not printed.
    log(
      `haven-signer: warning: ${kind} at ${path} is not a regular file (a symlink or similar); ` +
        `audit rows are being written through it and it was not tightened. Remove it: rm ${path}`,
    )
    return 'warned'
  }
  {
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
      `(mode ${found.octal}) and could not be tightened. Run: chmod 600 ${path}`,
  )
  return 'warned'
}
