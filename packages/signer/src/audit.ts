import { createHash } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import type { SignerToolName } from './tools.js'

export interface SigningAuditEntry {
  version: 1
  timestamp: string
  tool: SignerToolName
  payload_hash: string
  delegate_address: string
  safe_address?: string
  chain_id?: number
}

export interface SigningAuditContext {
  delegateAddress: string
  safeAddress?: string
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
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8')
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
  if (context.safeAddress) entry.safe_address = context.safeAddress
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
