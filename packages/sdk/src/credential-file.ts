import type { Stats } from 'node:fs'
import { lstat, stat } from 'node:fs/promises'

/**
 * The delegate-key credential file's shared handling (#4792).
 *
 * Two published packages read the agent's credential file, which holds the
 * delegate private key: the local MCP (`@haven_ai/mcp`) and the edge signer
 * (`@haven_ai/signer`). Part of that code was the same code written twice —
 * about half of the signer's `credentials.ts` matched the local MCP's line for
 * line. No defect was claimed: the two permission checks behaved identically.
 * The risk was that the next hardening of key-file handling would land in one
 * package and not the other.
 *
 * What lives here is exactly the common part:
 *
 *   - `stringField`, `readAccountAddressField`, `readAccountAddressEnv` and the
 *     raw `account_address | safe_address | safeAddress` shape they read;
 *   - the permission core, `permissiveMode`, and a prefix-taking form of the
 *     warning, `warnIfFilePermissiveWithPrefix`.
 *
 * What stays in each package: its loader and result type, its `chain_id`
 * parsing (the two differ on purpose-or-not and #4792 does not decide which is
 * right), its own read / JSON / missing-field error text, and the signer's
 * `tightenIfFilePermissive` (whose one caller is `packages/signer/src/audit.ts`).
 *
 * Behaviour is unchanged in both packages, including the exact warning text and
 * the symlink trap: `permissiveMode` defaults to `'nofollow'`, while both
 * credential checks follow links today, so both wrappers pass `'follow'`.
 *
 * This module is on the money-path perimeter: it is how the key is read. It is
 * exported from `@haven_ai/sdk/edge` only — the barrel does not re-export the
 * edge entry — and it stays ethers-free (`edge-imports.test.ts`).
 */

/**
 * The raw credential-file fields the account address may arrive under.
 *
 * `account_address` is what `@haven_ai/connect` writes from #2908 on; the two
 * older spellings are read PERMANENTLY (see `readAccountAddressField`).
 */
export interface RawAccountAddressFields {
  /** What `@haven_ai/connect` writes from #2908 on. */
  account_address?: unknown
  /** Pre-#2908 spelling — read PERMANENTLY, see `readAccountAddressField`. */
  safe_address?: unknown
  /** Pre-#2908 spelling — read PERMANENTLY, see `readAccountAddressField`. */
  safeAddress?: unknown
}

/** A trimmed non-empty string, or `undefined` for anything else. */
export function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * The account address off a credential FILE: `account_address` (what
 * `@haven_ai/connect` writes from #2908 on) first, then the two pre-#2908
 * spellings.
 *
 * The two old fallbacks are PERMANENT, not part of the one-release naming
 * window (#2906, decision 2a): a credential file on disk was written once and
 * never rewrites itself, so a runtime that stopped reading `safe_address`
 * would silently lose the address for every agent connected before this
 * release — the consent hash would change and the spend-context prompt would
 * say "not provided". Two lines, kept for as long as the file format exists.
 *
 * Exported for the mutation tests: dropping `account_address` fails the
 * new-shape test, dropping either old key fails the old-shape test.
 */
export function readAccountAddressField(raw: RawAccountAddressFields): string | undefined {
  return stringField(raw.account_address ?? raw.safe_address ?? raw.safeAddress)
}

/**
 * The account address off the process environment: `HAVEN_ACCOUNT_ADDRESS`
 * (the survivor, decided on #2906). The two names the dashboard handoff
 * emitted before #2908 — `HAVEN_WALLET_ADDRESS` and `HAVEN_SAFE_ADDRESS` —
 * were window-scoped (unlike the credential-FILE fallbacks) and are retired
 * as of #2914.
 */
export function readAccountAddressEnv(env: NodeJS.ProcessEnv): string | undefined {
  const current = stringField(env.HAVEN_ACCOUNT_ADDRESS)

  // Retired, but REFUSED rather than ignored — the same rule the backend
  // applies to retired request names, for the same reason and with more at
  // stake. Silently dropping these would not merely leave the address unset:
  // `accountAddress` is what `haven_sign_sweep_delegate` passes as
  // `expectedSafe`, and an undefined `expectedSafe` SKIPS the check that a
  // sweep's `to` matches the account in the local credential (see
  // `core.ts`). An operator who upgrades without touching env would lose a
  // money-path cross-check and get no signal at all.
  //
  // The verdict keys on RELIANCE, not presence, so a handoff that still
  // exports both names alongside the new one keeps working:
  //   retired alone      -> throw
  //   both, same value   -> accept the new one
  //   both, disagreeing  -> throw
  for (const name of ['HAVEN_WALLET_ADDRESS', 'HAVEN_SAFE_ADDRESS'] as const) {
    const retired = stringField(env[name])
    if (!retired) continue
    if (!current) {
      throw new Error(
        `${name} is retired (#2906) — Haven accounts are addressed as accounts, not Safes. ` +
          'Set HAVEN_ACCOUNT_ADDRESS to the same value. Refusing rather than ignoring it, ' +
          'because an unset account address silently skips the sweep-destination check.',
      )
    }
    if (retired.toLowerCase() !== current.toLowerCase()) {
      throw new Error(
        `${name} and HAVEN_ACCOUNT_ADDRESS were both set to different addresses. ` +
          'Remove the retired name, or make them match — picking one silently would hide ' +
          'the mismatch.',
      )
    }
  }

  return current
}

export type PermissionLog = (message: string) => void

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
 * `Stats` would be trusted over the disk. `follow` decides what a symlink at
 * the path means: a file the signer only READS (the credential) is judged by
 * its target, which is what the content protection is about and what the
 * pre-#3172 `stat` did; a file the signer is about to CHMOD (the audit
 * sidecar) is judged as the link, so a planted symlink is never chmod-ed
 * through (#3172 review).
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
 * Warn (best-effort, POSIX only) when a file a package READS is readable
 * beyond its owner. The package does not own the credential, so it tells the
 * operator what to run rather than changing a file it was handed.
 *
 * `prefix` is the package's own log prefix (`haven-mcp`, `haven-signer`), so
 * the message each package emits is byte-identical to the one it emitted
 * before #4792. `follow` is REQUIRED rather than defaulted: both credential
 * checks follow a symlink today (a link to a 0600 credential is fine), and a
 * caller that is about to chmod the path must pass `'nofollow'` instead — the
 * trap #3172 review found. Making it explicit keeps that decision at the call
 * site instead of in a default nobody reads.
 */
export async function warnIfFilePermissiveWithPrefix(
  prefix: string,
  kind: string,
  path: string,
  log: PermissionLog,
  platform: NodeJS.Platform,
  follow: 'follow' | 'nofollow',
): Promise<void> {
  const found = await permissiveMode(path, platform, undefined, follow)
  if (found === null) return
  log(
    `${prefix}: warning: ${kind} at ${path} is readable beyond the owner ` +
      `(mode ${found.octal}). Run: chmod 600 ${path}`,
  )
}
