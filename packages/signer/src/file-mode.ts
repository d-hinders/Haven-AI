import type { Stats } from 'node:fs'
import { chmod, lstat } from 'node:fs/promises'
import {
  permissiveMode,
  warnIfFilePermissiveWithPrefix,
  type PermissionLog,
} from '@haven_ai/sdk/edge'

/**
 * The signer's file-permission helpers.
 *
 * #4792 moved the permission CORE — `permissiveMode` and the prefix-taking
 * warning — into `@haven_ai/sdk/edge` (`credential-file.ts`), because the local
 * MCP carried a second copy of it. This file keeps the signer's own surface:
 * `OWNER_ONLY_MODE` (the mode every file this package writes beside a
 * credential gets), `warnIfFilePermissive` with its `haven-signer:` prefix and
 * unchanged signature, and `tightenIfFilePermissive`, whose one caller is
 * `packages/signer/src/audit.ts` and which is deliberately NOT shared — giving
 * the local MCP the signer's tightening behaviour is a behaviour change that
 * needs its own issue.
 *
 * `permissiveMode`, `PermissionLog` and `PermissiveFile` are re-exported so
 * `packages/signer/src/index.ts` keeps every name and signature it exported
 * before the move.
 */
export { permissiveMode, type PermissiveFile, type PermissionLog } from '@haven_ai/sdk/edge'

/** Owner-only: the mode every file this package writes beside a credential gets. */
export const OWNER_ONLY_MODE = 0o600

const defaultLog: PermissionLog = (message) => process.stderr.write(`${message}\n`)

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
  await warnIfFilePermissiveWithPrefix('haven-signer', kind, path, log, platform, 'follow')
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
  if (platform === 'win32') return 'skipped'
  let info: Stats | null = stats ?? null
  if (!info) {
    try {
      info = await lstat(path)
    } catch {
      return 'owner-only'
    }
  }
  if (!info.isFile()) {
    // A symlink (or device, or directory) at the sidecar path: chmod would
    // follow it to whatever it points at, and `appendFile` already writes
    // the audit rows through it. Judged BEFORE the mode — a link's own mode
    // bits mean nothing and vary with umask (0755 under 022, 0700 under 077),
    // so they neither gate this warning nor appear in it. The remedy is to
    // remove the link, not to chmod its target.
    log(
      `haven-signer: warning: ${kind} at ${path} is not a regular file (a symlink or similar); ` +
        `audit rows are being written through it and it was not tightened. Remove it: rm ${path}`,
    )
    return 'warned'
  }
  const found = await permissiveMode(path, platform, info)
  if (found === null) return 'owner-only'
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
