import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  computeSignerConsentHash,
  createEdgeSigner,
  ensureSignerConsent,
  loadSignerCredentials,
  toolSchemas,
  type SignerConsentDecision,
  type SignerConsentInput,
  type SignerToolName,
} from '@haven_ai/signer'

export interface LocalSignerConsentStatus {
  acknowledged: boolean
  hash?: string
  reason?: SignerConsentDecision['reason'] | 'ack_file_missing' | 'ack_file_mismatch'
  error?: string
}

export async function acknowledgeLocalSignerConsent(
  signerPath: string,
  log?: (message: string) => void,
): Promise<LocalSignerConsentStatus> {
  try {
    const input = await buildSignerConsentInput(signerPath)
    const decision = await ensureSignerConsent(input, {
      credentialsPath: signerPath,
      writeAck: true,
      out: log ? { write: (chunk) => writeLogChunk(log, chunk) } : undefined,
    })
    return {
      acknowledged: decision.ok,
      hash: decision.hash,
      reason: decision.reason,
    }
  } catch (err) {
    return {
      acknowledged: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function getLocalSignerConsentStatus(signerPath: string): Promise<LocalSignerConsentStatus> {
  try {
    const input = await buildSignerConsentInput(signerPath)
    const hash = computeSignerConsentHash(input)
    const stored = await readSignerAckFile(signerAckPath(signerPath))
    if (stored === hash) {
      return { acknowledged: true, hash, reason: 'ack_file_match' }
    }
    return {
      acknowledged: false,
      hash,
      reason: stored ? 'ack_file_mismatch' : 'ack_file_missing',
    }
  } catch (err) {
    return {
      acknowledged: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export function signerAckPath(signerPath: string): string {
  return resolve(`${signerPath}.signer-ack.json`)
}

async function buildSignerConsentInput(signerPath: string): Promise<SignerConsentInput> {
  const credentials = await loadSignerCredentials(signerPath)
  const signer = createEdgeSigner(credentials.delegateKey, {
    x402BindingSigner: credentials.x402BindingSigner,
  })
  return {
    delegateAddress: signer.delegateAddress,
    safeAddress: credentials.safeAddress,
    agentId: credentials.agentId,
    chainId: credentials.chainId,
    network: credentials.network,
    toolNames: Object.keys(toolSchemas) as SignerToolName[],
  }
}

async function readSignerAckFile(path: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { ack?: unknown }
    return typeof parsed.ack === 'string' ? parsed.ack : null
  } catch {
    return null
  }
}

function writeLogChunk(log: (message: string) => void, chunk: string): void {
  const message = String(chunk).trimEnd()
  if (message) log(message)
}
