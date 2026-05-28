import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { toolDescriptions, toolSchemas, type SignerToolName } from './tools.js'

export interface SignerConsentInput {
  delegateAddress: string
  safeAddress?: string
  agentId?: string
  chainId?: number
  network?: string
  toolNames: readonly SignerToolName[]
}

export interface SignerConsentDecision {
  ok: boolean
  hash: string
  reason:
    | 'env_var_match'
    | 'ack_file_match'
    | 'wrote_ack_file'
    | 'env_var_mismatch'
    | 'no_acknowledgement'
}

export interface SignerConsentOptions {
  credentialsPath?: string
  writeAck?: boolean
  env?: Record<string, string | undefined>
  out?: { write: (chunk: string) => unknown }
}

export const SIGNER_ACK_ENV = 'HAVEN_SIGNER_ACK'

export function computeSignerConsentHash(input: SignerConsentInput): string {
  const identity = [
    input.delegateAddress.toLowerCase(),
    (input.safeAddress ?? '').toLowerCase(),
    input.agentId ?? '',
    input.chainId ?? '',
    input.network ?? '',
  ].join('|')
  const toolCanonical = [...input.toolNames].sort().join(',')
  return createHash('sha256')
    .update(`${identity}\n${toolCanonical}`)
    .digest('hex')
    .slice(0, 16)
}

export function renderSignerConsentBlock(input: SignerConsentInput, hash: string): string {
  const lines: string[] = [
    '',
    '------------------------------------------------------------',
    'Haven edge signer - first-launch consent',
    '------------------------------------------------------------',
    '',
    `Delegate address: ${input.delegateAddress}`,
  ]
  lines.push(`Haven wallet:     ${input.safeAddress ?? 'not provided to this signer'}`)
  if (input.agentId) lines.push(`Agent ID:         ${input.agentId}`)
  if (typeof input.chainId === 'number') lines.push(`Chain ID:         ${input.chainId}`)
  if (input.network) lines.push(`Network:          ${input.network}`)
  lines.push('')
  lines.push('This local signer holds the delegate key on this machine and signs')
  lines.push('payment payloads or x402 merchant headers for the delegate address above.')
  lines.push('It does not call the Haven API, so it cannot show a live allowance summary.')
  lines.push('On-chain Safe rules remain the real spend gate, and the wallet owner can')
  lines.push('pause or revoke agent authority outside this signer.')
  lines.push('')
  lines.push('Tools this signer will expose to your agent runtime:')
  for (const name of input.toolNames) {
    lines.push(`  - ${name}`)
    lines.push(`      ${toolDescriptions[name]}`)
  }
  lines.push('')
  lines.push('A local audit entry is appended for every signing operation. Audit entries')
  lines.push('record timestamp, tool, payload hash, and delegate address; never the key,')
  lines.push('signature, or x402 payment header.')
  lines.push('')
  lines.push(`Consent hash: ${hash}`)
  lines.push('')
  lines.push('To acknowledge, EITHER:')
  lines.push(`  - set ${SIGNER_ACK_ENV}=${hash} in this process's environment, OR`)
  lines.push('  - re-run with --ack to write the acknowledgement next to your')
  lines.push('    credential file (sidecar <credentials>.signer-ack.json).')
  lines.push('')
  lines.push('------------------------------------------------------------')
  lines.push('')
  return lines.join('\n')
}

export async function ensureSignerConsent(
  input: SignerConsentInput,
  options: SignerConsentOptions = {},
): Promise<SignerConsentDecision> {
  const env = options.env ?? process.env
  const out = options.out ?? process.stderr
  const hash = computeSignerConsentHash(input)
  const envAck = env[SIGNER_ACK_ENV]

  if (typeof envAck === 'string' && envAck.length > 0) {
    if (envAck === hash) return { ok: true, hash, reason: 'env_var_match' }
    out.write(renderSignerConsentBlock(input, hash))
    out.write(
      `${SIGNER_ACK_ENV} was set but did not match the current signer consent hash.\n` +
        `Expected: ${hash}\n` +
        `Got:      ${envAck}\n` +
        `Re-acknowledge with the new hash above, or run with --ack.\n\n`,
    )
    return { ok: false, hash, reason: 'env_var_mismatch' }
  }

  const ackPath = sidecarPath(options.credentialsPath)
  if (ackPath) {
    const stored = await readAckFile(ackPath)
    if (stored?.ack === hash) return { ok: true, hash, reason: 'ack_file_match' }
  }

  if (options.writeAck && ackPath) {
    out.write(renderSignerConsentBlock(input, hash))
    await writeAckFile(ackPath, hash)
    out.write(`Wrote acknowledgement to ${ackPath}\n\n`)
    return { ok: true, hash, reason: 'wrote_ack_file' }
  }

  out.write(renderSignerConsentBlock(input, hash))
  return { ok: false, hash, reason: 'no_acknowledgement' }
}

export function registeredSignerToolNames(): SignerToolName[] {
  return Object.keys(toolSchemas) as SignerToolName[]
}

function sidecarPath(credentialsPath?: string): string | null {
  if (!credentialsPath) return null
  return resolve(`${credentialsPath}.signer-ack.json`)
}

async function readAckFile(path: string): Promise<{ ack?: string } | null> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as { ack?: unknown }
    return { ack: typeof parsed.ack === 'string' ? parsed.ack : undefined }
  } catch {
    return null
  }
}

async function writeAckFile(path: string, hash: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    JSON.stringify({ ack: hash, at: new Date().toISOString() }, null, 2),
    'utf8',
  )
}
