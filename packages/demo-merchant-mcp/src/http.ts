import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { buildMerchantMcpServer } from './server.js'
import { verifyXPayment, buildPaymentRequired, PaymentError, type VerifiedPayment } from './x402.js'
import { PRODUCTS, type ProductId } from './products.js'
import type { Address } from 'viem'

export interface DemoMerchantServerOptions {
  merchantAddress: Address
  baseUrl: string
  path?: string
}

const MAX_BODY_BYTES = 500_000

/**
 * Create the demo merchant MCP HTTP server.
 *
 * x402 payment wall is enforced at the HTTP layer for buy_vpn and
 * buy_cloud_storage tool calls. All other MCP methods (initialize,
 * tools/list, list_products) pass through freely.
 */
export function createDemoMerchantServer(options: DemoMerchantServerOptions): Server {
  const path = options.path ?? '/mcp'

  return createServer((req, res) => {
    handle(req, res, { ...options, path }).catch((err) => {
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
  options: Required<Pick<DemoMerchantServerOptions, 'path'>> & DemoMerchantServerOptions,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')

  applyCorsHeaders(res)
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/healthz') {
    writeJson(res, 200, { status: 'ok', merchant: options.merchantAddress })
    return
  }

  if (url.pathname !== options.path) {
    writeJson(res, 404, jsonRpcError(-32601, 'Not found'))
    return
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS')
    writeJson(res, 405, jsonRpcError(-32000, 'Method not allowed'))
    return
  }

  let body: unknown
  try {
    body = await readJsonBody(req)
  } catch (err) {
    writeJson(res, 400, jsonRpcError(-32700, err instanceof Error ? err.message : 'Invalid JSON'))
    return
  }

  // ── x402 payment gate ──────────────────────────────────────────────────────
  // Declared here so it's in scope for buildMerchantMcpServer below.
  let preVerifiedPayment: (VerifiedPayment & { productId: ProductId }) | undefined

  const paymentToolInfo = extractPaymentToolInfo(body)
  if (paymentToolInfo) {
    const { productId, product } = paymentToolInfo
    const xPayment = req.headers['x-payment'] as string | undefined

    if (!xPayment) {
      // Return HTTP 402 with payment requirements
      const requirements = buildPaymentRequired({
        merchantAddress: options.merchantAddress,
        amountUsdc: product.price_usdc,
        resource: `${options.baseUrl}${options.path}`,
        description: `${product.name} — 1 månads abonnemang`,
      })
      res.writeHead(402, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(requirements))
      return
    }

    // Verify payment before passing to MCP layer. The result is forwarded to
    // buildMerchantMcpServer so tool handlers can skip their own verification
    // (nonce is consumed here; a second verifyXPayment call would fail as replay).
    try {
      const verified = await verifyXPayment(xPayment, options.merchantAddress, product.price_usdc)
      preVerifiedPayment = { ...verified, productId }
    } catch (err) {
      const msg = err instanceof PaymentError ? err.message : 'Betalningsfel'
      res.writeHead(402, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          ...buildPaymentRequired({
            merchantAddress: options.merchantAddress,
            amountUsdc: product.price_usdc,
            resource: `${options.baseUrl}${options.path}`,
            description: `${product.name} — 1 månads abonnemang`,
          }),
          error: msg,
        }),
      )
      return
    }
  }

  // ── MCP dispatch ───────────────────────────────────────────────────────────
  const server = buildMerchantMcpServer({
    merchantAddress: options.merchantAddress,
    baseUrl: options.baseUrl,
    preVerifiedPayment,
  })
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })

  res.on('close', () => {
    void transport.close()
    void server.close()
  })

  await server.connect(transport)
  await transport.handleRequest(req, res, body)
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * If the JSON-RPC body is a tools/call for a payment-gated tool, return the
 * productId and product config. Otherwise return null.
 */
function extractPaymentToolInfo(
  body: unknown,
): { productId: ProductId; product: (typeof PRODUCTS)[ProductId] } | null {
  if (!body || typeof body !== 'object') return null
  const rpc = body as Record<string, unknown>
  if (rpc.method !== 'tools/call') return null

  const params = rpc.params as Record<string, unknown> | undefined
  if (!params || typeof params.name !== 'string') return null

  const toolName = params.name
  const args = (params.arguments as Record<string, unknown> | undefined) ?? {}

  let productId: ProductId | null = null

  if (toolName === 'buy_vpn') {
    const plan = args.plan as string | undefined
    if (plan === 'basic' || plan === 'pro' || plan === 'ultra') {
      productId = `vpn_${plan}` as ProductId
    }
  } else if (toolName === 'buy_cloud_storage') {
    const tier = args.tier as string | undefined
    if (tier === '50gb' || tier === '200gb' || tier === '1tb') {
      productId = `storage_${tier}` as ProductId
    }
  }

  if (!productId) return null
  return { productId, product: PRODUCTS[productId] }
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
      if (!raw) { resolve(undefined); return }
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
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function applyCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, MCP-Protocol-Version, X-Payment')
  res.setHeader('Access-Control-Max-Age', '86400')
}
