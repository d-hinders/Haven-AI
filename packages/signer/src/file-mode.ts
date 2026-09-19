import { chmod, stat } from 'node:fs/promises'

/** Owner-only: the mode every file this package writes beside a credential gets. */
export const OWNER_ONLY_MODE = 0o600

export type PermissionLog = (message: string) => void

const defaultLog: PermissionLog = (message) => process.stderr.write(`${message}\n`)

/**
 * Is this file readable, writable or executable by anyone but its owner?
 * Returns null when the file cannot be stat'ed, or on Windows where POSIX mode
 * bits do not map cleanly (the same carve-out `@haven_ai/mcp` makes).
 */
export async function permissiveMode(
  path: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (platform === 'win32') return null
  let mode: number
  try {
    mode = (await stat(path)).mode
  } catch {
    return null
  }
  if ((mode & 0o077) === 0) return null
  return (mode & 0o777).toString(8).padStart(4, '0')
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
  const octal = await permissiveMode(path, platform)
  if (octal === null) return
  log(
    `haven-signer: warning: ${kind} at ${path} is readable beyond the owner ` +
      `(mode ${octal}). Run: chmod 600 ${path}`,
  )
}

/**
 * Tighten a file this signer WRITES to owner-only when it finds it
 * permissive (#3172): the audit sidecar was created 0644 by every release
 * before this one, so an existing sidecar is fixed in place rather than
 * warned about. Falls back to the warning when chmod is refused (a file owned
 * by another user). Returns what happened so a caller can log once.
 */
export async function tightenIfFilePermissive(
  kind: string,
  path: string,
  log: PermissionLog = defaultLog,
  platform: NodeJS.Platform = process.platform,
): Promise<'owner-only' | 'tightened' | 'warned' | 'skipped'> {
  const octal = await permissiveMode(path, platform)
  if (octal === null) return platform === 'win32' ? 'skipped' : 'owner-only'
  try {
    await chmod(path, OWNER_ONLY_MODE)
    log(
      `haven-signer: ${kind} at ${path} was readable beyond the owner (mode ${octal}); ` +
        `tightened to 0600.`,
    )
    return 'tightened'
  } catch {
    log(
      `haven-signer: warning: ${kind} at ${path} is readable beyond the owner ` +
        `(mode ${octal}) and could not be tightened. Run: chmod 600 ${path}`,
    )
    return 'warned'
  }
}
