import { createHash } from 'node:crypto'
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
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

/** Paths whose mode this process has already checked — one notice per file per process. */
const modeChecked = new Set<string>()

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
  const existing = await stat(path).catch(() => null)
  if (existing && existing.size >= rotateAt) {
    // Rotate BEFORE appending so the live file never exceeds the bound by
    // more than one row. `rename` replaces the previous `.1` atomically.
    await rename(path, `${path}.1`)
  }
  // `mode` applies only when the file is created: a new sidecar is owner-only
  // from its first byte, like the credential it sits beside (#3172). An
  // existing permissive sidecar keeps its bits here and is tightened below.
  await appendFile(path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: OWNER_ONLY_MODE })
  if (!modeChecked.has(path)) {
    modeChecked.add(path)
    await tightenIfFilePermissive('audit sidecar', path, options.log, options.platform)
  }
}

/** Test seam: forget which sidecars this process has already mode-checked. */
export function resetAuditModeChecks(): void {
  modeChecked.clear()
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
