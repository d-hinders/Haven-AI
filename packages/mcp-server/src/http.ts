import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { extractBearerToken } from './auth.js'
import { buildHostedMcpServer, createHostedHavenClient } from './server.js'
import { defaultAccessLogWriter, deriveToolName, type AccessLogWriter } from './log.js'

export interface HostedHttpServerOptions {
  /** Haven backend base URL the server relays through. */
  baseUrl?: string
  /** Path the MCP endpoint is served on. Default `/v1`. */
  path?: string
  /**
   * Structured per-request access log sink. Defaults to one JSON line per
   * request on stdout. Never receives the Authorization header, the api key,
   * or any request/response body — only metadata.
   */
  logger?: AccessLogWriter
}

const MAX_BODY_BYTES = 1_000_000

/**
 * Create the hosted MCP HTTP server.
 *
 * Stateless and multi-tenant: each POST is handled by a freshly built MCP
 * server bound to a keyless `HavenClient` for *that request's* Bearer token,
 * then torn down. There is no shared session state and no ambient credential,
 * so two agents' requests can never see each other's identity or headers.
 *
 * The Bearer token is the agent's identity only; it authorizes nothing without
 * an edge signature (see docs/architecture/06-hosted-mcp-connect-flow.md).
 */
export function createHostedHttpServer(options: HostedHttpServerOptions = {}): Server {
  const path = options.path ?? '/v1'
  const logger = options.logger ?? defaultAccessLogWriter

  return createServer((req, res) => {
    const start = Date.now()
    const method = req.method ?? 'GET'
    const reqPath = new URL(req.url ?? '/', 'http://localhost').pathname
    let tool: string | undefined

    // Emit one structured access-log line per request once the response is
    // fully flushed. Never carries body content or the Authorization header.
    res.on('finish', () => {
      logger({
        ts: new Date().toISOString(),
        method,
        path: reqPath,
        status: res.statusCode,
        ms: Date.now() - start,
        tool,
      })
    })

    handle(req, res, { ...options, path }, (name) => {
      tool = name
    }).catch((err) => {
      writeJson(res, 500, {
        jsonrpc: '2.0',
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        id: null,
      })
    })
  })
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  options: Required<Pick<HostedHttpServerOptions, 'path'>> & HostedHttpServerOptions,
  setTool: (name: string | undefined) => void,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')

  // Lightweight liveness probe for infra (#186) — no auth, no MCP.
  // Accept HEAD so uptime monitors and CDN preflights see 200, not 404. Node's
  // http server suppresses the body on HEAD responses automatically.
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/healthz') {
    writeJson(res, 200, { status: 'ok' })
    return
  }

  if (url.pathname !== options.path) {
    writeJson(res, 404, jsonRpcError(-32601, 'Not found'))
    return
  }

  // Stateless transport: only POST carries JSON-RPC. GET/DELETE (used for SSE
  // streams and session teardown in stateful mode) are not supported here.
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    writeJson(res, 405, jsonRpcError(-32000, 'Method not allowed; this endpoint is stateless and accepts POST only.'))
    return
  }

  const token = extractBearerToken(req)
  if (!token) {
    res.setHeader('WWW-Authenticate', 'Bearer')
    writeJson(res, 401, jsonRpcError(-32001, 'Missing or malformed Authorization: Bearer <agent api key> header.'))
    return
  }

  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (err) {
    writeJson(res, 400, jsonRpcError(-32700, err instanceof Error ? err.message : 'Invalid JSON body'))
    return
  }

  // Attribute the access-log line to the MCP tool, when this is a tools/call.
  // Pure metadata derived from the JSON-RPC envelope — no body content leaks.
  setTool(deriveToolName(body))

  const haven = createHostedHavenClient({ apiKey: token, baseUrl: options.baseUrl })
  const server = buildHostedMcpServer(haven)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })

  // Tear down per-request resources once the response is done.
  res.on('close', () => {
    void transport.close()
    void server.close()
  })

  await server.connect(transport)
  await transport.handleRequest(req, res, body)
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('Request body is not valid JSON'))
      }
    })
    req.on('error', reject)
  })
}

function jsonRpcError(code: number, message: string) {
  return { jsonrpc: '2.0' as const, error: { code, message }, id: null }
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) return
  const text = JSON.stringify(payload)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(text)
}
