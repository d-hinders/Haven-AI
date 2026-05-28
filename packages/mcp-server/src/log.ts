/**
 * Structured access logging for the hosted MCP server.
 *
 * One JSON line per request, Railway-friendly:
 *
 *   {"ts":"…","method":"POST","path":"/v1","status":200,"ms":42,"tool":"haven_pay"}
 *
 * Never logs the Authorization header, the api key, or the request/response
 * body — only metadata derived from the JSON-RPC envelope (the MCP tool name,
 * when present).
 */

export interface AccessLogEntry {
  ts: string
  method: string
  path: string
  status: number
  ms: number
  /** MCP tool name from the JSON-RPC body when this is a tools/call request. */
  tool?: string
}

export type AccessLogWriter = (entry: AccessLogEntry) => void

/** One-line JSON to stdout — what Railway, Loki, and friends ingest cleanly. */
export const defaultAccessLogWriter: AccessLogWriter = (entry) => {
  process.stdout.write(JSON.stringify(entry) + '\n')
}

/**
 * Pull the MCP tool name out of a parsed JSON-RPC body, if this is a
 * `tools/call` request. Returns `undefined` for anything else — handshakes
 * (`initialize`, `tools/list`), notifications, or malformed bodies.
 */
export function deriveToolName(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined
  const envelope = body as Record<string, unknown>
  if (envelope.method !== 'tools/call') return undefined
  const params = envelope.params
  if (!params || typeof params !== 'object') return undefined
  const name = (params as Record<string, unknown>).name
  return typeof name === 'string' && name.length > 0 ? name : undefined
}
