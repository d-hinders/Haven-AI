import { readFile } from 'node:fs/promises'

export interface HavenCredentialFile {
  apiKey: string
  delegateKey: string
  agentId?: string
  safeAddress?: string
  apiUrl?: string
}

interface RawCredentialFile {
  api_key?: unknown
  apiKey?: unknown
  delegate_key?: unknown
  delegateKey?: unknown
  agent_id?: unknown
  agentId?: unknown
  safe_address?: unknown
  safeAddress?: unknown
  api_url?: unknown
  apiUrl?: unknown
}

export async function loadCredentials(path = process.env.HAVEN_CREDENTIALS): Promise<HavenCredentialFile> {
  if (!path) {
    throw new Error('HAVEN_CREDENTIALS must point to a Haven agent credential JSON file.')
  }

  let rawText: string
  try {
    rawText = await readFile(path, 'utf8')
  } catch (err) {
    throw new Error(`Could not read Haven credentials at ${path}: ${err instanceof Error ? err.message : String(err)}`)
  }

  let raw: RawCredentialFile
  try {
    raw = JSON.parse(rawText) as RawCredentialFile
  } catch {
    throw new Error('Haven credentials must be JSON with api_key and delegate_key fields.')
  }

  const apiKey = stringField(raw.api_key ?? raw.apiKey)
  const delegateKey = stringField(raw.delegate_key ?? raw.delegateKey)

  if (!apiKey) {
    throw new Error('Haven credentials are missing api_key.')
  }
  if (!delegateKey) {
    throw new Error('Haven MCP requires delegate_key so payments can be signed locally.')
  }

  return {
    apiKey,
    delegateKey,
    agentId: stringField(raw.agent_id ?? raw.agentId),
    safeAddress: stringField(raw.safe_address ?? raw.safeAddress),
    apiUrl: stringField(raw.api_url ?? raw.apiUrl),
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}
