import { createHash } from 'node:crypto'
import { appendFile, lstat, mkdir, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { OWNER_ONLY_MODE, tightenIfFilePermissive, type PermissionLog } from './file-mode.js'
import type { SignerToolName } from './tools.js'

/**
 * #3172: the sidecar is bounded. When it reaches this size the current file is
 * renamed to `<path>.1` (replacing the previous `.1`) and a fresh file starts,
 * so at most two generations — the live file and one predecessor — ever exist.
 * 8 MiB is roughly 30 000 entries at the ~270-byte row size; nothing in the
 * signer reads the file back, so the bound protects the disk and the reader's
 * patience, never a signing decision.
 */
export const AUDIT_ROTATE_BYTES = 8 * 1024 * 1024

export interface AppendAuditOptions {
  /** Where permission notices go; defaults to stderr. */
  log?: PermissionLog
  /** Rotation threshold in bytes; exported default `AUDIT_ROTATE_BYTES`. */
  rotateAtBytes?: number
  platform?: NodeJS.Platform
}


export interface SigningAuditEntry {
  version: 1
  timestamp: string
  tool: SignerToolName
  payload_hash: string
  delegate_address: string
  /**
   * Serialized key kept as `safe_address` deliberately (#2914 review): this
   * is a persisted JSONL field, and an audit log written by an earlier
   * release never rewrites itself — renaming the key here would fork the
   * format mid-file. `SigningAuditContext.accountAddress` (the in-memory
   * field this is built from) carries the account-vocabulary name; only the
   * on-disk spelling stays put.
   */
  safe_address?: string
  chain_id?: number
}

export interface SigningAuditContext {
  delegateAddress: string
  accountAddress?: string
  chainId?: number
  auditPath?: string
}

export function defaultSigningAuditPath(credentialsPath?: string): string {
  if (credentialsPath) return resolve(`${credentialsPath}.signer-audit.jsonl`)
  return resolve(homedir(), '.haven', 'signer-audit.jsonl')
}

export async function appendSigningAuditEntry(
  entry: SigningAuditEntry,
  path: string,
  options: AppendAuditOptions = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const rotateAt = options.rotateAtBytes ?? AUDIT_ROTATE_BYTES
  const existing = await lstat(path).catch(() => null)
  if (existing) {
    // Tighten BEFORE rotating, on every append (the lstat above is the only
    // cost, and it is already paid): a pre-#3172 0644 sidecar is fixed in
    // place, and if it rotates next, `rename` carries 0600 into `.1` — the
    // history is never left world-readable. Idempotent, so the notice fires
    // once per permissive occurrence, not once per process (#3172 review).
    await tightenIfFilePermissive('audit sidecar', path, options.log, options.platform, existing)
    if (existing.size >= rotateAt) {
      // Rotate BEFORE appending so the live file never exceeds the bound by
      // more than one row. `rename` replaces the previous `.1` atomically, but
      // the decision to rotate is not: two signer PROCESSES at the bound can
      // both pass the size check, and the slower one may rename the faster
      // one's fresh live file over `.1`, discarding the predecessor
      // generation. The current entry is never lost (appendFile re-creates
      // the live file), only older history, and this is an advisory log —
      // so the loser's ENOENT is swallowed and a produced signature is never
      // thrown away over it. Two processes on one credential is the #1694
      // multi-agent shape; the loss needs one of them a full cycle behind.
      await rename(path, `${path}.1`).catch(() => {})
    }
  }
  // `mode` applies only when the file is created: a new sidecar is owner-only
  // from its first byte, like the credential it sits beside (#3172).
  await appendFile(path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: OWNER_ONLY_MODE })
}

export function createSigningAuditEntry(
  tool: SignerToolName,
  payloadHash: string,
  context: SigningAuditContext,
  now: Date = new Date(),
): SigningAuditEntry {
  const entry: SigningAuditEntry = {
    version: 1,
    timestamp: now.toISOString(),
    tool,
    payload_hash: payloadHash,
    delegate_address: context.delegateAddress,
  }
  if (context.accountAddress) entry.safe_address = context.accountAddress
  if (typeof context.chainId === 'number') entry.chain_id = context.chainId
  return entry
}

export function hashPayloadForAudit(payload: unknown): string {
  return `0x${createHash('sha256').update(stableStringify(payload)).digest('hex')}`
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const primitive = JSON.stringify(value)
    return primitive === undefined ? 'undefined' : primitive
  }
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(',')}}`
}
