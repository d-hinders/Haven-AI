import { readFile } from 'node:fs/promises'

export type HostedProbeStatus = 'ok' | 'unauthorized' | 'network_error' | 'bad_response'

export interface HostedProbeResult {
  status: HostedProbeStatus
  toolCount?: number
}

export async function probeHostedMcpTools(
  apiKey: string,
  hostedMcpUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HostedProbeResult> {
  let response: Response
  try {
    response = await fetchWithTimeout(fetchImpl, hostedMcpUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
  } catch {
    return { status: 'network_error' }
  }

  if (response.status === 401 || response.status === 403) return { status: 'unauthorized' }
  if (!response.ok) return { status: 'bad_response' }

  try {
    const payload = parseJsonRpcPayload(await response.text())
    if (!payload || payload.error) return { status: 'bad_response' }
    const tools = (payload.result as { tools?: unknown[] } | undefined)?.tools
    return { status: 'ok', toolCount: Array.isArray(tools) ? tools.length : undefined }
  } catch {
    return { status: 'bad_response' }
  }
}

export async function probeLocalSignerCredential(signerPath: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(signerPath, 'utf8')) as unknown
    return Boolean(
      parsed &&
        typeof parsed === 'object' &&
        'delegate_key' in parsed &&
        typeof (parsed as { delegate_key?: unknown }).delegate_key === 'string',
    )
  } catch {
    return false
  }
}

interface JsonRpcEnvelope {
  result?: unknown
  error?: unknown
}

function parseJsonRpcPayload(raw: string): JsonRpcEnvelope | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed) as JsonRpcEnvelope
    } catch {
      return null
    }
  }
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
  for (let i = dataLines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(dataLines[i]) as JsonRpcEnvelope
    } catch {
      /* try previous SSE frame */
    }
  }
  return null
}

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3000)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}
