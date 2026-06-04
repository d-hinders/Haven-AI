import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  computeConsentHash,
  consentInputFromClient,
  ensureConsent,
  loadCredentials,
  registeredToolNames,
  type ConsentDecision,
} from '@haven_ai/mcp'

export interface LocalMcpConsentStatus {
  acknowledged: boolean
  hash?: string
  reason?: ConsentDecision['reason'] | 'ack_file_missing' | 'ack_file_mismatch'
  error?: string
}

export async function acknowledgeLocalMcpConsent(
  identityPath: string,
  signerPath: string,
  log?: (message: string) => void,
): Promise<LocalMcpConsentStatus> {
  try {
    const input = await buildLocalMcpConsentInput(identityPath, signerPath)
    const decision = await ensureConsent(input, {
      credentialsPath: identityPath,
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

export async function getLocalMcpConsentStatus(
  identityPath: string,
  signerPath: string,
): Promise<LocalMcpConsentStatus> {
  try {
    const input = await buildLocalMcpConsentInput(identityPath, signerPath)
    const hash = computeConsentHash(input)
    const stored = await readLocalMcpAckFile(localMcpAckPath(identityPath))
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

export function localMcpAckPath(identityPath: string): string {
  return resolve(`${identityPath}.ack.json`)
}

async function buildLocalMcpConsentInput(identityPath: string, signerPath: string) {
  const credentials = await loadCredentials({ identityPath, signerPath })
  const unavailableDuringSetup = {
    getAllowances: async () => {
      throw new Error('Haven approval is not complete yet.')
    },
  }
  return consentInputFromClient(
    unavailableDuringSetup as never,
    {
      apiKey: credentials.apiKey,
      apiUrl: credentials.apiUrl,
      agentId: credentials.agentId,
      safeAddress: credentials.safeAddress,
      delegateAddress: credentials.delegateAddress,
      chainId: credentials.chainId,
      allowanceSummary: credentials.allowanceSummary,
    },
    registeredToolNames(),
  )
}

async function readLocalMcpAckFile(path: string): Promise<string | null> {
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
