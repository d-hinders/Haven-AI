import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'

export type HostedProbeStatus = 'ok' | 'unauthorized' | 'network_error' | 'bad_response'

export interface HostedProbeResult {
  status: HostedProbeStatus
  toolCount?: number
}

export type LocalMcpProbeStatus = 'ok' | 'timeout' | 'process_error' | 'bad_response' | 'missing_tools'

export interface LocalMcpProbeResult {
  status: LocalMcpProbeStatus
  toolNames?: string[]
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

export async function probeLocalMcpTools(
  command: string,
  args: string[],
  requiredTools: readonly string[],
  timeoutMs = 10_000,
): Promise<LocalMcpProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] })
    let stdout = ''
    let settled = false
    let sawInitialize = false

    const finish = (result: LocalMcpProbeResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      child.kill()
      resolve(result)
    }

    const timeout = setTimeout(() => finish({ status: 'timeout' }), timeoutMs)

    child.on('error', () => finish({ status: 'process_error' }))
    child.on('exit', (code) => {
      if (!settled && code !== 0) finish({ status: 'process_error' })
    })
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      const lines = stdout.split(/\r?\n/)
      stdout = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let payload: JsonRpcEnvelope & { id?: number }
        try {
          payload = JSON.parse(trimmed) as JsonRpcEnvelope & { id?: number }
        } catch {
          continue
        }
        if (payload.error) {
          finish({ status: 'bad_response' })
          return
        }
        if (payload.id === 1 && !sawInitialize) {
          sawInitialize = true
          writeJsonRpc(child, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
          writeJsonRpc(child, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
          continue
        }
        if (payload.id === 2) {
          const tools = (payload.result as { tools?: unknown[] } | undefined)?.tools
          const toolNames = Array.isArray(tools)
            ? tools
                .map((tool) => tool && typeof tool === 'object' && 'name' in tool ? (tool as { name?: unknown }).name : undefined)
                .filter((name): name is string => typeof name === 'string')
            : []
          const missing = requiredTools.filter((name) => !toolNames.includes(name))
          finish({ status: missing.length === 0 ? 'ok' : 'missing_tools', toolNames })
          return
        }
      }
    })

    writeJsonRpc(child, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'haven-connect-probe', version: '0.0.0' },
      },
    })
  })
}

interface JsonRpcEnvelope {
  result?: unknown
  error?: unknown
}

function writeJsonRpc(child: ReturnType<typeof spawn>, payload: Record<string, unknown>): void {
  child.stdin?.write(`${JSON.stringify(payload)}\n`)
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
